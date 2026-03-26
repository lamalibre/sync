import pino from 'pino';
import { checkNodeVersion } from '@lamalibre/sync-shared';
import { Agent } from './agent.js';
import { AGENT_DIR } from './lib/config.js';

checkNodeVersion();

export const PACKAGE_NAME = '@lamalibre/sync-agent';

// Re-export public API
export { Agent } from './agent.js';
export type { AgentOptions } from './agent.js';
export {
  ServerClient,
  type ServerClientOptions,
  type AgentRegistrationPayload,
  type AgentRegistrationResponse,
  type HeartbeatPayload,
} from './lib/server-client.js';
export type {
  AgentConfig,
  AgentSettings,
  AgentReport,
  ProjectDefinition,
  ProviderConfig,
  SyncDirection,
  SyncProgress,
  SyncResult,
  RcloneSyncOptions,
  RcloneBisyncOptions,
  ConflictStrategy,
  SyncTrigger,
  BisyncConflict,
  BisyncState,
} from './lib/types.js';
export {
  generateRcloneConfig,
  writeRcloneConfig,
  getRcloneConfigPath,
  getProjectRemoteName,
  buildCryptRemoteMap,
  obscurePassword,
  RCLONE_REMOTE_NAME,
  RCLONE_ENCRYPTED_REMOTE_NAME,
} from './lib/rclone-config.js';
export {
  runRcloneSync,
  runRcloneBisync,
  runRcloneDryRun,
  runRcloneProtectedPull,
  generateOperationId,
  buildIncludeFlags,
  buildExcludeFlags,
  buildBandwidthFlags,
  parseBisyncConflicts,
} from './lib/rclone-runner.js';
export { createProgressParser } from './lib/progress-parser.js';
export { AGENT_DIR } from './lib/config.js';
export {
  savePendingSync,
  readPendingSync,
  listPendingSyncs,
  approvePendingSync,
  rejectPendingSync,
  removePendingSync,
  cleanExpiredPendingSyncs,
  buildPendingSyncPreview,
  MAX_PREVIEW_CHANGES,
  type DryRunChange,
  type PendingSyncPreview,
} from '@lamalibre/sync-shared';
export { parseDryRunOutput } from './lib/dry-run-parser.js';
export {
  FileWatcher,
  type OnChangesDetected,
  type FileWatcherOptions,
} from './lib/file-watcher.js';
export { Scheduler, type OnScheduledSync, type SchedulerOptions } from './lib/scheduler.js';
export { getBisyncState, updateBisyncState, removeBisyncState } from './lib/bisync-state.js';
export {
  runArchive,
  runRestore,
  type ArchiveOptions,
  type ArchiveResult,
  type RestoreOptions,
  type RestoreResult,
} from './lib/archive.js';
export {
  scanDirectory,
  readStub,
  writeStub,
  buildStubData,
  STUB_FILENAME,
  type StubData,
  type StubFileEntry,
  type ScanResult,
} from './lib/stub.js';
export {
  isAgentPluginMode,
  createMtlsAgent,
  validateMtlsConfig,
  type MtlsConfig,
  type PluginModeSettings,
} from './lib/plugin-mode.js';

/**
 * Entry point for the sync-agent daemon.
 * Creates a pino logger, instantiates the Agent, and starts it.
 * Handles SIGINT/SIGTERM for graceful shutdown.
 */
export async function main(): Promise<void> {
  const logger = pino({
    name: 'sync-agent',
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      process.env['NODE_ENV'] === 'development'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  });

  const agentDir = process.env['SYNC_AGENT_DIR'] ?? AGENT_DIR;

  const agent = new Agent({ agentDir, logger });

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    // Don't exit — let the agent continue running
  });

  try {
    await agent.start();
  } catch (error: unknown) {
    logger.fatal(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to start sync agent',
    );
    process.exit(1);
  }
}
