/**
 * Shared types for the sync-agent package.
 *
 * Domain types (ProviderType, SyncDirection, ConflictStrategy, SyncTrigger,
 * ProjectStatus) are re-exported from @lamalibre/sync-shared so there is a
 * single canonical definition.
 */

import type {
  ProviderType,
  SyncDirection,
  ProjectStatus,
  ConflictStrategy,
  SyncTrigger,
  SoftDeleteConfig,
} from '@lamalibre/sync-shared';

export type { ProviderType, SyncDirection, ProjectStatus, ConflictStrategy, SyncTrigger, SoftDeleteConfig };

/** A conflict detected during bisync. */
export interface BisyncConflict {
  readonly path: string;
  readonly type: 'file-modified-both-sides' | 'file-new-both-sides' | 'unknown';
  readonly detectedAt: string;
}

/** Bisync state tracked per project. */
export interface BisyncState {
  /** Whether the initial --resync has been completed. */
  readonly baselineEstablished: boolean;
  /** ISO timestamp of last successful bisync. */
  readonly lastBisync: string | null;
  /** Conflicts from the most recent bisync run. */
  readonly conflicts: readonly BisyncConflict[];
}

/** Storage provider configuration from the server. */
export interface ProviderConfig {
  readonly type: ProviderType;
  readonly bucket: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly serviceAccountKey?: string;
  readonly storageAccountName?: string;
  readonly storageAccountKey?: string;
  readonly applicationKeyId?: string;
  readonly applicationKey?: string;
  /** For custom S3-compatible providers. */
  readonly forcePathStyle?: boolean;
  /** rclone crypt password (obscured), used when a project has encryption enabled. */
  readonly encryptionPassword?: string;
}

/** A project definition as received from the server. */
export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly remotePath: string;
  readonly direction: SyncDirection;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly encrypted: boolean;
  /**
   * Per-project encryption password. Present only when `encrypted` is true.
   * Used to generate the rclone crypt remote for this project.
   * NEVER logged or passed as a CLI argument.
   */
  readonly encryptionPassword?: string;
  readonly schedule: string | null;
  readonly watch: boolean;
  readonly status: ProjectStatus;
  readonly bandwidthLimit?: string;
  readonly conflictStrategy?: ConflictStrategy;
  readonly trigger?: SyncTrigger;
  readonly watchDebounceMs?: number;
  readonly softDelete?: SoftDeleteConfig;
  /**
   * Operation ID assigned by the server for a pending sync.
   * When present, the agent must use this ID (instead of generating a new one)
   * so the server can correlate the agent report with the history entry.
   */
  readonly pendingOperationId?: string;
  /**
   * Direction override for a pending sync operation.
   * When the API caller specifies a direction different from the project's default,
   * this field carries that override so the agent uses the correct direction.
   */
  readonly pendingDirection?: SyncDirection;
  /**
   * Type of pending operation: 'sync', 'archive', or 'restore'.
   * Used by the agent to determine which operation to run.
   */
  readonly pendingType?: 'sync' | 'archive' | 'restore';
}

/** Agent configuration returned by the server's GET /api/sync/agent-config endpoint. */
export interface AgentConfig {
  readonly provider: ProviderConfig;
  readonly projects: readonly ProjectDefinition[];
  readonly defaultBandwidthLimit?: string;
  readonly softDelete?: SoftDeleteConfig;
}

/** Local agent settings stored in ~/.sync-agent/agent-settings.json. */
export interface AgentSettings {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly pollIntervalMs: number;
  /** Persisted agent ID from server registration. */
  readonly agentId?: string;
  /** Human-readable agent name. */
  readonly agentName?: string;
  /** Per-agent authentication token returned on registration. */
  readonly agentToken?: string;
}

/** Progress information parsed from rclone stderr. */
export interface SyncProgress {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly percentage: number;
  readonly speed: string;
  readonly eta: string;
  readonly filesTransferred: number;
  readonly filesTotal: number;
}

/** Result of a completed sync operation. */
export interface SyncResult {
  readonly operationId: string;
  readonly projectId: string;
  readonly direction: SyncDirection;
  readonly status: 'completed' | 'error';
  readonly filesTransferred: number;
  readonly bytesTransferred: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly conflicts?: readonly BisyncConflict[];
}

/** Report payload sent to POST /api/sync/agent-report. */
export interface AgentReport {
  readonly operationId: string;
  readonly projectId: string;
  readonly direction: SyncDirection;
  readonly status: 'completed' | 'error';
  readonly filesTransferred: number;
  readonly bytesTransferred: number;
  readonly duration: number;
  readonly error?: string;
  readonly conflicts?: readonly BisyncConflict[];
  readonly trigger?: 'manual' | 'watch' | 'schedule';
  /** Present on archive/restore reports to distinguish from regular syncs. */
  readonly type?: 'sync' | 'archive' | 'restore';
  /** Bytes saved by archiving (original size minus stub size). */
  readonly spaceFreed?: number;
  /** Total size of the archived files. */
  readonly totalSize?: number;
  /** Number of archived files. */
  readonly fileCount?: number;
}

/** Options for running an rclone sync. */
export interface RcloneSyncOptions {
  readonly operationId: string;
  readonly projectId: string;
  readonly direction: SyncDirection;
  readonly localPath: string;
  readonly remotePath: string;
  readonly rcloneConfigPath: string;
  readonly remoteName: string;
  readonly bucket: string;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  /** Path to an rclone --exclude-from file. When set, takes precedence over `excludes`. */
  readonly excludeFromPath?: string;
  readonly bandwidthLimit?: string;
  readonly softDelete?: SoftDeleteConfig;
  readonly onProgress?: (progress: SyncProgress) => void;
}

/** Options for running an rclone bisync. */
export interface RcloneBisyncOptions {
  readonly operationId: string;
  readonly projectId: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly rcloneConfigPath: string;
  readonly remoteName: string;
  readonly bucket: string;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  /** Path to an rclone --exclude-from file. When set, takes precedence over `excludes`. */
  readonly excludeFromPath?: string;
  readonly bandwidthLimit?: string;
  readonly resync: boolean;
  readonly conflictStrategy: ConflictStrategy;
  readonly softDelete?: SoftDeleteConfig;
  readonly onProgress?: (progress: SyncProgress) => void;
}
