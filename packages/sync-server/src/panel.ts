/**
 * Sync plugin panel — vanilla JS microfrontend for the Portlama desktop app.
 *
 * Contract:
 * - Evaluated via `new Function()` in the desktop app
 * - Must register `window.__portlamaPlugins.sync = { mount(ctx) }`
 * - ctx: { mountPoint: HTMLElement, panelUrl: string, basePath: string, subPath: string }
 * - Returns `{ unmount() }` for cleanup
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PanelCtx {
  mountPoint: HTMLElement;
  panelUrl: string;
  basePath: string;
  subPath: string;
}

// apiBase is resolved from ctx — handles different mount paths:
// - Panel server: panelUrl = "https://panel.example.com", routes at /api/sync/...
// - Local host: panelUrl = "http://localhost:9293", routes at /sync/api/sync/...
let _apiBase = '';

function setApiBase(ctx: PanelCtx): void {
  // basePath is e.g. "/plugins/sync" — extract plugin name for local host prefix
  const pluginName = ctx.basePath.split('/').pop() || 'sync';
  // Try local host path first (/<pluginName>/api/sync), fall back to direct
  _apiBase = `${ctx.panelUrl}/${pluginName}/api/sync`;
}

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${_apiBase}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

function el(
  tag: string,
  attrs?: Record<string, string> | null,
  ...children: (string | HTMLElement)[]
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

function badge(label: string, color: string): HTMLElement {
  return el('span', {
    className: 'sync-badge',
    style: `color: ${color}; border-color: ${color}40; background: ${color}15`,
  }, label);
}

function stat(label: string, value: string | number, color: string): HTMLElement {
  return el('div', { className: 'sync-stat-card' },
    el('span', { className: 'sync-stat-label' }, label),
    el('span', { className: 'sync-stat-value', style: `color: ${color}` }, String(value)),
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById('sync-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'sync-panel-styles';
  style.textContent = `
    .sync-panel { font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; color: #e4e4e7; }
    .sync-panel h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.25rem 0; }
    .sync-panel h2 { font-size: 0.875rem; font-weight: 500; color: #a1a1aa; margin: 1.5rem 0 0.75rem 0; }
    .sync-panel p.sub { font-size: 0.875rem; color: #71717a; margin: 0 0 1.5rem 0; }
    .sync-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
    .sync-stat-card { background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 0.75rem 1rem; }
    .sync-stat-label { display: block; font-size: 0.75rem; color: #71717a; margin-bottom: 0.25rem; }
    .sync-stat-value { display: block; font-size: 1.125rem; font-weight: 600; }
    .sync-badge { font-size: 0.75rem; padding: 0.125rem 0.5rem; border-radius: 0.375rem; border: 1px solid; }
    .sync-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .sync-table th { text-align: left; padding: 0.75rem 1rem; color: #71717a; font-weight: 500; border-bottom: 1px solid #27272a; }
    .sync-table td { padding: 0.75rem 1rem; border-bottom: 1px solid #27272a20; }
    .sync-table tr:hover td { background: #18181b40; }
    .sync-table-wrap { border: 1px solid #27272a; border-radius: 0.5rem; overflow: hidden; }
    .sync-card { background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 1rem; margin-bottom: 0.75rem; }
    .sync-card-title { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.5rem; }
    .sync-card-row { display: flex; justify-content: space-between; font-size: 0.8125rem; padding: 0.25rem 0; }
    .sync-card-label { color: #71717a; }
    .sync-loading { display: flex; align-items: center; justify-content: center; min-height: 16rem; color: #71717a; font-size: 0.875rem; }
    .sync-error { padding: 1rem; border: 1px solid #f8717130; background: #f8717108; border-radius: 0.5rem; color: #f87171; font-size: 0.875rem; }
    .sync-error button { margin-top: 0.75rem; padding: 0.375rem 1rem; border: 1px solid #f8717130; background: #f8717110; color: #f87171; border-radius: 0.375rem; cursor: pointer; font-size: 0.875rem; }
    .sync-empty { text-align: center; padding: 3rem 1rem; color: #71717a; font-size: 0.875rem; }
    .sync-storage-status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-size: 0.875rem; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Connections page (default)
// ---------------------------------------------------------------------------

function renderConnections(root: HTMLElement): () => void {
  root.innerHTML = '';
  const wrap = el('div', { className: 'sync-panel' });
  root.appendChild(wrap);

  wrap.appendChild(el('h1', null, 'Sync'));
  wrap.appendChild(el('p', { className: 'sub' }, 'File synchronization and cloud archive'));

  const statsEl = el('div', { className: 'sync-stats' });
  wrap.appendChild(statsEl);

  const storageEl = el('div');
  wrap.appendChild(storageEl);

  wrap.appendChild(el('h2', null, 'Projects'));
  const projectsEl = el('div');
  wrap.appendChild(projectsEl);

  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [storageRes, projectsRes, agentsRes] = await Promise.all([
        apiFetch('/storage') as Promise<Record<string, unknown>>,
        apiFetch('/projects') as Promise<Record<string, unknown>>,
        apiFetch('/agents') as Promise<Record<string, unknown>>,
      ]);

      if (cancelled) return;

      // Stats
      const projects = (projectsRes['projects'] ?? []) as Array<Record<string, unknown>>;
      const agents = (agentsRes['agents'] ?? []) as Array<Record<string, unknown>>;
      const onlineAgents = agents.filter((a) => a['online'] === true);

      statsEl.innerHTML = '';
      statsEl.appendChild(stat('Projects', projects.length, '#e4e4e7'));
      statsEl.appendChild(stat('Agents', `${onlineAgents.length}/${agents.length}`, '#34d399'));

      const storage = storageRes['configured'] ? storageRes : null;
      const testResult = storageRes['testResult'] as string | null;

      // Storage status
      storageEl.innerHTML = '';
      if (!storage) {
        storageEl.appendChild(
          el('div', { className: 'sync-storage-status' },
            badge('No storage configured', '#f87171'),
          ),
        );
      } else {
        const provider = String(storageRes['provider'] ?? 'unknown');
        const bucket = String(storageRes['bucket'] ?? '');
        const statusColor = testResult === 'ok' ? '#34d399' : testResult === 'error' ? '#f87171' : '#fbbf24';
        const statusLabel = testResult === 'ok' ? 'Connected' : testResult === 'error' ? 'Error' : 'Untested';

        storageEl.appendChild(
          el('div', { className: 'sync-card' },
            el('div', { className: 'sync-card-title' }, 'Storage'),
            el('div', { className: 'sync-card-row' },
              el('span', { className: 'sync-card-label' }, 'Provider'),
              el('span', null, provider),
            ),
            el('div', { className: 'sync-card-row' },
              el('span', { className: 'sync-card-label' }, 'Bucket'),
              el('span', null, bucket),
            ),
            el('div', { className: 'sync-card-row' },
              el('span', { className: 'sync-card-label' }, 'Status'),
              badge(statusLabel, statusColor),
            ),
          ),
        );
      }

      // Projects list
      projectsEl.innerHTML = '';
      if (projects.length === 0) {
        projectsEl.appendChild(el('div', { className: 'sync-empty' }, 'No projects configured.'));
        return;
      }

      const tableWrap = el('div', { className: 'sync-table-wrap' });
      const table = el('table', { className: 'sync-table' });
      const thead = el('thead');
      const headerRow = el('tr');
      for (const h of ['Name', 'Direction', 'Status', 'Last Sync']) {
        headerRow.appendChild(el('th', null, h));
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = el('tbody');
      for (const p of projects) {
        const row = el('tr');
        row.appendChild(el('td', { style: 'font-family: ui-monospace, monospace' }, String(p['name'] ?? '')));

        const dir = String(p['direction'] ?? 'push');
        const dirColor = dir === 'bidirectional' ? '#22d3ee' : dir === 'pull' ? '#a78bfa' : '#34d399';
        row.appendChild(el('td', null, badge(dir, dirColor)));

        const st = String(p['status'] ?? 'idle');
        const stColor = st === 'synced' ? '#34d399' : st === 'syncing' ? '#22d3ee' : st === 'error' ? '#f87171' : '#a1a1aa';
        row.appendChild(el('td', null, badge(st, stColor)));

        const lastSync = p['lastSync'] as string | null;
        row.appendChild(el('td', { style: 'color: #71717a' }, lastSync ? new Date(lastSync).toLocaleString() : 'Never'));

        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      projectsEl.appendChild(tableWrap);
    } catch (err: unknown) {
      if (cancelled) return;
      projectsEl.innerHTML = '';
      const errEl = el('div', { className: 'sync-error' }, String(err));
      const retryBtn = el('button', null, 'Retry');
      retryBtn.onclick = () => void refresh();
      errEl.appendChild(retryBtn);
      projectsEl.appendChild(errEl);
    }
  }

  void refresh();
  const interval = setInterval(() => void refresh(), 10_000);

  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function renderSettings(root: HTMLElement): () => void {
  root.innerHTML = '';
  const wrap = el('div', { className: 'sync-panel' });
  root.appendChild(wrap);

  wrap.appendChild(el('h1', null, 'Settings'));
  wrap.appendChild(el('p', { className: 'sub' }, 'Storage configuration and sync preferences'));

  const content = el('div');
  wrap.appendChild(content);

  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const storageRes = await apiFetch('/storage') as Record<string, unknown>;
      if (cancelled) return;

      content.innerHTML = '';

      if (!storageRes['configured']) {
        content.appendChild(
          el('div', { className: 'sync-empty' },
            'No storage configured. Use the API or Portlama panel to set up storage.',
          ),
        );
        return;
      }

      const card = el('div', { className: 'sync-card' });
      card.appendChild(el('div', { className: 'sync-card-title' }, 'Storage Configuration'));

      const fields: Array<[string, string]> = [
        ['Provider', String(storageRes['provider'] ?? '')],
        ['Bucket', String(storageRes['bucket'] ?? '')],
        ['Region', String(storageRes['region'] ?? 'default')],
        ['Endpoint', String(storageRes['endpoint'] ?? '')],
        ['Encryption', storageRes['encryption'] ? 'Enabled' : 'Disabled'],
      ];

      const lastTested = storageRes['lastTested'] as string | null;
      if (lastTested) {
        fields.push(['Last Tested', new Date(lastTested).toLocaleString()]);
      }

      const testResult = storageRes['testResult'] as string | null;
      if (testResult) {
        fields.push(['Test Result', testResult]);
      }

      for (const [label, value] of fields) {
        card.appendChild(
          el('div', { className: 'sync-card-row' },
            el('span', { className: 'sync-card-label' }, label),
            el('span', null, value),
          ),
        );
      }

      content.appendChild(card);
    } catch (err: unknown) {
      if (cancelled) return;
      content.innerHTML = '';
      const errEl = el('div', { className: 'sync-error' }, String(err));
      const retryBtn = el('button', null, 'Retry');
      retryBtn.onclick = () => void refresh();
      errEl.appendChild(retryBtn);
      content.appendChild(errEl);
    }
  }

  void refresh();
  return () => { cancelled = true; };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mount(ctx: PanelCtx): { unmount: () => void } {
  injectStyles();
  setApiBase(ctx);

  let cleanup: (() => void) | undefined;

  if (ctx.subPath === '/settings' || ctx.subPath === 'settings') {
    cleanup = renderSettings(ctx.mountPoint);
  } else {
    cleanup = renderConnections(ctx.mountPoint);
  }

  return {
    unmount: () => {
      cleanup?.();
      ctx.mountPoint.innerHTML = '';
    },
  };
}

// Register on global
(window as unknown as Record<string, unknown>).__portlamaPlugins =
  (window as unknown as Record<string, unknown>).__portlamaPlugins ?? {};
((window as unknown as Record<string, unknown>).__portlamaPlugins as Record<string, unknown>).sync = { mount };
