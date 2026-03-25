/**
 * Main Agent class.
 *
 * Manages the agent lifecycle:
 * - Polls server for config changes
 * - Generates rclone config from provider settings
 * - Runs rclone sync operations per project (push, pull, bisync)
 * - Watches files for changes and triggers sync (chokidar)
 * - Schedules periodic syncs (node-cron)
 * - Detects and reports bisync conflicts
 * - Archives and restores projects
 * - Reports results back to server
 * - Handles graceful shutdown (watchers, schedulers, active syncs)
 */

import { stat } from 'node:fs/promises';
import { hostname, type, release } from 'node:os';
import type { Logger } from 'pino';
import { ServerClient } from './lib/server-client.js';
import {
  ensureAgentDir,
  readAgentSettings,
  writeAgentSettings,
  readCachedConfig,
  writeCachedConfig,
} from './lib/config.js';
import {
  isAgentPluginMode,
  createMtlsAgent,
  validateMtlsConfig,
  type PluginModeSettings,
} from './lib/plugin-mode.js';
import {
  writeRcloneConfig,
  getRcloneConfigPath,
  getProjectRemoteName,
  buildCryptRemoteMap,
} from './lib/rclone-config.js';
import { runRcloneSync, runRcloneBisync, generateOperationId } from './lib/rclone-runner.js';
import { cleanupProjectTrash } from './lib/trash-cleanup.js';
import { runArchive, runRestore, type ArchiveResult, type RestoreResult } from './lib/archive.js';
import { readStub } from './lib/stub.js';
import { getBisyncState, updateBisyncState } from './lib/bisync-state.js';
import { FileWatcher } from './lib/file-watcher.js';
import { Scheduler } from './lib/scheduler.js';
import type {
  AgentConfig,
  AgentSettings,
  ProjectDefinition,
  SyncDirection,
  SyncResult,
} from './lib/types.js';

/** Tracks an active sync operation. */
interface ActiveSync {
  readonly operationId: string;
  readonly projectId: string;
  readonly abortController: AbortController;
  readonly startedAt: number;
  readonly trigger: 'manual' | 'watch' | 'schedule';
}

export interface AgentOptions {
  /** Override the agent directory (defaults to ~/.sync-agent/). */
  readonly agentDir: string;
  readonly logger: Logger;
}

export class Agent {
  private readonly agentDir: string;
  private readonly logger: Logger;

  private settings: AgentSettings | null = null;
  private serverClient: ServerClient | null = null;
  private currentConfig: AgentConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private agentId: string | null = null;
  private running = false;

  /** Active sync operations keyed by project ID. */
  private readonly activeSyncs = new Map<string, ActiveSync>();

  /** File watchers keyed by project ID. */
  private readonly fileWatchers = new Map<string, FileWatcher>();

  /** Mapping from encryption passwords to crypt remote names. */
  private cryptRemoteMap = new Map<string, string>();

  /** Cron scheduler for periodic syncs. */
  private scheduler: Scheduler | null = null;

  /**
   * Projects that need a sync queued because one was already in progress
   * when the trigger fired. Maps project ID to the trigger type.
   */
  private readonly pendingSyncs = new Map<string, 'watch' | 'schedule'>();

