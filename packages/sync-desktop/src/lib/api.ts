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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORAGE_KEY_URL = 'sync-server-url';
const STORAGE_KEY_API_KEY = 'sync-api-key';

const DEFAULT_SERVER_URL = 'http://localhost:9393';

export function getServerUrl(): string {
  return localStorage.getItem(STORAGE_KEY_URL) ?? DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY_URL, url);
}

export function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY_API_KEY) ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY_API_KEY, key);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const baseUrl = getServerUrl().replace(/\/+$/, '');
  const apiKey = getApiKey();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({
      error: `HTTP ${response.status}`,
    }))) as unknown;

    const message =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'string'
        ? (body as { error: string }).error
        : `Request failed with status ${response.status}`;

    throw new ApiRequestError(message, response.status, body);
  }

  const body: unknown = await response.json();

  return body as T;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/sync/health');
}

export async function getStatus(): Promise<GlobalStatus> {
  return request<GlobalStatus>('/api/sync/status');
}

// Projects

export async function getProjects(): Promise<ProjectListResponse> {
  return request<ProjectListResponse>('/api/sync/projects');
}

export async function getProject(projectId: string): Promise<ProjectResponse> {
  return request<ProjectResponse>(`/api/sync/projects/${encodeURIComponent(projectId)}`);
}

export async function getProjectStatus(projectId: string): Promise<ProjectStatusResponse> {
  return request<ProjectStatusResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/status`,
  );
}

export async function createProject(input: ProjectCreateInput): Promise<ProjectResponse> {
  return request<ProjectResponse>('/api/sync/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateProject(
  projectId: string,
  input: ProjectUpdateInput,
): Promise<ProjectResponse> {
  return request<ProjectResponse>(`/api/sync/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteProject(
  projectId: string,
  permanent = false,
): Promise<OperationResponse> {
  const query = permanent ? '?permanent=true' : '';
  return request<OperationResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}${query}`,
    { method: 'DELETE' },
  );
}

export async function restoreProject(projectId: string): Promise<ProjectResponse> {
  return request<ProjectResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/undelete`,
    { method: 'POST' },
  );
}

export async function getProjects_includeDeleted(): Promise<ProjectListResponse> {
  return request<ProjectListResponse>('/api/sync/projects?includeDeleted=true');
}

// Sync operations

export async function triggerSync(projectId: string): Promise<OperationResponse> {
  return request<OperationResponse>(`/api/sync/projects/${encodeURIComponent(projectId)}/sync`, {
    method: 'POST',
  });
}

export async function triggerArchive(projectId: string): Promise<OperationResponse> {
  return request<OperationResponse>(`/api/sync/projects/${encodeURIComponent(projectId)}/archive`, {
    method: 'POST',
  });
}

export async function triggerRestore(
  projectId: string,
  filePath?: string,
): Promise<OperationResponse> {
  return request<OperationResponse>(`/api/sync/projects/${encodeURIComponent(projectId)}/restore`, {
    method: 'POST',
    body: filePath ? JSON.stringify({ filePath }) : undefined,
  });
}

// Storage

export async function getStorage(): Promise<StorageResponse> {
  return request<StorageResponse>('/api/sync/storage');
}

export async function testStorage(): Promise<StorageTestResponse> {
  return request<StorageTestResponse>('/api/sync/storage/test', {
    method: 'POST',
  });
}

export async function configureStorage(input: StorageConfigInput): Promise<OperationResponse> {
  return request<OperationResponse>('/api/sync/storage', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function createBucket(bucket?: string): Promise<CreateBucketResponse> {
  return request<CreateBucketResponse>('/api/sync/storage/create-bucket', {
    method: 'POST',
    body: bucket ? JSON.stringify({ bucket }) : undefined,
  });
}

// Agents

export async function getAgents(): Promise<AgentListResponse> {
  return request<AgentListResponse>('/api/sync/agents');
}

export async function getAgent(agentId: string): Promise<AgentResponse> {
  return request<AgentResponse>(`/api/sync/agents/${encodeURIComponent(agentId)}`);
}

export async function deleteAgent(agentId: string): Promise<OperationResponse> {
  return request<OperationResponse>(`/api/sync/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
}

// History

export async function getHistory(projectId?: string, limit?: number): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (limit !== undefined) params.set('limit', String(limit));

  const query = params.toString();
  return request<HistoryResponse>(`/api/sync/history${query ? `?${query}` : ''}`);
}

// Previews (dry-run)

export async function getPreviews(): Promise<PreviewListResponse> {
  return request<PreviewListResponse>('/api/sync/previews');
}

export async function getPreview(projectId: string): Promise<PreviewResponse> {
  return request<PreviewResponse>(`/api/sync/previews/${encodeURIComponent(projectId)}`);
}

export async function approvePreview(projectId: string): Promise<OperationResponse> {
  return request<OperationResponse>(
    `/api/sync/previews/${encodeURIComponent(projectId)}/approve`,
    { method: 'POST' },
  );
}

export async function rejectPreview(projectId: string): Promise<OperationResponse> {
  return request<OperationResponse>(
    `/api/sync/previews/${encodeURIComponent(projectId)}/reject`,
    { method: 'POST' },
  );
}

// Trash

export async function getTrash(projectId: string): Promise<TrashResponse> {
  return request<TrashResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/trash`,
  );
}

export async function restoreTrash(
  projectId: string,
  timestamp?: string,
): Promise<OperationResponse> {
  return request<OperationResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/restore-trash`,
    {
      method: 'POST',
      body: timestamp ? JSON.stringify({ timestamp }) : undefined,
    },
  );
}

export async function purgeTrash(
  projectId: string,
  olderThanDays?: number,
): Promise<OperationResponse> {
  return request<OperationResponse>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/purge-trash`,
    {
      method: 'POST',
      body: olderThanDays !== undefined ? JSON.stringify({ olderThanDays }) : undefined,
    },
  );
}

// Approvals (agent path mappings)

export async function getApprovals(): Promise<ApprovedPathsResponse> {
  return request<ApprovedPathsResponse>('/api/sync/approvals');
}

export async function addApproval(input: ApprovePathInput): Promise<OperationResponse> {
  return request<OperationResponse>('/api/sync/approvals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function revokeApproval(projectId: string): Promise<OperationResponse> {
  return request<OperationResponse>(
    `/api/sync/approvals/${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  );
}
