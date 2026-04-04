import type {
  HealthResponse,
  GlobalStatus,
  ProjectListResponse,
  ProjectResponse,
  ProjectStatusResponse,
  ProjectCreateInput,
  ProjectUpdateInput,
  HistoryResponse,
  StorageResponse,
  StorageTestResponse,
  StorageConfigInput,
  CreateBucketResponse,
  OperationResponse,
  AgentListResponse,
  AgentResponse,
  PreviewListResponse,
  PreviewResponse,
  TrashResponse,
  ApprovedPathsResponse,
  ApprovePathInput,
} from './types.js';

/**
 * Abstract client interface for the Sync REST API.
 *
 * Two implementations:
 * - `createFetchSyncClient()` — HTTP fetch for microfrontend context
 * - Desktop wraps existing api.ts functions (in sync-desktop)
 */
export interface SyncClient {
  // Health & Status
  getHealth(): Promise<HealthResponse>;
  getStatus(): Promise<GlobalStatus>;

  // Projects
  getProjects(): Promise<ProjectListResponse>;
  getProject(projectId: string): Promise<ProjectResponse>;
  getProjectStatus(projectId: string): Promise<ProjectStatusResponse>;
  createProject(input: ProjectCreateInput): Promise<ProjectResponse>;
  updateProject(projectId: string, input: ProjectUpdateInput): Promise<ProjectResponse>;
  deleteProject(projectId: string, permanent?: boolean): Promise<OperationResponse>;
  restoreProject(projectId: string): Promise<ProjectResponse>;
  getProjectsIncludeDeleted(): Promise<ProjectListResponse>;

  // Sync operations
  triggerSync(projectId: string): Promise<OperationResponse>;
  triggerArchive(projectId: string): Promise<OperationResponse>;
  triggerRestore(projectId: string, filePath?: string): Promise<OperationResponse>;

  // Storage
  getStorage(): Promise<StorageResponse>;
  testStorage(): Promise<StorageTestResponse>;
  configureStorage(input: StorageConfigInput): Promise<OperationResponse>;
  createBucket(bucket?: string): Promise<CreateBucketResponse>;

  // Agents
  getAgents(): Promise<AgentListResponse>;
  getAgent(agentId: string): Promise<AgentResponse>;
  deleteAgent(agentId: string): Promise<OperationResponse>;

  // History
  getHistory(projectId?: string, limit?: number): Promise<HistoryResponse>;

  // Previews (dry-run)
  getPreviews(): Promise<PreviewListResponse>;
  getPreview(projectId: string): Promise<PreviewResponse>;
  approvePreview(projectId: string): Promise<OperationResponse>;
  rejectPreview(projectId: string): Promise<OperationResponse>;

  // Trash
  getTrash(projectId: string): Promise<TrashResponse>;
  restoreTrash(projectId: string, timestamp?: string): Promise<OperationResponse>;
  purgeTrash(projectId: string, olderThanDays?: number): Promise<OperationResponse>;

  // Approvals (agent path mappings)
  getApprovals(): Promise<ApprovedPathsResponse>;
  addApproval(input: ApprovePathInput): Promise<OperationResponse>;
  revokeApproval(projectId: string): Promise<OperationResponse>;
}
