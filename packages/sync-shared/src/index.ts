export { checkNodeVersion } from './check-node-version.js';

export { atomicWriteFile } from './atomic-write.js';

export {
  PROVIDER_TYPES,
  SYNC_DIRECTIONS,
  CONFLICT_STRATEGIES,
  SYNC_TRIGGERS,
  PROJECT_STATUSES,
  ACCESS_MODES,
  CONFIRM_MODES,
  DEFAULT_SOFT_DELETE_CONFIG,
  DEFAULT_DELETE_THRESHOLD,
  PROJECT_ID_RE,
  PROJECT_ID_MAX_LENGTH,
  isNodeError,
  type ProviderType,
  type SyncDirection,
  type ConflictStrategy,
  type SyncTrigger,
  type ProjectStatus,
  type AccessMode,
  type ConfirmMode,
  type SoftDeleteConfig,
} from './types.js';

export {
  buildRcloneIni,
  buildCryptIni,
  RCLONE_REMOTE_NAME,
  type RcloneConfigInput,
} from './rclone-config.js';

export {
  DEFAULT_TRANSFERS,
  DEFAULT_CHECKERS,
  DEFAULT_STATS_INTERVAL,
  DEFAULT_RETRIES,
  DEFAULT_LOW_LEVEL_RETRIES,
} from './rclone-defaults.js';

export { sanitizeRcloneError } from './sanitize-error.js';

export { loadCliConfig, saveCliConfig, type CliConfig } from './cli-config.js';

export {
  savePendingSync,
  readPendingSync,
  listPendingSyncs,
  approvePendingSync,
  rejectPendingSync,
  removePendingSync,
  cleanExpiredPendingSyncs,
  buildPendingSyncPreview,
  ensurePendingSyncsDir,
  MAX_PREVIEW_CHANGES,
  type DryRunChange,
  type PendingSyncPreview,
} from './pending-sync.js';

export {
  readApprovedPaths,
  writeApprovedPaths,
  getLocalPath,
  hasApprovedPath,
  addApproval,
  removeApproval,
  getUnmappedProjects,
  pruneStaleApprovals,
  getAccessMode,
  getConfirmMode,
  getDeleteThreshold,
  validateLocalPath,
  type ApprovedPathEntry,
  type ApprovedPathsFile,
  type ProjectInfo,
} from './approved-paths.js';

export {
  resolveIgnorePatterns,
  parseIgnoreFileContent,
  gitignoreToRclone,
  BUILTIN_EXCLUDES,
  type ResolvedIgnorePatterns,
  type IgnoreResolverOptions,
} from './ignore-resolver.js';

export { writeExcludeFromFile } from './ignore-file-writer.js';
