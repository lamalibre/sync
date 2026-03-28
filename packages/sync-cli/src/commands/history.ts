import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import {
  renderTable,
  colorStatus,
  formatRelativeTime,
  formatDuration,
  formatBytes,
  jsonOutput,
} from '../lib/format.js';

// ---------------------------------------------------------------------------
// Types matching server response shapes
// ---------------------------------------------------------------------------

interface SyncOperation {
  id: string;
  projectId: string;
  type: 'sync' | 'archive' | 'restore';
  direction: string;
  trigger: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  bytesTransferred: number | null;
  filesTransferred: number | null;
  errors: number;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface HistoryOptions {
  json?: boolean;
  limit?: string;
  project?: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function historyCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: HistoryOptions,
): Promise<void> {
  const projectId = projectArg ?? opts.project;
  let limit = 20;
  if (opts.limit) {
    const parsed = parseInt(opts.limit, 10);
    if (isNaN(parsed)) {
      process.stderr.write(pc.red(`Invalid limit value: "${opts.limit}" is not a valid number.\n`));
      process.exit(1);
    }
    limit = parsed;
  }

  const queryParams = new URLSearchParams();
  if (projectId) queryParams.set('projectId', projectId);
  queryParams.set('limit', String(limit));

  const qs = queryParams.toString();
  const path = `/api/sync/history${qs ? `?${qs}` : ''}`;
  const res = await client.get<{ operations: SyncOperation[] }>(path);

  if (opts.json) {
    process.stdout.write(jsonOutput(res.operations) + '\n');
    return;
  }

  if (res.operations.length === 0) {
    process.stdout.write(
      pc.dim(
        projectId
          ? `\n  No operations found for project "${projectId}".\n\n`
          : '\n  No operation history.\n\n',
      ),
    );
    return;
  }

  const heading = projectId
    ? `History: ${projectId}`
    : 'Operation History';
  process.stdout.write(pc.bold(`\n${heading}\n\n`));

  const rows = res.operations.map((op) => ({
    project: op.projectId,
    type: op.type,
    trigger: op.trigger,
    status: colorStatus(op.status),
    duration: op.duration !== null ? formatDuration(op.duration) : pc.dim('--'),
    transferred: op.bytesTransferred !== null ? formatBytes(op.bytesTransferred) : pc.dim('--'),
    time: formatRelativeTime(op.startedAt),
  }));

  const table = renderTable(
    [
      { header: 'Project', key: 'project', width: 20 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Trigger', key: 'trigger', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Duration', key: 'duration', width: 10 },
      { header: 'Transferred', key: 'transferred', width: 12 },
      { header: 'When', key: 'time' },
    ],
    rows,
  );

  process.stdout.write(`${table}\n\n`);
}
