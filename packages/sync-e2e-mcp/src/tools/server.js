// ============================================================================
// Server Lifecycle Tools — server_start, server_stop, server_status
// ============================================================================

import { z } from 'zod';
import { execa } from 'execa';
import { loadState, updateState } from '../lib/state.js';
import { REPO_ROOT, DEFAULT_PORT, DEFAULT_BASE_URL } from '../config.js';

/** Check if a process with the given PID is still alive. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the server to respond to health checks. */
async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await execa('curl', [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '2',
        `${baseUrl}/api/sync/health`,
      ]);
      if (result.stdout.trim() === '200') return true;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export const serverStartTool = {
  name: 'server_start',
  description:
    'Build and start the sync-server in the background for E2E testing. ' +
    'Builds all packages first, then starts the server on the configured port. ' +
    'Returns the server PID and base URL.',
  inputSchema: z.object({
    port: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(DEFAULT_PORT)
      .describe('Port for the sync server (default: 9393)'),
  }),
  async handler({ port } = {}) {
    port = port || DEFAULT_PORT;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Check if server is already running
    const state = loadState();
    if (state.serverPid && isProcessAlive(state.serverPid)) {
      // Verify it's actually responding
      const healthy = await waitForHealth(baseUrl, 3000);
      if (healthy) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: true,
                  alreadyRunning: true,
                  pid: state.serverPid,
                  baseUrl,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Stale PID — kill it
      try {
        process.kill(state.serverPid, 'SIGTERM');
      } catch {
        /* already dead */
      }
    }

    // Build all packages first
    try {
      await execa('pnpm', ['build'], {
        cwd: REPO_ROOT,
        timeout: 120_000,
      });
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'Build failed',
                details: err.stderr || err.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Start the server as a detached background process
    const serverBin = 'packages/sync-server/bin/sync-server.mjs';
    const child = execa('node', [serverBin], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SYNC_PORT: String(port),
        NODE_ENV: 'development',
      },
      detached: true,
      stdio: 'ignore',
    });

    // Unref so this MCP server process can exit independently
    child.unref();

    const pid = child.pid;

    // Wait for server to become healthy
    const healthy = await waitForHealth(baseUrl, 15_000);

    if (!healthy) {
      // Try to kill the unhealthy process
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'Server started but did not become healthy within 15s',
                pid,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    updateState({ serverPid: pid, baseUrl });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              pid,
              baseUrl,
              port,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const serverStopTool = {
  name: 'server_stop',
  description:
    'Stop the running sync-server process. ' + 'Sends SIGTERM and waits for graceful shutdown.',
  inputSchema: z.object({}),
  async handler() {
    const state = loadState();

    if (!state.serverPid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, message: 'No server PID tracked' }, null, 2),
          },
        ],
      };
    }

    const pid = state.serverPid;

    if (!isProcessAlive(pid)) {
      updateState({ serverPid: null });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: true, message: `Server (PID ${pid}) already stopped` },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Send SIGTERM for graceful shutdown
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }

    // Wait up to 5s for process to exit
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (!isProcessAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Force kill if still alive
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }

    updateState({ serverPid: null });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, message: `Server (PID ${pid}) stopped` }, null, 2),
        },
      ],
    };
  },
};

export const serverStatusTool = {
  name: 'server_status',
  description:
    'Check if the sync-server is running and healthy. ' +
    'Returns PID, health check result, and base URL.',
  inputSchema: z.object({}),
  async handler() {
    const state = loadState();
    const baseUrl = state.baseUrl || DEFAULT_BASE_URL;

    const result = {
      pid: state.serverPid,
      processAlive: state.serverPid ? isProcessAlive(state.serverPid) : false,
      healthy: false,
      baseUrl,
    };

    if (result.processAlive) {
      result.healthy = await waitForHealth(baseUrl, 3000);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