  /** Timer for periodic trash cleanup. */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentOptions) {
    this.agentDir = options.agentDir;
    this.logger = options.logger.child({ component: 'agent' });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the agent.
   * Initializes the agent directory, loads settings, and begins polling.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Agent is already running');
      return;
    }

    this.running = true;
    this.logger.info({ agentDir: this.agentDir }, 'Starting sync agent');

    // Ensure agent directory exists with proper permissions
    await ensureAgentDir(this.agentDir);

    // Load agent settings (file or env vars)
    this.settings = await readAgentSettings(this.agentDir, this.logger);
    this.logger.info({ serverUrl: this.settings.serverUrl }, 'Agent settings loaded');

    // Check for plugin mode (mTLS authentication via Portlama)
    const pluginSettings = this.settings as PluginModeSettings;
    const pluginMode = isAgentPluginMode(pluginSettings);

    if (pluginMode && pluginSettings.mtls) {
      this.logger.info('Agent running in Portlama plugin mode (mTLS)');
      // validateMtlsConfig reads cert files and returns their contents,
      // so createMtlsAgent does not need to read them again.
      const certContents = await validateMtlsConfig(pluginSettings.mtls, this.logger);
      const httpsAgent = createMtlsAgent(certContents, this.logger);
      this.serverClient = new ServerClient({
        serverUrl: this.settings.serverUrl,
        apiKey: this.settings.apiKey,
        logger: this.logger,
        httpsAgent,
      });
    } else {
      if (pluginMode) {
        this.logger.warn(
          'Plugin mode detected but no mTLS config found, falling back to API key auth',
        );
      }
      // Create server client (standalone mode with API key auth)
      this.serverClient = new ServerClient({
        serverUrl: this.settings.serverUrl,
        apiKey: this.settings.apiKey,
        logger: this.logger,
      });
    }

    // Initialize scheduler
    this.scheduler = new Scheduler({
      logger: this.logger,
      onScheduledSync: (projectId: string) => {
        void this.handleScheduledSync(projectId);
      },
    });

    // Register with the server (or restore persisted agent ID)
    await this.registerWithServer();

    // Try to fetch fresh config from the server first.
    // Only fall back to cached config if the server is unreachable.
    let freshConfigApplied = false;
    try {
      await this.pollConfig();
      freshConfigApplied = this.currentConfig !== null;
    } catch {
      // pollConfig handles errors internally, but just in case
    }

    if (!freshConfigApplied) {
      const cachedConfig = await readCachedConfig(this.agentDir, this.logger);
      if (cachedConfig) {
        this.logger.info('Server unreachable, applying cached config from disk');
        this.currentConfig = cachedConfig;
        await this.applyConfig(cachedConfig);
      }
    }

    // Start polling timer
    this.pollTimer = setInterval(() => void this.pollConfig(), this.settings.pollIntervalMs);

    // Start heartbeat timer (every 15 seconds)
    const heartbeatIntervalMs = 15_000;
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), heartbeatIntervalMs);

    this.logger.info(
      {
        pollIntervalMs: this.settings.pollIntervalMs,
        heartbeatIntervalMs,
        agentId: this.agentId,
      },
      'Agent started, polling for config changes',
    );
  }

  /**
   * Stop the agent gracefully.
   * Stops all watchers, schedulers, cancels active syncs, and stops polling.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.logger.info('Stopping sync agent');
    this.running = false;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop trash cleanup timer
    if (this.trashCleanupTimer) {
      clearInterval(this.trashCleanupTimer);
      this.trashCleanupTimer = null;
    }

    // Stop all file watchers
    await this.stopAllWatchers();

    // Stop all scheduled jobs
    if (this.scheduler) {
      this.scheduler.stopAll();
      this.scheduler = null;
    }

    // Clear pending syncs
    this.pendingSyncs.clear();

    // Cancel all active sync operations
    for (const [projectId, activeSync] of this.activeSyncs) {
      this.logger.info(
        { projectId, operationId: activeSync.operationId },
        'Cancelling active sync on shutdown',
      );
      activeSync.abortController.abort();
    }

    // Wait briefly for cancellations to complete
    if (this.activeSyncs.size > 0) {
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.activeSyncs.size === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        // Don't wait forever
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 5_000);
      });
    }

    this.logger.info('Sync agent stopped');
  }

  // ---------------------------------------------------------------------------
  // Public: Sync triggers
  // ---------------------------------------------------------------------------

  /**
   * Validate that a local path exists, is a directory, and is owned by the
   * current user. Returns true if valid, false otherwise (with a warning log).
   */
  private async validateLocalPath(localPath: string): Promise<boolean> {
    try {
      const st = await stat(localPath);
      if (!st.isDirectory()) {
        this.logger.warn({ localPath }, 'localPath is not a directory, skipping');
        return false;
      }
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && st.uid !== currentUid) {
        this.logger.warn(
          { localPath, uid: st.uid, expected: currentUid },
          'localPath not owned by current user, skipping',
        );
        return false;
      }
      return true;
    } catch {
      this.logger.warn({ localPath }, 'localPath does not exist or is not accessible, skipping');
      return false;
    }
  }

  /**
   * Trigger a sync for a specific project.
   * Returns the operation ID, or null if a sync is already in progress.
   */
  async triggerSync(
    projectId: string,
    direction?: SyncDirection,
    trigger: 'manual' | 'watch' | 'schedule' = 'manual',
    pendingOperationId?: string,
  ): Promise<string | null> {
    if (!this.currentConfig) {
      this.logger.warn('Cannot trigger sync: no config loaded');
      return null;
    }

    // Check if a sync is already active for this project
    if (this.activeSyncs.has(projectId)) {
      this.logger.info({ projectId, trigger }, 'Sync already in progress for project, skipping');
      return null;
    }

    const project = this.currentConfig.projects.find((p) => p.id === projectId);
    if (!project) {
      this.logger.warn({ projectId }, 'Project not found in config');
      return null;
    }

    // Validate local path before starting sync
    if (!(await this.validateLocalPath(project.localPath))) {
      return null;
    }

    const operationId = pendingOperationId ?? generateOperationId();
    const syncDirection = direction ?? project.direction;

    const abortController = new AbortController();
    const activeSync: ActiveSync = {
      operationId,
      projectId,
      abortController,
      startedAt: Date.now(),
      trigger,
    };
    this.activeSyncs.set(projectId, activeSync);

    // Determine which remote name to use (handles per-project encryption)
    const remoteName = getProjectRemoteName(
      project,
      this.currentConfig.provider,
      this.cryptRemoteMap,
    );

    // Resolve bandwidth limit: project override > global default
    const bandwidthLimit = project.bandwidthLimit ?? this.currentConfig.defaultBandwidthLimit;

    // Handle bidirectional sync via bisync
    if (syncDirection === 'bidirectional') {
      void this.executeBisyncOperation(
        {
          operationId,
          projectId,
          localPath: project.localPath,
          remotePath: project.remotePath,
          rcloneConfigPath: getRcloneConfigPath(this.agentDir),
          remoteName,
          bucket: this.currentConfig.provider.bucket,
          excludes: project.excludes,
          bandwidthLimit,
          resync: false, // Will be overridden by executeBisyncOperation based on state
          conflictStrategy: project.conflictStrategy ?? 'newest-wins',
          softDelete: project.softDelete,
          onProgress: (progress) => {
            this.logger.debug(
              { projectId, operationId, percentage: progress.percentage },
              'Bisync progress',
            );
          },
        },
        abortController.signal,
        trigger,
      );
    } else {
      // Push or pull sync
      void this.executeSyncOperation(
        {
          operationId,
          projectId,
          direction: syncDirection,
          localPath: project.localPath,
          remotePath: project.remotePath,
          rcloneConfigPath: getRcloneConfigPath(this.agentDir),
          remoteName,
          bucket: this.currentConfig.provider.bucket,
          excludes: project.excludes,
          bandwidthLimit,
          softDelete: project.softDelete,
          onProgress: (progress) => {
            this.logger.debug(
              { projectId, operationId, percentage: progress.percentage },
              'Sync progress',
            );
          },
        },
        abortController.signal,
        trigger,
      );
    }

    return operationId;
  }

  /**
   * Archive a project: move files to remote, write stub.
   * Returns the operation ID, or null if an operation is already in progress.
   */
  async triggerArchive(projectId: string, pendingOperationId?: string): Promise<string | null> {
    if (!this.currentConfig) {
      this.logger.warn('Cannot trigger archive: no config loaded');
      return null;
    }

    if (this.activeSyncs.has(projectId)) {
      this.logger.info({ projectId }, 'Operation already in progress for project, cannot archive');
      return null;
    }

    const project = this.currentConfig.projects.find((p) => p.id === projectId);
    if (!project) {
      this.logger.warn({ projectId }, 'Project not found in config');
      return null;
    }

    // Validate local path before starting archive
    if (!(await this.validateLocalPath(project.localPath))) {
      return null;
    }

    const operationId = pendingOperationId ?? generateOperationId();
    const abortController = new AbortController();
    const activeSync: ActiveSync = {
      operationId,
      projectId,
      abortController,
      startedAt: Date.now(),
      trigger: 'manual',
    };
    this.activeSyncs.set(projectId, activeSync);

    const remoteName = getProjectRemoteName(
      project,
      this.currentConfig.provider,
      this.cryptRemoteMap,
    );

    const bandwidthLimit = project.bandwidthLimit ?? this.currentConfig.defaultBandwidthLimit;

    // Run archive in background
    void this.executeArchiveOperation(
      {
        operationId,
        projectId,
        localPath: project.localPath,
        remotePath: project.remotePath,
        rcloneConfigPath: getRcloneConfigPath(this.agentDir),
        remoteName,
        bucket: this.currentConfig.provider.bucket,
        provider: this.currentConfig.provider.type,
        excludes: project.excludes,
        bandwidthLimit,
        softDelete: project.softDelete,
        onProgress: (progress) => {
          this.logger.debug(
            { projectId, operationId, percentage: progress.percentage },
            'Archive progress',
          );
        },
      },
      abortController.signal,
    );

    return operationId;
  }

  /**
   * Restore an archived project: copy files from remote, remove stub.
   * Returns the operation ID, or null if an operation is already in progress.
   * Pass singleFilePath to restore only one file.
   */
  async triggerRestore(projectId: string, pendingOperationId?: string, singleFilePath?: string): Promise<string | null> {
    if (!this.currentConfig) {
      this.logger.warn('Cannot trigger restore: no config loaded');
      return null;
    }

    if (this.activeSyncs.has(projectId)) {
      this.logger.info({ projectId }, 'Operation already in progress for project, cannot restore');
      return null;
    }

    const project = this.currentConfig.projects.find((p) => p.id === projectId);
    if (!project) {
      this.logger.warn({ projectId }, 'Project not found in config');
      return null;
    }

    // Defense in depth: validate singleFilePath before passing to rclone
    if (singleFilePath) {
      if (singleFilePath.includes('\0') || singleFilePath.split('/').includes('..')) {
        throw new Error('Invalid file path for restore');
      }
      if (/[*?[{\]\\}]/.test(singleFilePath)) {
        throw new Error('File path must not contain glob metacharacters (*, ?, [, ], {, }, \\)');
      }
    }

    // Verify that a stub file exists
    const stub = await readStub(project.localPath);
    if (!stub) {
      this.logger.warn({ projectId }, 'No stub file found — project may not be archived');
      return null;
    }

    const operationId = pendingOperationId ?? generateOperationId();
    const abortController = new AbortController();
    const activeSync: ActiveSync = {
      operationId,
      projectId,
      abortController,
      startedAt: Date.now(),
      trigger: 'manual',
    };
    this.activeSyncs.set(projectId, activeSync);

    const remoteName = getProjectRemoteName(
      project,
      this.currentConfig.provider,
      this.cryptRemoteMap,
    );

    const bandwidthLimit = project.bandwidthLimit ?? this.currentConfig.defaultBandwidthLimit;

    // Run restore in background, passing the pre-loaded stub to avoid re-reading
    void this.executeRestoreOperation(
      {
        operationId,
        projectId,
        localPath: project.localPath,
        rcloneConfigPath: getRcloneConfigPath(this.agentDir),
        remoteName,
        bucket: this.currentConfig.provider.bucket,
        bandwidthLimit,
        singleFilePath,
        preloadedStub: stub,
        expectedBucket: this.currentConfig.provider.bucket,
        expectedRemotePath: project.remotePath,
        onProgress: (progress) => {
          this.logger.debug(
            { projectId, operationId, percentage: progress.percentage },
            'Restore progress',
          );
        },
      },
      abortController.signal,
    );

    return operationId;
  }

  // ---------------------------------------------------------------------------
  // Public: State queries
  // ---------------------------------------------------------------------------

  /**
   * Get the list of currently active sync operations.
   */
  getActiveSyncs(): ReadonlyMap<string, ActiveSync> {
    return this.activeSyncs;
  }

  /**
   * Check whether the agent is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Private: Registration and heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Register this agent with the server.
   *
   * If an agent ID is already persisted in settings, it is restored.
   * Otherwise, the agent registers with the server and persists the assigned ID.
   */
  private async registerWithServer(): Promise<void> {
    if (!this.serverClient || !this.settings) return;

    // Restore persisted agent ID if available
    if (this.settings.agentId) {
      this.agentId = this.settings.agentId;
      this.logger.info({ agentId: this.agentId }, 'Restored persisted agent ID');
    }

    try {
      const agentName = this.settings.agentName ?? `${hostname()}-sync-agent`;

      const response = await this.serverClient.register({
        name: agentName,
        hostname: hostname(),
        os: type(),
        osVersion: release(),
        nodeVersion: process.version,
        agentVersion: '0.1.0',
      });

      this.agentId = response.agent.id;

      // Persist agent ID and agent token if they changed
      const newToken = response.agentToken;
      if (
        this.settings.agentId !== this.agentId ||
        (newToken && this.settings.agentToken !== newToken)
      ) {
        const updatedSettings = {
          ...this.settings,
          agentId: this.agentId,
          ...(newToken ? { agentToken: newToken } : {}),
        };
        await writeAgentSettings(this.agentDir, updatedSettings);
        this.settings = updatedSettings;
        this.logger.info({ agentId: this.agentId }, 'Agent ID and token persisted to settings');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to register with server, will retry on next heartbeat',
      );
    }
  }

  /**
   * Send a heartbeat to the server with current agent status.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.serverClient || !this.agentId) {
      // If not registered yet, try registration first
      if (this.serverClient && !this.agentId) {
        await this.registerWithServer();
      }
      return;
    }

    try {
      const activeSyncsList: Array<{
        projectId: string;
        operationId: string;
        startedAt: string;
      }> = [];

      for (const [, sync] of this.activeSyncs) {
        activeSyncsList.push({
          projectId: sync.projectId,
          operationId: sync.operationId,
          startedAt: new Date(sync.startedAt).toISOString(),
        });
      }

      await this.serverClient.heartbeat(
        this.agentId,
        { activeSyncs: activeSyncsList },
        this.settings?.agentToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to send heartbeat',
      );
      // If agent not found (404), re-register
      if (error instanceof Error && error.message.includes('404')) {
        this.agentId = null;
        await this.registerWithServer();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Config management
  // ---------------------------------------------------------------------------

  /**
   * Poll the server for config changes.
   */
  private async pollConfig(): Promise<void> {
    if (!this.serverClient) return;

    try {
      const newConfig = await this.serverClient.fetchConfig();
      const configChanged = !configsEqual(this.currentConfig, newConfig);

      if (configChanged) {
        this.logger.info('Server config changed, applying new config');
        this.currentConfig = newConfig;
        await writeCachedConfig(this.agentDir, newConfig);
        await this.applyConfig(newConfig);
      } else {
        this.logger.debug('Server config unchanged');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to poll server for config',
      );
      // Continue with cached config if available
    }
  }

  /**
   * Apply a new config — regenerate rclone.conf, update watchers and schedules.
   */
  private async applyConfig(config: AgentConfig): Promise<void> {
    // Build the crypt remote map for per-project encryption passwords
    this.cryptRemoteMap = buildCryptRemoteMap(config.projects, config.provider);

    // Generate/update rclone.conf
    await writeRcloneConfig(this.agentDir, config.provider, config.projects, this.logger);

    // Reconcile file watchers with new project list
    await this.reconcileWatchers(config.projects);

    // Reconcile cron schedules with new project list
    this.reconcileSchedules(config.projects);

    // Reconcile trash cleanup with new config
    this.reconcileTrashCleanup(config);

    // Detect server-initiated operations: projects with status "syncing"
    // that the agent isn't already running an operation for.
    for (const project of config.projects) {
      if (project.status === 'syncing' && !this.activeSyncs.has(project.id)) {
        const opType = project.pendingType ?? 'sync';
        this.logger.info(
          { projectId: project.id, pendingOperationId: project.pendingOperationId, pendingDirection: project.pendingDirection, pendingType: opType },
          'Detected server-initiated operation, triggering',
        );
        if (opType === 'archive') {
          void this.triggerArchive(project.id, project.pendingOperationId);
        } else if (opType === 'restore') {
          void this.triggerRestore(project.id, project.pendingOperationId);
        } else {
          void this.triggerSync(project.id, project.pendingDirection, 'manual', project.pendingOperationId);
        }
      }
    }

    this.logger.info({ projectCount: config.projects.length }, 'Config applied successfully');
  }

  // ---------------------------------------------------------------------------
  // Private: File watcher management
  // ---------------------------------------------------------------------------

  /**
   * Reconcile file watchers with the current project configuration.
   * Starts watchers for projects that need them, stops watchers for
   * projects that no longer need them.
   */
  private async reconcileWatchers(projects: readonly ProjectDefinition[]): Promise<void> {
    const projectsNeedingWatch = new Set<string>();

    for (const project of projects) {
      if (this.projectNeedsWatcher(project)) {
        projectsNeedingWatch.add(project.id);
      }
    }

    // Stop watchers for projects that no longer need watching
    for (const [projectId, watcher] of this.fileWatchers) {
      if (!projectsNeedingWatch.has(projectId)) {
        this.logger.info({ projectId }, 'Stopping file watcher (no longer needed)');
        await watcher.stop();
        this.fileWatchers.delete(projectId);
      }
    }

    // Start watchers for projects that need them and don't have one
    for (const project of projects) {
      if (projectsNeedingWatch.has(project.id) && !this.fileWatchers.has(project.id)) {
        this.startWatcher(project);
      }
    }
  }

  /**
   * Determine whether a project needs a file watcher.
   */
  private projectNeedsWatcher(project: ProjectDefinition): boolean {
    // Explicit watch flag
    if (project.watch) return true;

    // Trigger mode includes watch
    const trigger = project.trigger;
    if (trigger === 'watch' || trigger === 'watch+schedule') return true;

    return false;
  }

  /**
   * Start a file watcher for a project.
   */
  private startWatcher(project: ProjectDefinition): void {
    this.logger.info(
      { projectId: project.id, localPath: project.localPath },
      'Starting file watcher for project',
    );

    const watcher = new FileWatcher({
      projectId: project.id,
      localPath: project.localPath,
      excludes: project.excludes,
      debounceMs: project.watchDebounceMs,
      onChanges: (projectId: string, changedFiles: readonly string[]) => {
        this.handleWatchTrigger(projectId, changedFiles);
      },
      logger: this.logger,
    });

    watcher.start();
    this.fileWatchers.set(project.id, watcher);
  }

  /**
   * Stop all file watchers.
   */
  private async stopAllWatchers(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [projectId, watcher] of this.fileWatchers) {
      this.logger.debug({ projectId }, 'Stopping file watcher');
      stopPromises.push(watcher.stop());
    }
    await Promise.all(stopPromises);
    this.fileWatchers.clear();
  }

  /**
   * Handle a file change trigger from chokidar.
   * If sync is already in progress, queue the next sync.
   */
  private handleWatchTrigger(projectId: string, changedFiles: readonly string[]): void {
    this.logger.info(
      {
        projectId,
        fileCount: changedFiles.length,
        files: changedFiles.slice(0, 10),
      },
      'File changes detected, triggering sync',
    );

    // If sync already in progress, queue for later
    if (this.activeSyncs.has(projectId)) {
      this.logger.info({ projectId }, 'Sync already in progress, queuing watch-triggered sync');
      this.pendingSyncs.set(projectId, 'watch');
      return;
    }

    void this.triggerSync(projectId, undefined, 'watch');
  }

  // ---------------------------------------------------------------------------
  // Private: Trash cleanup management
  // ---------------------------------------------------------------------------

  /**
   * Reconcile the trash cleanup timer based on the current config.
   * Runs every hour to check and clean expired trash directories.
   */
  private reconcileTrashCleanup(config: AgentConfig): void {
    // Stop existing timer
    if (this.trashCleanupTimer) {
      clearInterval(this.trashCleanupTimer);
      this.trashCleanupTimer = null;
    }

    // Start cleanup if global or any per-project soft delete is enabled
    const globalSoftDelete = config.softDelete;
    const anyProjectEnabled = config.projects.some((p) => p.softDelete?.enabled);
    if (!globalSoftDelete?.enabled && !anyProjectEnabled) return;

    // Run trash cleanup every hour (the cron schedule is informational;
    // we use a simple interval for the agent-side cleanup)
    const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour

    this.trashCleanupTimer = setInterval(() => {
      void this.runTrashCleanup();
    }, CLEANUP_INTERVAL_MS);

    this.logger.info(
      { retentionDays: globalSoftDelete?.retentionDays ?? 'per-project' },
      'Trash cleanup timer started (every 1h)',
    );
  }

  /**
   * Run trash cleanup for all projects.
   */
  private async runTrashCleanup(): Promise<void> {
    if (!this.currentConfig) return;

    for (const project of this.currentConfig.projects) {
      const softDelete = project.softDelete ?? this.currentConfig.softDelete;
      if (!softDelete?.enabled) continue;

      try {
        await cleanupProjectTrash(
          {
            projectId: project.id,
            agentDir: this.agentDir,
            rcloneConfigPath: getRcloneConfigPath(this.agentDir),
            remoteName: getProjectRemoteName(
              project,
              this.currentConfig.provider,
              this.cryptRemoteMap,
            ),
            bucket: this.currentConfig.provider.bucket,
            retentionDays: softDelete.retentionDays,
          },
          this.logger,
        );
      } catch (err: unknown) {
        this.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            projectId: project.id,
          },
          'Trash cleanup failed for project',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Schedule management
  // ---------------------------------------------------------------------------

  /**
   * Reconcile cron schedules with the current project configuration.
   */
  private reconcileSchedules(projects: readonly ProjectDefinition[]): void {
    if (!this.scheduler) return;

    const projectsNeedingSchedule = new Map<string, string>();

    for (const project of projects) {
      if (this.projectNeedsSchedule(project) && project.schedule) {
        projectsNeedingSchedule.set(project.id, project.schedule);
      }
    }

    // Unschedule projects that no longer need scheduling
    for (const projectId of this.scheduler.getScheduledProjects()) {
      if (!projectsNeedingSchedule.has(projectId)) {
        this.scheduler.unschedule(projectId);
      }
    }

    // Schedule or update projects that need it
    for (const [projectId, cronExpr] of projectsNeedingSchedule) {
      const currentCron = this.scheduler.getCronExpression(projectId);
      if (currentCron !== cronExpr) {
        this.scheduler.schedule(projectId, cronExpr);
      }
    }
  }

  /**
   * Determine whether a project needs cron scheduling.
   */
  private projectNeedsSchedule(project: ProjectDefinition): boolean {
    if (!project.schedule) return false;

    const trigger = project.trigger;

    // Explicit schedule or combined trigger
    if (trigger === 'schedule' || trigger === 'watch+schedule') return true;

    return false;
  }

  /**
   * Handle a scheduled sync trigger from node-cron.
   */
  private async handleScheduledSync(projectId: string): Promise<void> {
    if (!this.running) return;

    // If sync already in progress, queue for later
    if (this.activeSyncs.has(projectId)) {
      this.logger.info({ projectId }, 'Sync already in progress, queuing scheduled sync');
      this.pendingSyncs.set(projectId, 'schedule');
      return;
    }

    await this.triggerSync(projectId, undefined, 'schedule');
  }

  // ---------------------------------------------------------------------------
  // Private: Sync execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a push/pull sync operation and report the result.
   */
  private async executeSyncOperation(
    options: Parameters<typeof runRcloneSync>[0],
    abortSignal: AbortSignal,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<void> {
    let result: SyncResult;

    try {
      result = await runRcloneSync(options, this.logger, abortSignal, this.agentDir);
    } catch (error: unknown) {
      result = {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: options.direction,
        status: 'error',
        filesTransferred: 0,
        bytesTransferred: 0,
        durationMs: Date.now() - (this.activeSyncs.get(options.projectId)?.startedAt ?? Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeSyncs.delete(options.projectId);
    }

    await this.reportSyncResult(result, trigger);
    this.processPendingSync(options.projectId);
  }

  /**
   * Execute a bisync operation and report the result.
   * Automatically determines whether --resync is needed based on persisted state.
   */
  private async executeBisyncOperation(
    options: Parameters<typeof runRcloneBisync>[0],
    abortSignal: AbortSignal,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<void> {
    // Check bisync state to determine if --resync is needed.
    // getBisyncState returns both the project state and the full state file,
    // so we can pass the state file to updateBisyncState to avoid re-reading.
    const { state: bisyncState } = await getBisyncState(
      this.agentDir,
      options.projectId,
      this.logger,
    );

    const effectiveOptions = {
      ...options,
      resync: !bisyncState.baselineEstablished,
    };

    let result: SyncResult;

    try {
      result = await runRcloneBisync(effectiveOptions, this.logger, abortSignal, this.agentDir);
    } catch (error: unknown) {
      result = {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: 'bidirectional' as const,
        status: 'error',
        filesTransferred: 0,
        bytesTransferred: 0,
        durationMs: Date.now() - (this.activeSyncs.get(options.projectId)?.startedAt ?? Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeSyncs.delete(options.projectId);
    }

    // Update bisync state on success.
    // Re-read state from disk (do NOT use the pre-loaded bisyncStateFile)
    // because the sync may have taken minutes and another project's bisync
    // could have updated the file in the meantime.
    if (result.status === 'completed') {
      await updateBisyncState(
        this.agentDir,
        options.projectId,
        {
          baselineEstablished: true,
          lastBisync: new Date().toISOString(),
          conflicts: result.conflicts ?? [],
        },
        this.logger,
      );
    }

    await this.reportSyncResult(result, trigger);
    this.processPendingSync(options.projectId);
  }

  /**
   * Execute an archive operation and report the result.
   */
  private async executeArchiveOperation(
    options: Parameters<typeof runArchive>[0],
    abortSignal: AbortSignal,
  ): Promise<void> {
    let result: ArchiveResult;

    try {
      result = await runArchive(options, this.logger, abortSignal);
    } catch (error: unknown) {
      result = {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'error',
        totalSize: 0,
        fileCount: 0,
        spaceFreed: 0,
        durationMs: Date.now() - (this.activeSyncs.get(options.projectId)?.startedAt ?? Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeSyncs.delete(options.projectId);
    }

    // Report result to server
    if (this.serverClient) {
      try {
        await this.serverClient.report({
          operationId: result.operationId,
          projectId: result.projectId,
          direction: 'push',
          status: result.status,
          filesTransferred: result.fileCount,
          bytesTransferred: result.totalSize,
          duration: result.durationMs,
          error: result.error,
          type: 'archive',
          spaceFreed: result.spaceFreed,
          totalSize: result.totalSize,
          fileCount: result.fileCount,
        });
      } catch (reportError: unknown) {
        this.logger.warn(
          {
            err: reportError instanceof Error ? reportError.message : String(reportError),
            operationId: result.operationId,
          },
          'Failed to report archive result to server',
        );
      }
    }
  }

  /**
   * Execute a restore operation and report the result.
   */
  private async executeRestoreOperation(
    options: Parameters<typeof runRestore>[0],
    abortSignal: AbortSignal,
  ): Promise<void> {
    let result: RestoreResult;

    try {
      result = await runRestore(options, this.logger, abortSignal);
    } catch (error: unknown) {
      result = {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'error',
        filesRestored: 0,
        bytesRestored: 0,
        durationMs: Date.now() - (this.activeSyncs.get(options.projectId)?.startedAt ?? Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeSyncs.delete(options.projectId);
    }

    // Report result to server
    if (this.serverClient) {
      try {
        await this.serverClient.report({
          operationId: result.operationId,
          projectId: result.projectId,
          direction: 'pull',
          status: result.status,
          filesTransferred: result.filesRestored,
          bytesTransferred: result.bytesRestored,
          duration: result.durationMs,
          error: result.error,
          type: 'restore',
        });
      } catch (reportError: unknown) {
        this.logger.warn(
          {
            err: reportError instanceof Error ? reportError.message : String(reportError),
            operationId: result.operationId,
          },
          'Failed to report restore result to server',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Reporting and pending sync processing
  // ---------------------------------------------------------------------------

  /**
   * Report a sync result to the server.
   */
  private async reportSyncResult(
    result: SyncResult,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<void> {
    if (!this.serverClient) return;

    try {
      await this.serverClient.report({
        operationId: result.operationId,
        projectId: result.projectId,
        direction: result.direction,
        status: result.status,
        filesTransferred: result.filesTransferred,
        bytesTransferred: result.bytesTransferred,
        duration: result.durationMs,
        error: result.error,
        conflicts: result.conflicts,
        trigger,
      });
    } catch (reportError: unknown) {
      this.logger.warn(
        {
          err: reportError instanceof Error ? reportError.message : String(reportError),
          operationId: result.operationId,
        },
        'Failed to report sync result to server',
      );
    }
  }

  /**
   * Process any queued sync for a project after its current sync completes.
   */
  private processPendingSync(projectId: string): void {
    const pendingTrigger = this.pendingSyncs.get(projectId);
    if (pendingTrigger) {
      this.pendingSyncs.delete(projectId);
      this.logger.info({ projectId, trigger: pendingTrigger }, 'Processing queued sync');
      void this.triggerSync(projectId, undefined, pendingTrigger);
    }
  }
}

/**
 * Simple deep equality check for configs.
 * Used to detect changes between polling intervals.
 */
function configsEqual(a: AgentConfig | null, b: AgentConfig | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
