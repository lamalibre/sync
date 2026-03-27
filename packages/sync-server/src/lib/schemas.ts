import { posix } from 'node:path';
import { z } from 'zod';
import {
  PROVIDER_TYPES,
  SYNC_DIRECTIONS,
  CONFLICT_STRATEGIES,
  SYNC_TRIGGERS,
  PROJECT_STATUSES,
  PROJECT_ID_RE,
  PROJECT_ID_MAX_LENGTH,
} from '@lamalibre/sync-shared';
import type {
  SyncDirection as Direction,
  ConflictStrategy,
  SyncTrigger,
  ProjectStatus,
  SoftDeleteConfig,
} from '@lamalibre/sync-shared';

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Reusable refinement: no null bytes, no ".." after normalization, max 4096 */
function safePath(label: string) {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .max(4096, `${label} must be at most 4096 characters`)
    .refine((v) => !v.includes('\0'), `${label} must not contain null bytes`)
    .refine((v) => {
      // Normalize the path and reject any ".." traversal.
      // posix.normalize collapses redundant separators and resolves "." but
      // preserves ".." — we then check that no segment is "..".
      const normalized = posix.normalize(v);
      const segments = normalized.split('/').filter(Boolean);
      return !segments.includes('..');
    }, `${label} must not contain ".." segments`)
    .refine((v) => !posix.normalize(v).startsWith('/'), `${label} must be a relative path`);
}

export const remotePathSchema = safePath('remotePath');

/** Project IDs are slugified: lowercase alphanumeric + hyphens only. */
export const projectIdSchema = z.string().min(1).max(PROJECT_ID_MAX_LENGTH).regex(PROJECT_ID_RE, 'Invalid project ID format');

// ---------------------------------------------------------------------------
// Provider / Storage
// ---------------------------------------------------------------------------

export const providerTypeSchema = z.enum(PROVIDER_TYPES);

export type ProviderType = z.infer<typeof providerTypeSchema>;

/** Refinement: value must not contain newlines (prevents INI injection in rclone.conf). */
const noNewlines = (s: string): boolean => !/[\r\n]/.test(s);
const noNewlinesMsg = { message: 'Value must not contain newlines' };

export const storageConfigSchema = z.object({
  provider: providerTypeSchema,
  endpoint: z.string().url().refine(noNewlines, noNewlinesMsg),
  bucket: z.string().min(1).max(255).refine(noNewlines, noNewlinesMsg).refine((v) => !v.includes(':'), 'Bucket name must not contain colons'),
  region: z.string().max(64).refine(noNewlines, noNewlinesMsg).optional(),
  accessKey: z.string().min(1).refine(noNewlines, noNewlinesMsg),
  secretKey: z.string().min(1).refine(noNewlines, noNewlinesMsg),
  encryption: z.boolean().optional().default(false),
  encryptionPassword: z
    .string()
    .min(12, 'Encryption password must be at least 12 characters')
    .refine(noNewlines, noNewlinesMsg)
    .optional(),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

export const storageUpdateSchema = storageConfigSchema.refine(
  (data) => {
    if (data.encryption && !data.encryptionPassword) {
      return false;
    }
    return true;
  },
  { message: 'encryptionPassword is required when encryption is true' },
);

// ---------------------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------------------

// Validate a standard 5-field cron expression (minute hour day month weekday).
// Accepts numbers, ranges (1-5), steps (star/5), lists (1,3,5), and wildcards.
// Does NOT accept the optional seconds field to prevent sub-minute scheduling.
const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*)(\/(0*[1-9]\d?))?$/;

/** Min/max value for each of the five cron fields (minute, hour, day, month, weekday). */
const CRON_FIELD_MIN = [0, 0, 1, 1, 0] as const;
const CRON_FIELD_MAX = [59, 23, 31, 12, 7] as const;

function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => {
    if (!CRON_FIELD.test(f)) return false;
    // Range-check all numeric values in the field
    const min = CRON_FIELD_MIN[i]!;
    const max = CRON_FIELD_MAX[i]!;
    const nums = f.replace(/\*|\/\d+/g, '').split(/[,-]/).filter(Boolean);
    return nums.every((n) => {
      const val = parseInt(n, 10);
      return !isNaN(val) && val >= min && val <= max;
    });
  });
}

