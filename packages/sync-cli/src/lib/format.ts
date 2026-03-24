import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Size formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i] ?? 'TB'}`;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

export function colorStatus(status: string): string {
  switch (status) {
    case 'synced':
      return pc.green(status);
    case 'syncing':
    case 'archiving':
    case 'restoring':
      return pc.cyan(status);
    case 'local-only':
      return pc.yellow(status);
    case 'cloud-only':
      return pc.blue(status);
    case 'archived':
      return pc.magenta(status);
    case 'error':
      return pc.red(status);
    case 'completed':
      return pc.green(status);
    case 'running':
      return pc.cyan(status);
    case 'pending':
      return pc.yellow(status);
    default:
      return pc.dim(status);
  }
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

interface Column {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right';
}

export function renderTable(columns: Column[], rows: Record<string, string>[]): string {
  // Calculate widths
  const widths = columns.map((col) => {
    const maxData = rows.reduce(
      (max, row) => Math.max(max, stripAnsi(row[col.key] ?? '').length),
      0,
    );
    return col.width ?? Math.max(col.header.length, maxData);
  });

  // Header
  const header = columns
    .map((col, i) => pc.bold(pad(col.header, widths[i]!, col.align ?? 'left')))
    .join('  ');

  // Separator
  const sep = widths.map((w) => pc.dim('-'.repeat(w))).join('  ');

  // Rows
  const lines = rows.map((row) =>
    columns.map((col, i) => pad(row[col.key] ?? '', widths[i]!, col.align ?? 'left')).join('  '),
  );

  return [header, sep, ...lines].join('\n');
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const len = stripAnsi(text).length;
  const padding = Math.max(0, width - len);
  if (align === 'right') {
    return ' '.repeat(padding) + text;
  }
  return text + ' '.repeat(padding);
}

/** Strip ANSI escape codes for width calculation. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

export function jsonOutput(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
