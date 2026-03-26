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

import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import { hostname, type, release } from 'node:os';
import type { Logger } from 'pino';
import {
  readApprovedPaths,
  writeApprovedPaths,
  getLocalPath,
  hasApprovedPath,
  getUnmappedProjects,
  pruneStaleApprovals,
  getAccessMode,
  getConfirmMode,
  getDeleteThreshold,
  type ApprovedPathsFile,
  type AccessMode,
  type ProjectInfo,
} from '@lamalibre/sync-shared';
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
import { runRcloneSync, runRcloneBisync, runRcloneDryRun, runRcloneProtectedPull, generateOperationId, sanitizeRcloneError } from './lib/rclone-runner.js';
import {
  readPendingSync,
  removePendingSync,
  savePendingSync,
  cleanExpiredPendingSyncs,
  buildPendingSyncPreview,
  listPendingSyncs,
} from './lib/pending-sync.js';
import { parseDryRunOutput } from './lib/dry-run-parser.js';
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

  /** Persistent allowlist of approved (projectId, localPath) pairs. */
  private approvedPaths: ApprovedPathsFile = { version: 1, entries: [] };

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

    // Load path allowlist (must happen before any sync operations)
    this.approvedPaths = await readApprovedPaths(this.agentDir, (err) => this.logger.warn({ err: err.message }, 'Failed to read approved-paths.json'));

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
        // Don't wait forever — force-clear leaked entries on timeout
        setTimeout(() => {
          clearInterval(checkInterval);
          this.activeSyncs.clear();
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
   * Resolve the local path for a project from the approved-paths mapping.
   * Returns null if no mapping exists for this project.
   */
  private resolveLocalPath(projectId: string): string | null {
    return getLocalPath(this.approvedPaths, projectId);
  }

  /**
   * Resolve the effective sync direction after applying the access mode override.
   * Returns null if the access mode blocks the operation entirely.
   */
  private resolveEffectiveDirection(
    requestedDirection: SyncDirection,
    accessMode: AccessMode,
    projectId: string,
  ): SyncDirection | null {
    switch (accessMode) {
      case 'full':
        return requestedDirection;

      case 'push-only':
        if (requestedDirection === 'pull') {
          this.logger.info(
            { projectId, accessMode },
            'Access mode "push-only" blocks pull direction, skipping sync',
          );
          return null;
        }
        if (requestedDirection === 'bidirectional') {
          this.logger.info(
            { projectId, accessMode },
            'Access mode "push-only" overriding bidirectional to push',
          );
          return 'push';
        }
        return requestedDirection;

      case 'pull-only':
        if (requestedDirection === 'push') {
          this.logger.info(
            { projectId, accessMode },
            'Access mode "pull-only" blocks push direction, skipping sync',
          );
          return null;
        }
        if (requestedDirection === 'bidirectional') {
          this.logger.info(
            { projectId, accessMode },
            'Access mode "pull-only" overriding bidirectional to pull',
          );
          return 'pull';
        }
        return requestedDirection;

      case 'protected':
        // Protected mode uses rclone copy --ignore-existing (no overwrites, no deletes).
        // Handled separately via triggerProtectedPull; 'pull' is a sentinel value.
        if (requestedDirection !== 'pull') {
          this.logger.info(
            { projectId, accessMode, requestedDirection },
            'Access mode "protected" overriding direction to protected pull (copy --ignore-existing)',
          );
        }
        return 'pull';
    }
  }

  /**
   * Execute a protected pull (rclone copy --ignore-existing).
   * Downloads new files without overwriting or deleting existing local files.
   */
  private async triggerProtectedPull(
    project: ProjectDefinition,
    localPath: string,
    operationId: string,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<string | null> {
    if (!this.currentConfig) return null;

    const abortController = new AbortController();
    const activeSync: ActiveSync = {
      operationId,
      projectId: project.id,
      abortController,
      startedAt: Date.now(),
      trigger,
    };
    this.activeSyncs.set(project.id, activeSync);

    const remoteName = getProjectRemoteName(
      project,
      this.currentConfig.provider,
      this.cryptRemoteMap,
    );
    const bandwidthLimit = project.bandwidthLimit ?? this.currentConfig.defaultBandwidthLimit;

    void this.executeProtectedPullOperation(
      {
        operationId,
        projectId: project.id,
        localPath,
        remotePath: project.remotePath,
        rcloneConfigPath: getRcloneConfigPath(this.agentDir),
        remoteName,
        bucket: this.currentConfig.provider.bucket,
        includes: project.includes,
        excludes: project.excludes,
        bandwidthLimit,
        softDelete: project.softDelete,
        onProgress: (progress) => {
          this.logger.debug(
            { projectId: project.id, operationId, percentage: progress.percentage },
            'Protected pull progress',
          );
        },
      },
      abortController.signal,
      trigger,
    );

    return operationId;
  }

  /**
   * Check whether a sync needs a dry-run preview before execution.
   * Returns:
   *   'proceed'  — no preview needed, proceed with sync
   *   'waiting'  — preview was just created, waiting for approval
   *   'pending'  — a preview already exists and is waiting for approval
   */
  private async checkSyncPreview(
    project: ProjectDefinition,
    localPath: string,
    effectiveDirection: SyncDirection,
    operationId: string,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<'proceed' | 'waiting' | 'pending'> {
    if (!this.currentConfig) return 'proceed';

    const confirmMode = getConfirmMode(this.approvedPaths, project.id, project.direction);

    // Auto mode: no preview needed
    if (confirmMode === 'auto') {
      // Still check for an approved pending sync (from a previous confirm-mode change)
      const existing = await readPendingSync(this.agentDir, project.id);
      if (existing?.status === 'approved') {
        await removePendingSync(this.agentDir, project.id);
      }
      return 'proceed';
    }

    // Bidirectional (bisync) does not support dry-run preview because
    // bisync --dry-run produces a different output format than sync --dry-run,
    // and the dry-run parser cannot reliably extract changes from it.
    // Allow bisync operations to proceed without preview.
    if (effectiveDirection === 'bidirectional') {
      this.logger.warn(
        { projectId: project.id },
        'Sync preview is not supported for bidirectional syncs (bisync --dry-run output format differs). Proceeding without preview.',
      );
      return 'proceed';
    }

    // Check for existing pending sync
    const existing = await readPendingSync(this.agentDir, project.id);
    if (existing?.status === 'approved') {
      await removePendingSync(this.agentDir, project.id);
      return 'proceed';
    }
    if (existing?.status === 'pending') {
      this.logger.info(
        { projectId: project.id },
        'Pending sync preview awaiting approval, skipping sync',
      );
      return 'pending';
    }

    // Need to evaluate via dry-run
    try {
      const remoteName = getProjectRemoteName(
        project,
        this.currentConfig.provider,
        this.cryptRemoteMap,
      );

      const dryRunOutput = await runRcloneDryRun(
        {
          operationId,
          projectId: project.id,
          direction: effectiveDirection,
          localPath,
          remotePath: project.remotePath,
          rcloneConfigPath: getRcloneConfigPath(this.agentDir),
          remoteName,
          bucket: this.currentConfig.provider.bucket,
          includes: project.includes,
          excludes: project.excludes,
        },
        this.logger,
        this.agentDir,
      );

      const changes = parseDryRunOutput(dryRunOutput);
      const deleteCount = changes.filter((c) => c.action === 'delete').length;

      // Decide whether confirmation is needed
      const needsConfirmation =
        confirmMode === 'confirm-always' ||
        (confirmMode === 'confirm-destructive' && deleteCount > getDeleteThreshold(this.approvedPaths, project.id));

      if (!needsConfirmation) {
        return 'proceed';
      }

      // Save pending sync preview
      const preview = buildPendingSyncPreview(
        project.id,
        project.name,
        operationId,
        effectiveDirection,
        localPath,
        project.remotePath,
        trigger,
        changes,
      );
      await savePendingSync(this.agentDir, preview);

      this.logger.warn(
        {
          projectId: project.id,
          copyCount: preview.copyCount,
          deleteCount: preview.deleteCount,
        },
        'Sync requires confirmation. Run "sync preview" to review and approve.',
      );
      return 'waiting';
    } catch (err: unknown) {
      // When the user has opted into confirmation mode, a dry-run failure
      // must NOT silently proceed — that would bypass the safety contract.
      // Skip this sync cycle; the next poll will retry the dry-run.
      this.logger.error(
        { projectId: project.id, confirmMode, err: err instanceof Error ? err.message : String(err) },
        'Dry-run failed — skipping sync (confirm mode requires a successful preview before execution).',
      );
      return 'waiting';
    }
  }

  /**
   * Validate that a local path exists, is a directory, and is owned by the
   * current user. Returns true if valid, false otherwise (with a warning log).
   */
  private async validateLocalPath(localPath: string): Promise<boolean> {
    try {
      // lstat does not follow symlinks, so isDirectory() is only true for
      // real directories (not symlinks pointing to directories).
      const st = await lstat(localPath);
      if (st.isSymbolicLink()) {
        this.logger.warn({ localPath }, 'localPath is a symbolic link, skipping');
        return false;
      }
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
    skipPreview = false,
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

    // Resolve local path from approved-paths mapping
    const localPath = this.resolveLocalPath(projectId);
    if (!localPath) {
      this.logger.warn(
        { projectId, projectName: project.name },
        'No local path configured for project. Run "sync agent-approve" to set a local path.',
      );
      return null;
    }

    // Validate local path before starting sync
    if (!(await this.validateLocalPath(localPath))) {
      return null;
    }

    const operationId = pendingOperationId ?? generateOperationId();

    // --- Access mode enforcement ---
    const accessMode = getAccessMode(this.approvedPaths, projectId);
    const effectiveDirection = this.resolveEffectiveDirection(
      direction ?? project.direction,
      accessMode,
      projectId,
    );

    if (!effectiveDirection) {
      // Access mode blocks this direction entirely
      return null;
    }

    // --- Protected mode: use rclone copy --ignore-existing ---
    if (accessMode === 'protected') {
      return this.triggerProtectedPull(project, localPath, operationId, trigger);
    }

    // --- Sync preview / dry-run decision ---
    if (!skipPreview) {
      const previewResult = await this.checkSyncPreview(
        project, localPath, effectiveDirection, operationId, trigger,
      );
      if (previewResult === 'waiting') {
        return null; // Pending sync saved, waiting for approval
      }
      if (previewResult === 'pending') {
        return null; // Already a pending preview waiting
      }
      // previewResult === 'proceed' — continue with sync
    }

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
    if (effectiveDirection === 'bidirectional') {
      void this.executeBisyncOperation(
        {
          operationId,
          projectId,
          localPath,
          remotePath: project.remotePath,
          rcloneConfigPath: getRcloneConfigPath(this.agentDir),
          remoteName,
          bucket: this.currentConfig.provider.bucket,
          includes: project.includes,
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
          direction: effectiveDirection,
          localPath,
          remotePath: project.remotePath,
          rcloneConfigPath: getRcloneConfigPath(this.agentDir),
          remoteName,
          bucket: this.currentConfig.provider.bucket,
          includes: project.includes,
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

    // Resolve local path from approved-paths mapping
    const localPath = this.resolveLocalPath(projectId);
    if (!localPath) {
      this.logger.warn(
        { projectId, projectName: project.name },
        'No local path configured for project. Run "sync agent-approve" to set a local path.',
      );
      return null;
    }

    // Validate local path before starting archive
    if (!(await this.validateLocalPath(localPath))) {
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
        localPath,
        remotePath: project.remotePath,
        rcloneConfigPath: getRcloneConfigPath(this.agentDir),
        remoteName,
        bucket: this.currentConfig.provider.bucket,
        provider: this.currentConfig.provider.type,
        includes: project.includes,
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

    // Resolve local path from approved-paths mapping
    const localPath = this.resolveLocalPath(projectId);
    if (!localPath) {
      this.logger.warn(
        { projectId, projectName: project.name },
        'No local path configured for project. Run "sync agent-approve" to set a local path.',
      );
      return null;
    }

    // Defense in depth: validate singleFilePath before passing to rclone
    if (singleFilePath) {
      if (singleFilePath.length > 4096) {
        throw new Error('File path must be at most 4096 characters');
      }
      const normalizedFilePath = posix.normalize(singleFilePath);
      const segments = normalizedFilePath.split('/').filter(Boolean);
      if (singleFilePath.includes('\0') || segments.includes('..') || normalizedFilePath.startsWith('/')) {
        throw new Error('Invalid file path for restore');
      }
      if (/[*?\[{}\]\\]/.test(normalizedFilePath)) {
        throw new Error('File path must not contain glob metacharacters (*, ?, [, ], {, }, \\)');
      }
      // Use normalized form for rclone to prevent path interpretation differences
      singleFilePath = normalizedFilePath;
    }

    // Verify that a stub file exists
    const stub = await readStub(localPath);
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
        localPath,
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

    // Reload approved paths every poll so access/confirm mode changes are
    // picked up immediately, not only when the server config changes.
    try {
      this.approvedPaths = await readApprovedPaths(this.agentDir, (err) => this.logger.warn({ err: err.message }, 'Failed to read approved-paths.json'));
    } catch (err: unknown) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to reload approved paths',
      );
    }

    // Clean up expired/rejected pending syncs and process approved ones
    try {
      await cleanExpiredPendingSyncs(this.agentDir);
      await this.processApprovedPendingSyncs();
    } catch (err: unknown) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to process pending syncs',
      );
    }

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
   * Check for approved pending syncs and execute them.
   */
  private async processApprovedPendingSyncs(): Promise<void> {
    if (!this.currentConfig) return;

    const pendingSyncs = await listPendingSyncs(this.agentDir);

    for (const preview of pendingSyncs) {
      // Clean up expired syncs regardless of status
      if (new Date(preview.expiresAt).getTime() < Date.now()) {
        await removePendingSync(this.agentDir, preview.projectId);
        continue;
      }
      if (preview.status !== 'approved') continue;
      if (this.activeSyncs.has(preview.projectId)) continue;

      const project = this.currentConfig.projects.find((p) => p.id === preview.projectId);
      if (!project) {
        await removePendingSync(this.agentDir, preview.projectId);
        continue;
      }

      this.logger.info(
        { projectId: preview.projectId, operationId: preview.operationId },
        'Executing approved pending sync',
      );

      try {
        const opId = await this.triggerSync(project.id, preview.direction, preview.trigger, preview.operationId, true);
        if (opId) {
          await removePendingSync(this.agentDir, preview.projectId);
        } else {
          this.logger.warn(
            { projectId: preview.projectId },
            'Approved sync could not start (blocked by access mode, missing path, or active sync). Pending sync preserved for retry.',
          );
        }
      } catch (err: unknown) {
        this.logger.error({ projectId: preview.projectId, err: err instanceof Error ? err.message : String(err) }, 'Failed to execute approved sync');
      }
    }
  }

  /**
   * Apply a new config — regenerate rclone.conf, update watchers and schedules.
   */
  private async applyConfig(config: AgentConfig): Promise<void> {
    // Reload approved paths (may have been updated by CLI since last poll)
    this.approvedPaths = await readApprovedPaths(this.agentDir, (err) => this.logger.warn({ err: err.message }, 'Failed to read approved-paths.json'));

    // Log warnings for projects without local path mappings
    const projectInfos: readonly ProjectInfo[] = config.projects.map((p) => ({ id: p.id, name: p.name }));
    const unmapped = getUnmappedProjects(this.approvedPaths, projectInfos);
    for (const project of unmapped) {
      this.logger.warn(
        { projectId: project.id, projectName: project.name },
        'Project has no local path mapping — sync blocked. Run "sync agent-approve" to set a local path.',
      );
    }

    // Prune stale approvals for projects no longer in config
    const activeIds = new Set(config.projects.map((p) => p.id));
    const pruned = pruneStaleApprovals(this.approvedPaths, activeIds);
    if (pruned.entries.length !== this.approvedPaths.entries.length) {
      this.approvedPaths = pruned;
      await writeApprovedPaths(this.agentDir, pruned);
    }

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
        // Skip if no local path mapping — the trigger methods will log a warning
        if (!hasApprovedPath(this.approvedPaths, project.id)) {
          this.logger.warn(
            { projectId: project.id },
            'Skipping server-initiated operation: no local path configured',
          );
          continue;
        }

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
   * Returns false if the project's path is not approved.
   */
  private projectNeedsWatcher(project: ProjectDefinition): boolean {
    // Never watch projects without an approved local path mapping
    if (!hasApprovedPath(this.approvedPaths, project.id)) return false;

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
    const localPath = this.resolveLocalPath(project.id);
    if (!localPath) {
      this.logger.warn(
        { projectId: project.id, projectName: project.name },
        'No local path configured for project. Run "sync agent-approve" to set a local path.',
      );
      return;
    }

    this.logger.info(
      { projectId: project.id, localPath },
      'Starting file watcher for project',
    );

    const watcher = new FileWatcher({
      projectId: project.id,
      localPath,
      includes: project.includes,
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
   * Returns false if the project's path is not approved.
   */
  private projectNeedsSchedule(project: ProjectDefinition): boolean {
    if (!project.schedule) return false;

    // Never schedule projects without an approved local path mapping
    if (!hasApprovedPath(this.approvedPaths, project.id)) return false;

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

    try {
      await this.triggerSync(projectId, undefined, 'schedule');
    } catch (err: unknown) {
      this.logger.error(
        { projectId, err: err instanceof Error ? err.message : String(err) },
        'Scheduled sync failed',
      );
    }
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
        error: sanitizeRcloneError(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      this.activeSyncs.delete(options.projectId);
    }

    await this.reportSyncResult(result, trigger);
    this.processPendingSync(options.projectId);
  }

  /**
   * Execute a protected pull operation (rclone copy --ignore-existing) and report.
   */
  private async executeProtectedPullOperation(
    options: Parameters<typeof runRcloneProtectedPull>[0],
    abortSignal: AbortSignal,
    trigger: 'manual' | 'watch' | 'schedule',
  ): Promise<void> {
    let result: SyncResult;

    try {
      result = await runRcloneProtectedPull(options, this.logger, abortSignal);
    } catch (error: unknown) {
      result = {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: 'pull',
        status: 'error',
        filesTransferred: 0,
        bytesTransferred: 0,
        durationMs: Date.now() - (this.activeSyncs.get(options.projectId)?.startedAt ?? Date.now()),
        error: sanitizeRcloneError(error instanceof Error ? error.message : String(error)),
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
        error: sanitizeRcloneError(error instanceof Error ? error.message : String(error)),
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
        error: sanitizeRcloneError(error instanceof Error ? error.message : String(error)),
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
          error: result.error ? sanitizeRcloneError(result.error) : undefined,
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
        error: sanitizeRcloneError(error instanceof Error ? error.message : String(error)),
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
          error: result.error ? sanitizeRcloneError(result.error) : undefined,
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
  // Sort keys before comparison to avoid false positives from property order differences
  const replacer = (_key: string, value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          }, {})
      : value;
  return JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
}
