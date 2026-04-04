import type { SyncClient } from './client.js';
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
 * HTTP fetch implementation of SyncClient.
 *
 * Used by the panel.js microfrontend — resolves API base from
 * the panelUrl + basePath provided by the host context.
 */
export function createFetchSyncClient(panelUrl: string, basePath: string): SyncClient {
  // basePath is e.g. "/api/plugins/sync" — extract plugin name for the API prefix
  const pluginName = basePath.split('/').pop() || 'sync';
  const apiBase = `${panelUrl}/${pluginName}/api/sync`;

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers,
      credentials: 'include',
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

      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  function enc(s: string): string {
    return encodeURIComponent(s);
  }

  return {
    getHealth: () => request<HealthResponse>('/health'),
    getStatus: () => request<GlobalStatus>('/status'),

    getProjects: () => request<ProjectListResponse>('/projects'),
    getProject: (id) => request<ProjectResponse>(`/projects/${enc(id)}`),
    getProjectStatus: (id) => request<ProjectStatusResponse>(`/projects/${enc(id)}/status`),
    createProject: (input) =>
      request<ProjectResponse>('/projects', { method: 'POST', body: JSON.stringify(input) }),
    updateProject: (id, input) =>
      request<ProjectResponse>(`/projects/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteProject: (id, permanent) =>
      request<OperationResponse>(`/projects/${enc(id)}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
    restoreProject: (id) =>
      request<ProjectResponse>(`/projects/${enc(id)}/undelete`, { method: 'POST' }),
    getProjectsIncludeDeleted: () =>
      request<ProjectListResponse>('/projects?includeDeleted=true'),

    triggerSync: (id) =>
      request<OperationResponse>(`/projects/${enc(id)}/sync`, { method: 'POST' }),
    triggerArchive: (id) =>
      request<OperationResponse>(`/projects/${enc(id)}/archive`, { method: 'POST' }),
    triggerRestore: (id, filePath) =>
      request<OperationResponse>(`/projects/${enc(id)}/restore`, {
        method: 'POST',
        body: filePath ? JSON.stringify({ filePath }) : undefined,
      }),

    getStorage: () => request<StorageResponse>('/storage'),
    testStorage: () => request<StorageTestResponse>('/storage/test', { method: 'POST' }),
    configureStorage: (input) =>
      request<OperationResponse>('/storage', { method: 'PATCH', body: JSON.stringify(input) }),
    createBucket: (bucket) =>
      request<CreateBucketResponse>('/storage/create-bucket', {
        method: 'POST',
        body: bucket ? JSON.stringify({ bucket }) : undefined,
      }),

    getAgents: () => request<AgentListResponse>('/agents'),
    getAgent: (id) => request<AgentResponse>(`/agents/${enc(id)}`),
    deleteAgent: (id) => request<OperationResponse>(`/agents/${enc(id)}`, { method: 'DELETE' }),

    getHistory: (projectId, limit) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (limit !== undefined) params.set('limit', String(limit));
      const query = params.toString();
      return request<HistoryResponse>(`/history${query ? `?${query}` : ''}`);
    },

    getPreviews: () => request<PreviewListResponse>('/previews'),
    getPreview: (id) => request<PreviewResponse>(`/previews/${enc(id)}`),
    approvePreview: (id) =>
      request<OperationResponse>(`/previews/${enc(id)}/approve`, { method: 'POST' }),
    rejectPreview: (id) =>
      request<OperationResponse>(`/previews/${enc(id)}/reject`, { method: 'POST' }),

    getTrash: (id) => request<TrashResponse>(`/projects/${enc(id)}/trash`),
    restoreTrash: (id, timestamp) =>
      request<OperationResponse>(`/projects/${enc(id)}/restore-trash`, {
        method: 'POST',
        body: timestamp ? JSON.stringify({ timestamp }) : undefined,
      }),
    purgeTrash: (id, olderThanDays) =>
      request<OperationResponse>(`/projects/${enc(id)}/purge-trash`, {
        method: 'POST',
        body: olderThanDays !== undefined ? JSON.stringify({ olderThanDays }) : undefined,
      }),

    getApprovals: () => request<ApprovedPathsResponse>('/approvals'),
    addApproval: (input) =>
      request<OperationResponse>('/approvals', { method: 'POST', body: JSON.stringify(input) }),
    revokeApproval: (id) =>
      request<OperationResponse>(`/approvals/${enc(id)}`, { method: 'DELETE' }),
  };
}