const cronSchema = z
  .string()
  .refine(isValidCron, 'Must be a valid 5-field cron expression (minute hour day month weekday)');

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

export const softDeleteConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  retentionDays: z.number().int().min(1).max(3650).optional().default(90),
  cleanupSchedule: cronSchema.optional().default('0 3 * * *'),
});

export const purgeTrashSchema = z.object({
  olderThanDays: z.number().int().min(1, 'olderThanDays must be at least 1').optional(),
});

export type { SoftDeleteConfig };

// ---------------------------------------------------------------------------
// Direction & conflict strategy
// ---------------------------------------------------------------------------

export const directionSchema = z.enum(SYNC_DIRECTIONS);
export type { Direction, ConflictStrategy, SyncTrigger };

export const conflictStrategySchema = z.enum(CONFLICT_STRATEGIES);

export const syncTriggerSchema = z.enum(SYNC_TRIGGERS);

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const projectNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => !/[\x00-\x1f]/.test(v), 'Name must not contain control characters');

export const projectCreateSchema = z.object({
  name: projectNameSchema,
  remotePath: remotePathSchema.optional(),
  direction: directionSchema.optional().default('push'),
  includes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes')
        .refine((s) => !/^[+\-!]/.test(s), 'Pattern must not start with rclone filter prefixes (+, -, !)'),
    )
    .max(100)
    .optional()
    .default([]),
  excludes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes')
        .refine((s) => !/^[+\-!]/.test(s), 'Pattern must not start with rclone filter prefixes (+, -, !)'),
    )
    .max(100)
    .optional()
    .default([]),
  schedule: cronSchema.nullable().optional().default(null),
  encrypted: z.boolean().optional().default(false),
  /**
   * Per-project encryption password. Required when `encrypted` is true and
   * no global encryption password is configured on storage.
   * WARNING: Password loss = data loss. There is no key recovery mechanism.
   */
  encryptionPassword: z.string().min(12, 'Encryption password must be at least 12 characters').refine(noNewlines, noNewlinesMsg).optional(),
  conflictStrategy: conflictStrategySchema.optional().default('newest-wins'),
  watch: z.boolean().optional().default(false),
  trigger: syncTriggerSchema.optional().default('manual'),
  watchDebounceMs: z.number().int().min(500).max(60_000).optional().default(5_000),
  bandwidthLimit: z
    .string()
    .max(20)
    .regex(/^\d+(\.\d+)?[kKmMgG]$/, 'Must be a valid rclone bandwidth limit with unit suffix (e.g., 1M, 500k, 2G)')
    .optional(),
  softDelete: softDeleteConfigSchema.optional(),
});

export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z.object({
  name: projectNameSchema.optional(),
  remotePath: remotePathSchema.optional(),
  direction: directionSchema.optional(),
  includes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes')
        .refine((s) => !/^[+\-!]/.test(s), 'Pattern must not start with rclone filter prefixes (+, -, !)'),
    )
    .max(100)
    .optional(),
  excludes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes')
        .refine((s) => !/^[+\-!]/.test(s), 'Pattern must not start with rclone filter prefixes (+, -, !)'),
    )
    .max(100)
    .optional(),
  schedule: cronSchema.nullable().optional(),
  encrypted: z.boolean().optional(),
  /** Per-project encryption password. Min 12 chars when provided. */
  encryptionPassword: z.string().min(12, 'Encryption password must be at least 12 characters').refine(noNewlines, noNewlinesMsg).optional(),
  conflictStrategy: conflictStrategySchema.optional(),
  watch: z.boolean().optional(),
  trigger: syncTriggerSchema.optional(),
  watchDebounceMs: z.number().int().min(500).max(60_000).optional(),
  bandwidthLimit: z
    .string()
    .max(20)
    .regex(/^\d+(\.\d+)?[kKmMgG]$/, 'Must be a valid rclone bandwidth limit with unit suffix (e.g., 1M, 500k, 2G)')
    .optional(),
  softDelete: softDeleteConfigSchema.optional(),
});

