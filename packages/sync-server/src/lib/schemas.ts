import { z } from 'zod';
import {
  SYNC_DIRECTIONS,
  CONFLICT_STRATEGIES,
  SYNC_TRIGGERS,
  PROJECT_STATUSES,
} from '@lamalibre/sync-shared';
import type {
  SyncDirection as Direction,
  ConflictStrategy,
  SyncTrigger,
  ProjectStatus,
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
      // Normalize and ensure no ".." traversal
      const segments = v.split('/').filter(Boolean);
      return !segments.includes('..');
    }, `${label} must not contain ".." segments`);
}

export const localPathSchema = safePath('localPath').refine(
  (v) => v.startsWith('/'),
  'localPath must be an absolute path',
);

export const remotePathSchema = safePath('remotePath');

// ---------------------------------------------------------------------------
// Provider / Storage
// ---------------------------------------------------------------------------

export const providerTypeSchema = z.enum(['spaces', 's3', 'gcs', 'azure', 'b2', 'custom']);

export type ProviderType = z.infer<typeof providerTypeSchema>;

/** Refinement: value must not contain newlines (prevents INI injection in rclone.conf). */
const noNewlines = (s: string): boolean => !/[\r\n]/.test(s);
const noNewlinesMsg = { message: 'Value must not contain newlines' };

export const storageConfigSchema = z.object({
  provider: providerTypeSchema,
  endpoint: z.string().url().refine(noNewlines, noNewlinesMsg),
  bucket: z.string().min(1).max(255).refine(noNewlines, noNewlinesMsg),
  region: z.string().max(64).refine(noNewlines, noNewlinesMsg).optional(),
  accessKey: z.string().min(1).refine(noNewlines, noNewlinesMsg),
  secretKey: z.string().min(1).refine(noNewlines, noNewlinesMsg),
  encryption: z.boolean().optional().default(false),
  encryptionPassword: z.string().refine(noNewlines, noNewlinesMsg).optional(),
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
// Direction & conflict strategy
// ---------------------------------------------------------------------------

export const directionSchema = z.enum(SYNC_DIRECTIONS);
export type { Direction, ConflictStrategy, SyncTrigger };

export const conflictStrategySchema = z.enum(CONFLICT_STRATEGIES);

export const syncTriggerSchema = z.enum(SYNC_TRIGGERS);

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(100),
  localPath: localPathSchema,
  remotePath: remotePathSchema.optional(),
  direction: directionSchema.optional().default('push'),
  includes: z.array(z.string()).optional().default([]),
  excludes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes'),
    )
    .max(100)
    .optional()
    .default(['.git', '.DS_Store', '*.tmp']),
  schedule: z.string().nullable().optional().default(null),
  encrypted: z.boolean().optional().default(false),
  /**
   * Per-project encryption password. Required when `encrypted` is true and
   * no global encryption password is configured on storage.
   * WARNING: Password loss = data loss. There is no key recovery mechanism.
   */
  encryptionPassword: z.string().min(8).optional(),
  conflictStrategy: conflictStrategySchema.optional().default('newest-wins'),
  watch: z.boolean().optional().default(false),
  trigger: syncTriggerSchema.optional().default('manual'),
  watchDebounceMs: z.number().int().min(500).max(60_000).optional().default(5_000),
  bandwidthLimit: z
    .string()
    .regex(/^\d+(\.\d+)?[kKmMgG]?$/, 'Must be a valid rclone bandwidth limit (e.g., 1M, 500k)')
    .optional(),
});

export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  localPath: localPathSchema.optional(),
  remotePath: remotePathSchema.optional(),
  direction: directionSchema.optional(),
  includes: z.array(z.string()).optional(),
  excludes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((s) => !s.includes('\0'), 'Pattern must not contain null bytes'),
    )
    .max(100)
    .optional(),
  schedule: z.string().nullable().optional(),
  encrypted: z.boolean().optional(),
  /** Per-project encryption password. Min 8 chars when provided. */
  encryptionPassword: z.string().min(8).optional(),
  conflictStrategy: conflictStrategySchema.optional(),
  watch: z.boolean().optional(),
  trigger: syncTriggerSchema.optional(),
  watchDebounceMs: z.number().int().min(500).max(60_000).optional(),
  bandwidthLimit: z
    .string()
    .regex(/^\d+(\.\d+)?[kKmMgG]?$/, 'Must be a valid rclone bandwidth limit (e.g., 1M, 500k)')
    .optional(),
});

export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectStatusEnum = z.enum(PROJECT_STATUSES);
export type { ProjectStatus };

export interface Project {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  direction: Direction;
  includes: string[];
  excludes: string[];
  schedule: string | null;
  encrypted: boolean;
  /** Encrypted-at-rest per-project encryption password (only when encrypted=true). */
  encryptionPasswordEncrypted?: string;
  conflictStrategy: ConflictStrategy;
  watch: boolean;
  trigger: SyncTrigger;
  watchDebounceMs: number;
  /** Per-project bandwidth limit (e.g. "10M" for 10 MiB/s). */
  bandwidthLimit?: string;
  status: ProjectStatus;
  lastSync: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sync operation
// ---------------------------------------------------------------------------

export const syncOperationStatusSchema = z.enum(['pending', 'running', 'completed', 'error']);

export type SyncOperationStatus = z.infer<typeof syncOperationStatusSchema>;

export interface SyncOperation {
  id: string;
  projectId: string;
  type: 'sync' | 'archive' | 'restore';
  direction: Direction;
  trigger: 'manual' | 'watch' | 'schedule';
  status: SyncOperationStatus;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  bytesTransferred: number | null;
  filesTransferred: number | null;
  errors: number;
  errorMessage: string | null;
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
}

// ---------------------------------------------------------------------------
// Agent report
// ---------------------------------------------------------------------------

export const agentReportSchema = z.object({
  operationId: z.string().uuid(),
  projectId: z.string().min(1),
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

/** Stub file info returned by the stubs listing endpoint. */
export interface StubInfo {
  projectId: string;
  archivedAt: string;
  remotePath: string;
  provider: string;
  bucket: string;
  totalSize: number;
  fileCount: number;
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
