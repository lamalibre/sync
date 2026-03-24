// ============================================================================
// Status & Log Inspection Tools — env_status, test_log, prereq_check
// ============================================================================

import { z } from 'zod';
import { execa } from 'execa';
import * as mp from '../lib/multipass.js';
import { loadState } from '../lib/state.js';
import { readTestLog, readSummary, listRuns } from '../lib/logs.js';
import { ALL_VMS, VM_HOST } from '../config.js';

export const envStatusTool = {
  name: 'env_status',
  description:
    'Full environment health check: are VMs running? Is the server healthy? ' +
    'Is the agent registered? Are prerequisites installed? Last test run result?',
  inputSchema: z.object({}),
  async handler() {
    const state = loadState();

    // Query VM info in parallel
    const vmInfos = await Promise.all(
      ALL_VMS.map(async (vmName) => [vmName, await mp.info(vmName)]),
    );

    // Build VM status map
    const vms = {};
    for (const [vmName, vmInfo] of vmInfos) {
      if (vmInfo?.info?.[vmName]) {
        const info = vmInfo.info[vmName];
        vms[vmName] = {
          state: info.state,
          ipv4: info.ipv4?.[0] || null,
          cpus: info.cpu_count,
          memory: info.memory?.total ? `${Math.round(info.memory.total / (1024 * 1024))}M` : null,
        };
      } else {
        vms[vmName] = { state: 'not-found' };
      }
    }

    // Check server health on host VM
    let serverHealthy = false;
    if (vms[VM_HOST]?.state === 'Running' && state.baseUrl) {
      try {
        const result = await execa('curl', [
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '--max-time',
          '3',
          `${state.baseUrl}/api/sync/health`,
        ]);
        serverHealthy = result.stdout.trim() === '200';
      } catch {
        serverHealthy = false;
      }
    }

    // Check agent status by querying the server's agent list
    let agentRegistered = false;
    if (serverHealthy && state.apiKey) {
      try {
        const result = await execa('curl', [
          '-s',
          '--max-time',
          '3',
          '-H',
          `Authorization: Bearer ${state.apiKey}`,
          `${state.baseUrl}/api/sync/agents`,
        ]);
        const data = JSON.parse(result.stdout);
        agentRegistered = (data.agents?.length || 0) > 0;
      } catch {
        agentRegistered = false;
      }
    }

    // Check multipass availability
    const multipassAvailable = await mp.isAvailable();

    // Last run
    const runs = listRuns();
    let lastRun = null;
    if (runs.length > 0) {
      lastRun = readSummary(runs[0]);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              vms,
              server: {
                baseUrl: state.baseUrl,
                healthy: serverHealthy,
              },
              agent: {
                registered: agentRegistered,
              },
              multipassAvailable,
              lastRun: lastRun
                ? {
                    id: lastRun.runId,
                    passed: lastRun.passed,
                    failed: lastRun.failed,
                    durationMs: lastRun.durationMs,
                  }
                : null,
              totalRuns: state.runs?.length || 0,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const testLogTool = {
  name: 'test_log',
  description:
    'Fetch the full raw log output for a specific test from an intermediate run. ' +
    'Use this after test_run shows a failure and you need the complete output to debug.',
  inputSchema: z.object({
    testName: z.string().describe('Test name (e.g. "01-server-health", "05-push-sync")'),
    runId: z.string().optional().describe('Run ID (default: most recent run)'),
  }),
  async handler({ testName, runId } = {}) {
    const targetRunId = runId || listRuns()[0];
    if (!targetRunId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'No test runs found',
            }),
          },
        ],
      };
    }

    const log = readTestLog(targetRunId, testName);
    if (!log) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: `No log found for test "${testName}" in run "${targetRunId}"`,
              availableRuns: listRuns().slice(0, 5),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: log,
        },
      ],
    };
  },
};

export const prereqCheckTool = {
  name: 'prereq_check',
  description:
    'Verify all prerequisites for running E2E tests: ' +
    'multipass, curl, jq, Node.js >= 20. Returns detailed status for each.',
  inputSchema: z.object({}),
  async handler() {
    const results = {};
    let allOk = true;

    // Check Node.js
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    results.node = {
      installed: true,
      version: nodeVersion,
      ok: nodeMajor >= 20,
    };
    if (!results.node.ok) allOk = false;

    // Check multipass
    const mpAvailable = await mp.isAvailable();
    results.multipass = { installed: mpAvailable, ok: mpAvailable };
    if (!mpAvailable) allOk = false;

    // Check host-side tools (curl, jq — needed to run tests from macOS)
    // MCP processes may have a minimal PATH, so also check common locations
    const commonPaths = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    for (const cmd of ['curl', 'jq']) {
      let found = false;
      try {
        await execa('which', [cmd]);
        found = true;
      } catch {
        // Try common paths directly
        const { default: fs } = await import('node:fs');
        for (const dir of commonPaths) {
          if (fs.existsSync(`${dir}/${cmd}`)) {
            found = true;
            break;
          }
        }
      }
      results[cmd] = { installed: found, ok: found };
      if (!found) allOk = false;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ allOk, prerequisites: results }, null, 2),
        },
      ],
    };
  },
};