export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectStatusEnum = z.enum(PROJECT_STATUSES);
export type { ProjectStatus };

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly remotePath: string;
  readonly direction: Direction;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly schedule: string | null;
  readonly encrypted: boolean;
  /** Encrypted-at-rest per-project encryption password (only when encrypted=true). */
  readonly encryptionPasswordEncrypted?: string;
  readonly conflictStrategy: ConflictStrategy;
  readonly watch: boolean;
  readonly trigger: SyncTrigger;
  readonly watchDebounceMs: number;
  /** Per-project bandwidth limit (e.g. "10M" for 10 MiB/s). */
  readonly bandwidthLimit?: string;
  /** Per-project soft delete configuration override. */
  readonly softDelete?: SoftDeleteConfig;
  readonly status: ProjectStatus;
  readonly lastSync: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ISO timestamp when the project was soft-deleted, or null if active. */
  readonly deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Sync operation
// ---------------------------------------------------------------------------

export const syncOperationStatusSchema = z.enum(['pending', 'running', 'completed', 'error']);

export type SyncOperationStatus = z.infer<typeof syncOperationStatusSchema>;

export interface SyncOperation {
  readonly id: string;
  readonly projectId: string;
  readonly type: 'sync' | 'archive' | 'restore';
  readonly direction: Direction;
  readonly trigger: 'manual' | 'watch' | 'schedule';
  readonly status: SyncOperationStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly duration: number | null;
  readonly bytesTransferred: number | null;
  readonly filesTransferred: number | null;
  readonly errors: number;
  readonly errorMessage: string | null;
}

export interface ActiveOperation {
  operationId: string;
  projectId: string;
  type: 'sync' | 'archive' | 'restore';
  startedAt: string;
  transferred: number;
  totalSize: number;
  speed: number;
  eta: number;
  filesTransferred: number;
  filesTotal: number;
  /** Direction override for this operation (when API caller specifies a different direction). */
  direction?: Direction;
}

// ---------------------------------------------------------------------------
// Agent report
// ---------------------------------------------------------------------------

export const agentReportSchema = z.object({
  operationId: z.string().uuid(),
  projectId: projectIdSchema,
  status: z.enum(['completed', 'error']),
  direction: directionSchema.optional(),
  bytesTransferred: z.number().int().nonnegative().optional().default(0),
  filesTransferred: z.number().int().nonnegative().optional().default(0),
  errors: z.number().int().nonnegative().optional().default(0),
  errorMessage: z.string().optional(),
  localSize: z.number().int().nonnegative().optional(),
  remoteSize: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  duration: z.number().nonnegative().optional().default(0),
  /** Distinguish archive/restore reports from regular sync reports. */
  type: z.enum(['sync', 'archive', 'restore']).optional(),
  /** Bytes of disk space freed by archiving. */
  spaceFreed: z.number().int().nonnegative().optional(),
  /** Total size of archived files. */
  totalSize: z.number().int().nonnegative().optional(),
  /** Conflicts detected during bisync. */
  conflicts: z
    .array(
      z.object({
        path: z.string(),
        type: z.enum(['file-modified-both-sides', 'file-new-both-sides', 'unknown']),
        detectedAt: z.string(),
      }),
    )
    .optional(),
  /** What triggered this sync (manual, watch, schedule). */
  trigger: z.enum(['manual', 'watch', 'schedule']).optional(),
});

