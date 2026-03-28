import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { formatDuration, jsonOutput } from '../lib/format.js';

// ---------------------------------------------------------------------------
// Types matching server response shapes
// ---------------------------------------------------------------------------

interface HealthResponse {
  ok: boolean;
  uptime: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface HealthOptions {
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function healthCommand(
  client: ApiClient,
  opts: HealthOptions,
): Promise<void> {
  const res = await client.get<HealthResponse>('/api/sync/health');

  if (opts.json) {
    process.stdout.write(jsonOutput(res) + '\n');
    return;
  }

  process.stdout.write(pc.bold('\nServer Health\n\n'));

  const statusLabel = res.ok ? pc.green('healthy') : pc.red('unhealthy');

  process.stdout.write(
    `  Status:     ${statusLabel}\n` +
      `  Uptime:     ${formatDuration(Math.floor(res.uptime))}\n` +
      `  Timestamp:  ${res.timestamp}\n\n`,
  );
}
