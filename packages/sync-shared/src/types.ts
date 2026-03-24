/**
 * Canonical domain types shared across all sync packages.
 *
 * Each type is defined as a `const` array + a union type derived from it.
 * Zod schemas in sync-server can use `z.enum(ARRAY)` directly.
 */

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export const PROVIDER_TYPES = ['spaces', 's3', 'gcs', 'azure', 'b2', 'custom', 'local'] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

// ---------------------------------------------------------------------------
// Sync direction
// ---------------------------------------------------------------------------

export const SYNC_DIRECTIONS = ['push', 'pull', 'bidirectional'] as const;

export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Conflict strategy
// ---------------------------------------------------------------------------

export const CONFLICT_STRATEGIES = ['newest-wins', 'local-wins', 'remote-wins', 'manual'] as const;

export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

// ---------------------------------------------------------------------------
// Sync trigger
// ---------------------------------------------------------------------------

export const SYNC_TRIGGERS = ['manual', 'watch', 'schedule', 'watch+schedule'] as const;

export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// Project status
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = [
  'synced',
  'syncing',
  'local-only',
  'cloud-only',
  'archived',
  'error',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Utility type guard
// ---------------------------------------------------------------------------

/**
 * Type guard for Node.js errors with a `code` property (e.g. ENOENT).
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