export type AgentReport = z.infer<typeof agentReportSchema>;

// ---------------------------------------------------------------------------
// Archive savings tracking
// ---------------------------------------------------------------------------

/** Per-project savings tracked after archive operations. */
export interface ArchiveSavings {
  projectId: string;
  archivedFileCount: number;
  archivedTotalBytes: number;
  stubSizeBytes: number;
  bytesSaved: number;
  lastArchivedAt: string;
}

// ---------------------------------------------------------------------------
// Server config (persisted)
// ---------------------------------------------------------------------------

export interface ServerConfig {
  port: number;
  dataDir: string;
  storage: EncryptedStorageConfig | null;
  lastTested: string | null;
  testResult: 'ok' | 'error' | null;
  /** SHA-256 hash of the API key used for standalone authentication. */
  apiKeyHash?: string;
  /** Global soft delete configuration. */
  softDelete?: SoftDeleteConfig;
}

/** Storage config as persisted — credentials are encrypted at rest */
export interface EncryptedStorageConfig {
  provider: ProviderType;
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyEncrypted: string;
  secretKeyEncrypted: string;
  encryption: boolean;
  encryptionPasswordEncrypted?: string;
}

// ---------------------------------------------------------------------------
// History query
// ---------------------------------------------------------------------------

export const historyQuerySchema = z.object({
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});

// ---------------------------------------------------------------------------
// Multi-agent support
// ---------------------------------------------------------------------------

/** Agent status based on heartbeat freshness. */
export type AgentStatus = 'online' | 'offline';

/** Heartbeat timeout: agent is considered offline after this many ms without a heartbeat. */
export const AGENT_HEARTBEAT_TIMEOUT_MS = 30_000;

/** Schema for agent registration request. */
export const agentRegisterSchema = z.object({
  /** Human-readable name for this agent (e.g. "macbook-pro", "build-server"). */
  name: z.string().min(1).max(100),
  /** Hostname of the machine running the agent. */
  hostname: z.string().min(1).max(255),
  /** Operating system (e.g. "darwin", "linux"). */
  os: z.string().min(1).max(50),
  /** OS version string. */
  osVersion: z.string().max(100).optional(),
  /** Node.js version running the agent. */
  nodeVersion: z.string().max(50),
  /** Agent package version. */
  agentVersion: z.string().max(50).optional(),
  /** Project IDs this agent wants to sync. Empty means all projects. */
  projectIds: z.array(z.string()).optional().default([]),
});

export type AgentRegister = z.infer<typeof agentRegisterSchema>;

/** Schema for agent heartbeat request. */
export const agentHeartbeatSchema = z.object({
  /** Current active sync operations on this agent. */
  activeSyncs: z
    .array(
      z.object({
        projectId: z.string(),
        operationId: z.string(),
        startedAt: z.string(),
      }),
    )
    .optional()
    .default([]),
  /** Disk usage information (optional). */
  diskUsage: z
    .object({
      totalBytes: z.number().nonnegative(),
      freeBytes: z.number().nonnegative(),
      usedBytes: z.number().nonnegative(),
    })
    .optional(),
});

export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;

/** Persisted agent record. */
export interface RegisteredAgent {
  id: string;
  name: string;
  hostname: string;
  os: string;
  osVersion?: string;
  nodeVersion: string;
  agentVersion?: string;
  /** Project IDs this agent is assigned to. Empty means all projects. */
  projectIds: string[];
  /** ISO timestamp of the last heartbeat received. */
  lastHeartbeat: string;
  /** ISO timestamp when the agent was first registered. */
  registeredAt: string;
  /** SHA-256 hash of the agent's authentication token. */
  agentTokenHash?: string;
  /** Last known active syncs from the most recent heartbeat. */
  activeSyncs: Array<{
    projectId: string;
    operationId: string;
    startedAt: string;
  }>;
  /** Last known disk usage from the most recent heartbeat. */
  diskUsage?: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
  };
}
