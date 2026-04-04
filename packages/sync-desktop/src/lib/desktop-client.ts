/**
 * Desktop implementation of SyncClient.
 *
 * Wraps the existing api.ts functions into the SyncClient interface
 * so that sync-panel pages can use them via context.
 */

import type { SyncClient } from '@lamalibre/sync-panel';
import * as api from './api.js';

export function createDesktopSyncClient(): SyncClient {
  return {
    getHealth: () => api.getHealth(),
    getStatus: () => api.getStatus(),

    getProjects: () => api.getProjects(),
    getProject: (id) => api.getProject(id),
    getProjectStatus: (id) => api.getProjectStatus(id),
    createProject: (input) => api.createProject(input),
    updateProject: (id, input) => api.updateProject(id, input),
    deleteProject: (id, permanent) => api.deleteProject(id, permanent),
    restoreProject: (id) => api.restoreProject(id),
    getProjectsIncludeDeleted: () => api.getProjects_includeDeleted(),

    triggerSync: (id) => api.triggerSync(id),
    triggerArchive: (id) => api.triggerArchive(id),
    triggerRestore: (id, filePath) => api.triggerRestore(id, filePath),

    getStorage: () => api.getStorage(),
    testStorage: () => api.testStorage(),
    configureStorage: (input) => api.configureStorage(input),
    createBucket: (bucket) => api.createBucket(bucket),

    getAgents: () => api.getAgents(),
    getAgent: (id) => api.getAgent(id),
    deleteAgent: (id) => api.deleteAgent(id),

    getHistory: (projectId, limit) => api.getHistory(projectId, limit),

    getPreviews: () => api.getPreviews(),
    getPreview: (id) => api.getPreview(id),
    approvePreview: (id) => api.approvePreview(id),
    rejectPreview: (id) => api.rejectPreview(id),

    getTrash: (id) => api.getTrash(id),
    restoreTrash: (id, timestamp) => api.restoreTrash(id, timestamp),
    purgeTrash: (id, olderThanDays) => api.purgeTrash(id, olderThanDays),

    getApprovals: () => api.getApprovals(),
    addApproval: (input) => api.addApproval(input),
    revokeApproval: (id) => api.revokeApproval(id),
  };
}
