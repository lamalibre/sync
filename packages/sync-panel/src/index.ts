// ---------------------------------------------------------------------------
// Public API for @lamalibre/sync-panel
//
// Consumers (sync-desktop, panel.js) import from this entry point.
// ---------------------------------------------------------------------------

// Pages
export { default as Dashboard } from './pages/Dashboard.svelte';
export { default as ProjectDetail } from './pages/ProjectDetail.svelte';
export { default as StorageSetup } from './pages/StorageSetup.svelte';
export { default as Agents } from './pages/Agents.svelte';
export { default as Preview } from './pages/Preview.svelte';
export { default as Trash } from './pages/Trash.svelte';
export { default as Settings } from './pages/Settings.svelte';

// Root app (page router)
export { default as SyncApp } from './App.svelte';

// Components
export { default as Modal } from './components/Modal.svelte';
export { default as ConfirmModal } from './components/ConfirmModal.svelte';
export { default as ProjectFormModal } from './components/ProjectFormModal.svelte';
export { default as ApprovalFormModal } from './components/ApprovalFormModal.svelte';

// Context
export { setSyncClient, getSyncClient } from './context/client.svelte.js';

// Client interface and implementations
export type { SyncClient } from './lib/client.js';
export { createFetchSyncClient } from './lib/fetch-client.js';

// Types
export * from './lib/types.js';

// Utilities
export { formatRelativeTime, formatBytes } from './lib/format.js';

// Page metadata (same as panel.ts pages array)
export const SYNC_PAGES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { id: 'storage', label: 'Storage', icon: 'hard-drive' },
  { id: 'agents', label: 'Agents', icon: 'monitor' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
  { id: 'trash', label: 'Trash', icon: 'trash-2' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const;
