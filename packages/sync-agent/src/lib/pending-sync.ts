/**
 * Re-export pending sync utilities from @lamalibre/sync-shared.
 * The implementation lives in sync-shared so both the agent and CLI can use it.
 */
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
} from '@lamalibre/sync-shared';
