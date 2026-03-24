import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import {
  renderTable,
  colorStatus,
  formatRelativeTime,
  formatBytes,
  jsonOutput,
} from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface GlobalStatus {
  storageConfigured: boolean;
  provider: string | null;
  projects: number;
  activeOperations: number;
  totalArchived: number;
  savedLocally: number;
}

interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(client: ApiClient, opts: StatusOptions): Promise<void> {
  const [globalStatus, projectsRes] = await Promise.all([
    client.get<GlobalStatus>('/api/sync/status'),
    client.get<{ projects: Project[] }>('/api/sync/projects'),
  ]);

  if (opts.json) {
    process.stdout.write(
      jsonOutput({ status: globalStatus, projects: projectsRes.projects }) + '\n',
    );
    return;
  }

  // Global status header
  process.stdout.write(pc.bold('\nSync Status\n\n'));

  const storageLabel = globalStatus.storageConfigured
    ? pc.green(`${globalStatus.provider ?? 'configured'}`)
    : pc.red('not configured');

  process.stdout.write(
    `  Storage:    ${storageLabel}\n` +
      `  Projects:   ${globalStatus.projects}\n` +
      `  Active ops: ${globalStatus.activeOperations}\n`,
  );

  if (globalStatus.savedLocally > 0) {
    process.stdout.write(`  Saved:      ${formatBytes(globalStatus.savedLocally)} (archived)\n`);
  }

  process.stdout.write('\n');

  // Project table
  if (projectsRes.projects.length === 0) {
    process.stdout.write(
      pc.dim('  No projects configured. Use the installer or API to add one.\n\n'),
    );
    return;
  }

  const rows = projectsRes.projects.map((p) => ({
    name: p.name,
    direction: p.direction,
    status: colorStatus(p.status),
    lastSync: p.lastSync ? formatRelativeTime(p.lastSync) : pc.dim('never'),
    path: pc.dim(p.localPath),
  }));

  const table = renderTable(
    [
      { header: 'Project', key: 'name', width: 20 },
      { header: 'Direction', key: 'direction', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Last Sync', key: 'lastSync', width: 12 },
      { header: 'Path', key: 'path' },
    ],
    rows,
  );

  process.stdout.write(`${table}\n\n`);
}
