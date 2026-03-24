// ============================================================================
// Test Execution Tools — test_run, test_run_all, test_list, test_reset
// ============================================================================

import { z } from 'zod';
import path from 'node:path';
import { execa } from 'execa';
import * as mp from '../lib/multipass.js';
import { resolveTestChain, getTests, E2E_DEPS } from '../lib/deps.js';
import {
  createRun,
  writeTestResult,
  writeTestLog,
  writeSummary,
  extractErrors,
  buildCompactSummary,
} from '../lib/logs.js';
import { loadState, recordRun } from '../lib/state.js';
import { E2E_DIR, VM_HOST, VM_AGENT } from '../config.js';

/** Build environment variables for test scripts running on macOS. */
function buildTestEnv(state) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HOST_IP: state.hostIp || '',
    AGENT_IP: state.agentIp || '',
    BASE_URL: state.baseUrl || '',
    API_KEY: state.apiKey || '',
    CURL_TIMEOUT: '30',
    LOG_DIR: '/tmp',
  };
}

/** Run a test script from macOS, passing VM connection info via env vars. */
async function runTest(testFile, env) {
  const scriptPath = path.join(E2E_DIR, testFile);
  const startMs = Date.now();

  try {
    const result = await execa('bash', [scriptPath], {
      env,
      timeout: 300_000,
      all: true,
    });
    return {
      status: 'passed',
      durationMs: Date.now() - startMs,
      output: result.all || result.stdout,
      errors: [],
    };
  } catch (err) {
    const output = err.all || err.stderr || err.message;
    return {
      status: 'failed',
      durationMs: Date.now() - startMs,
      output,
      errors: extractErrors(output),
    };
  }
}

/** Finalize a test run: write summary, record in state, return MCP response. */
function finishRun(run, target, testResults, startMs) {
  const summary = {
    runId: run.id,
    target,
    passed: testResults.filter((t) => t.status === 'passed').length,
    failed: testResults.filter((t) => t.status === 'failed').length,
    skipped: 0,
    durationMs: Date.now() - startMs,
    tests: testResults,
  };

  writeSummary(run.runDir, summary);
  recordRun({ id: run.id, target, timestamp: new Date().toISOString() });

  return {
    content: [{ type: 'text', text: buildCompactSummary(summary) }],
  };
}

export const testRunTool = {
  name: 'test_run',
  description:
    'Run a specific E2E test by number, automatically resolving its dependencies. ' +
    'Tests execute from macOS and interact with the sync-host and sync-agent VMs. ' +
    'Returns a compact summary with pass/fail and error lines only — no full logs. ' +
    'Use test_log to fetch full output for a specific test if needed.',
  inputSchema: z.object({
    test: z.coerce.number().int().min(1).describe('Test number to run (e.g. 5 for push-sync)'),
    skipDeps: z.coerce
      .boolean()
      .default(false)
      .describe(
        'Skip dependency tests (use if you know prerequisites are met, e.g. from a snapshot)',
      ),
  }),
  async handler({ test, skipDeps } = {}) {
    skipDeps = skipDeps ?? false;
    const state = loadState();

    if (!state.hostIp || !state.agentIp) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'VMs not provisioned. Run provision_host and provision_agent first.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Resolve test chain
    const chain = resolveTestChain(test);
    const testsToRun = skipDeps ? chain.filter((t) => t.number === test) : chain;

    const env = buildTestEnv(state);
    const run = createRun();
    const startMs = Date.now();
    const testResults = [];

    for (const { number, file } of testsToRun) {
      const testName = file.replace('.sh', '');

      const result = await runTest(file, env);

      const testEntry = {
        number,
        name: testName,
        status: result.status,
        durationMs: result.durationMs,
        errors: result.errors,
      };

      testResults.push(testEntry);
      writeTestResult(run.testsDir, testName, testEntry);
      writeTestLog(run.logsDir, testName, result.output);

      // Stop on failure
      if (result.status === 'failed') break;
    }

    return finishRun(run, test, testResults, startMs);
  },
};

export const testRunAllTool = {
  name: 'test_run_all',
  description:
    'Run all E2E tests in sequence against the provisioned VMs. ' +
    'Returns a compact summary — errors only for failed tests.',
  inputSchema: z.object({
    stopOnFailure: z.coerce
      .boolean()
      .default(true)
      .describe('Stop running tests after the first failure (default: true)'),
  }),
  async handler({ stopOnFailure } = {}) {
    stopOnFailure = stopOnFailure ?? true;
    const state = loadState();

    if (!state.hostIp || !state.agentIp) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'VMs not provisioned. Run provision_host and provision_agent first.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const run = createRun();
    const startMs = Date.now();
    const allResults = [];
    const env = buildTestEnv(state);

    for (const [, file] of Object.entries(getTests()).sort(([a], [b]) => Number(a) - Number(b))) {
      const testName = file.replace('.sh', '');
      const result = await runTest(file, env);
      const entry = {
        name: testName,
        status: result.status,
        durationMs: result.durationMs,
        errors: result.errors,
      };
      allResults.push(entry);
      writeTestResult(run.testsDir, testName, entry);
      writeTestLog(run.logsDir, testName, result.output);

      if (stopOnFailure && result.status === 'failed') break;
    }

    return finishRun(run, 'all', allResults, startMs);
  },
};

export const testListTool = {
  name: 'test_list',
  description: 'List all available E2E tests with their dependency graph and filenames.',
  inputSchema: z.object({}),
  async handler() {
    const tests = Object.entries(getTests())
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([num, file]) => ({
        number: Number(num),
        file,
        deps: E2E_DEPS[Number(num)] || [],
      }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ tests }, null, 2) }],
    };
  },
};

export const testResetTool = {
  name: 'test_reset',
  description:
    'Clean up test artifacts on both VMs: remove test buckets, temp projects, ' +
    'rclone configs, and kill stray processes. Use between test runs for a clean state.',
  inputSchema: z.object({}),
  async handler() {
    const steps = [];

    // Clean up on host VM
    await mp.exec(VM_HOST, 'rm -rf /tmp/sync-e2e-* 2>/dev/null; echo done', {
      sudo: true,
      allowFailure: true,
    });
    steps.push('Cleaned test artifacts on sync-host');

    // Clean up on agent VM
    await mp.exec(
      VM_AGENT,
      'rm -rf /tmp/sync-e2e-* 2>/dev/null; pkill -f "sync-agent" 2>/dev/null || true; echo done',
      { sudo: true, allowFailure: true },
    );
    steps.push('Cleaned test artifacts and stray processes on sync-agent');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, steps }, null, 2),
        },
      ],
    };
  },
};
