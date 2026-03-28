// ---------------------------------------------------------------------------
// Provider & storage
// ---------------------------------------------------------------------------

export type ProviderType = 'spaces' | 's3' | 'gcs' | 'azure' | 'b2' | 'custom' | 'local';

export type SyncDirection = 'push' | 'pull' | 'bidirectional';

export type ConflictStrategy = 'newest-wins' | 'local-wins' | 'remote-wins' | 'manual';

export type SyncTrigger = 'manual' | 'watch' | 'schedule' | 'watch+schedule';

export type ProjectStatus =
  | 'synced'
  | 'syncing'
  | 'local-only'
  | 'cloud-only'
  | 'archived'
  | 'error';

export type SyncOperationStatus = 'pending' | 'running' | 'completed' | 'error';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  uptime: number;
  timestamp: string;
}

export interface GlobalStatus {
  storageConfigured: boolean;
  provider: ProviderType | null;
  projects: number;
  activeOperations: number;
  totalLocalSize: number;
  totalRemoteSize: number;
  totalArchived: number;
  savedLocally: number;
}

export interface Project {
  id: string;
  name: string;
  remotePath: string;
  direction: SyncDirection;
  includes: string[];
  excludes: string[];
  schedule: string | null;
  encrypted: boolean;
  conflictStrategy: ConflictStrategy;
  watch: boolean;
  trigger: SyncTrigger;
  watchDebounceMs: number;
  bandwidthLimit?: string;
  softDelete?: { enabled: boolean; retentionDays: number; cleanupSchedule: string };
  status: ProjectStatus;
  lastSync: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when the project was soft-deleted, or null if active. */
  deletedAt: string | null;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface ProjectResponse {
  project: Project;
}

export interface ActiveOperation {
  operationId: string;
  type: 'sync' | 'archive' | 'restore';
  startedAt: string;
  transferred: number;
  totalSize: number;
  speed: number;
  eta: number;
  filesTransferred: number;
  filesTotal: number;
}

export interface ProjectStatusResponse {
  projectId: string;
  status: ProjectStatus;
  lastSync: string | null;
  activeOperation: ActiveOperation | null;
}

export interface SyncOperation {
  id: string;
  projectId: string;
  type: 'sync' | 'archive' | 'restore';
  direction: SyncDirection;
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

export interface HistoryResponse {
  operations: SyncOperation[];
}

export interface StorageResponse {
  configured: boolean;
  provider: ProviderType | null;
  lastTested: string | null;
  testResult: 'ok' | 'error' | null;
}

export interface StorageTestResponse {
  ok: boolean;
  latency?: number;
  message?: string;
  error?: string;
}

export interface OperationResponse {
  ok: boolean;
  operationId?: string;
  status?: string;
  error?: string;
}

export interface ApiError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export interface AgentDiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface AgentActiveSync {
  projectId: string;
  operationId: string;
  startedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  hostname: string;
  os: string;
  osVersion?: string;
  nodeVersion: string;
  agentVersion?: string;
  projectIds: string[];
  lastHeartbeat: string;
  registeredAt: string;
  activeSyncs: AgentActiveSync[];
  diskUsage?: AgentDiskUsage;
  status: 'online' | 'offline';
}

export interface AgentListResponse {
  agents: Agent[];
}

export interface AgentResponse {
  agent: Agent;
}

// ---------------------------------------------------------------------------
// Input types (create / update)
// ---------------------------------------------------------------------------

export interface ProjectCreateInput {
  name: string;
  remotePath?: string;
  direction?: SyncDirection;
  includes?: string[];
  excludes?: string[];
  schedule?: string | null;
  encrypted?: boolean;
  encryptionPassword?: string;
  conflictStrategy?: ConflictStrategy;
  watch?: boolean;
  trigger?: SyncTrigger;
  watchDebounceMs?: number;
  bandwidthLimit?: string;
}

export interface ProjectUpdateInput {
  name?: string;
  remotePath?: string;
  direction?: SyncDirection;
  includes?: string[];
  excludes?: string[];
  schedule?: string | null;
  encrypted?: boolean;
  encryptionPassword?: string;
  conflictStrategy?: ConflictStrategy;
  watch?: boolean;
  trigger?: SyncTrigger;
  watchDebounceMs?: number;
  bandwidthLimit?: string;
}

export interface StorageConfigInput {
  provider: Exclude<ProviderType, 'local'>;
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  encryption?: boolean;
  encryptionPassword?: string;
}

export interface SavingsResponse {
  totalBytesSaved: number;
  totalArchivedFileCount: number;
  totalArchivedBytes: number;
  totalStubSizeBytes: number;
  perProject: Array<{
    projectId: string;
    archivedFileCount: number;
    archivedTotalBytes: number;
    bytesSaved: number;
    lastArchivedAt: string;
  }>;
}

export interface CreateBucketResponse {
  ok: boolean;
  bucket: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Preview / Dry-run types
// ---------------------------------------------------------------------------

export type AccessMode = 'full' | 'push-only' | 'pull-only' | 'protected';

export type ConfirmMode = 'auto' | 'confirm-destructive' | 'confirm-always';

export interface DryRunChange {
  readonly path: string;
  readonly action: 'copy' | 'delete';
}

export interface PendingSyncPreview {
  readonly projectId: string;
  readonly projectName: string;
  readonly operationId: string;
  readonly direction: SyncDirection;
  readonly localPath?: string;
  readonly remotePath: string;
  readonly trigger: 'manual' | 'watch' | 'schedule';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly copyCount: number;
  readonly deleteCount: number;
  readonly changes: readonly DryRunChange[];
}

export interface PreviewListResponse {
  previews: PendingSyncPreview[];
}

export interface PreviewResponse {
  preview: PendingSyncPreview;
}

// ---------------------------------------------------------------------------
// Trash types
// ---------------------------------------------------------------------------

export interface TrashEntry {
  timestamp: string;
  fileCount: number;
}

export interface TrashResponse {
  projectId: string;
  entries: TrashEntry[];
}

// ---------------------------------------------------------------------------
// Approved path types
// ---------------------------------------------------------------------------

export interface ApprovedPathEntry {
  readonly projectId: string;
  readonly localPath?: string;
  readonly approvedAt: string;
  readonly projectName: string;
  readonly accessMode?: AccessMode;
  readonly confirmMode?: ConfirmMode;
  readonly deleteThreshold?: number;
}

export interface ApprovedPathsResponse {
  version: 1;
  entries: ApprovedPathEntry[];
}

export interface ApprovePathInput {
  projectId: string;
  localPath: string;
  projectName: string;
  accessMode?: AccessMode;
  confirmMode?: ConfirmMode;
  deleteThreshold?: number;
}
