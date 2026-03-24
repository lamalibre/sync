// ============================================================================
// Provisioning Tools — provision_host, provision_agent, hot_reload
// ============================================================================

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import * as mp from '../lib/multipass.js';
import { updateState, loadState } from '../lib/state.js';
import { VM_HOST, VM_AGENT, REPO_ROOT, E2E_DIR, DEFAULT_PORT } from '../config.js';

/** Pack the entire sync monorepo into a tarball for transfer. */
async function packProject() {
  const tarball = '/tmp/sync-project.tar.gz';
  // Tar up the repo, excluding node_modules, dist, .git, and other build artifacts
  await execa(
    'tar',
    [
      'czf',
      tarball,
      '--exclude',
      'node_modules',
      '--exclude',
      '.git',
      '--exclude',
      'dist',
      '--exclude',
      '.turbo',
      '-C',
      path.dirname(REPO_ROOT),
      path.basename(REPO_ROOT),
    ],
    { timeout: 60_000 },
  );
  return tarball;
}

/** Transfer all .sh test scripts to a VM at /tmp/e2e/. */
async function transferTestScripts(vmName) {
  // Create directory as ubuntu user (multipass transfers as ubuntu, not root)
  await mp.exec(vmName, 'mkdir -p /tmp/e2e && chmod 777 /tmp/e2e', { sudo: true });
  const files = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.sh'));
  for (const file of files) {
    await mp.transfer(path.join(E2E_DIR, file), `${vmName}:/tmp/e2e/${file}`);
  }
  // Make scripts executable
  await mp.exec(vmName, 'chmod +x /tmp/e2e/*.sh', { sudo: true });
}

export const provisionHostTool = {
  name: 'provision_host',
  description:
    'Full provisioning pipeline for the sync-host VM. ' +
    'Installs Node.js, pnpm, rclone, transfers the project, builds it, ' +
    'and starts the sync-server. Returns the server base URL.',
  inputSchema: z.object({
    port: z.coerce
      .number()
      .int()
      .default(DEFAULT_PORT)
      .describe('Port for sync-server (default: 9393)'),
  }),
  async handler({ port } = {}) {
    port = port || DEFAULT_PORT;
    const steps = [];

    try {
      // 1. Install Node.js 22 LTS (idempotent — skips if >= 22 already present)
      steps.push('Installing Node.js 22...');
      await mp.exec(
        VM_HOST,
        'node -v 2>/dev/null | grep -qE "^v(2[2-9]|[3-9])" || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)',
        {
          sudo: true,
          timeout: 120_000,
        },
      );

      // 2. Install pnpm (idempotent)
      steps.push('Installing pnpm...');
      await mp.exec(VM_HOST, 'which pnpm || npm install -g pnpm', { sudo: true, timeout: 60_000 });

      // 3. Install rclone (idempotent)
      steps.push('Installing rclone...');
      await mp.exec(VM_HOST, 'which rclone || (curl -fsSL https://rclone.org/install.sh | bash)', {
        sudo: true,
        timeout: 120_000,
      });

      // 4. Install jq and curl (should be present on Ubuntu but ensure)
      await mp.exec(VM_HOST, 'apt-get install -y jq curl', {
        sudo: true,
        timeout: 60_000,
      });

      // 5. Pack and transfer project
      steps.push('Transferring project to VM...');
      const tarball = await packProject();
      await mp.transfer(tarball, `${VM_HOST}:/tmp/sync-project.tar.gz`);
      await mp.exec(
        VM_HOST,
        'rm -rf /opt/sync && mkdir -p /opt/sync && tar xzf /tmp/sync-project.tar.gz -C /opt/sync --strip-components=1',
        {
          sudo: true,
          timeout: 60_000,
        },
      );

      // 6. Install dependencies and build
      steps.push('Installing dependencies and building...');
      await mp.exec(VM_HOST, 'cd /opt/sync && pnpm install && pnpm build', {
        sudo: true,
        timeout: 300_000,
      });

      // 7. Transfer test scripts
      steps.push('Transferring test scripts...');
      await transferTestScripts(VM_HOST);

      // 8. Run setup-host.sh
      steps.push('Running host setup...');
      const hostIp = await mp.getIp(VM_HOST);
      const setupResult = await mp.exec(VM_HOST, `bash /tmp/e2e/setup-host.sh ${port}`, {
        sudo: true,
        timeout: 120_000,
        allowFailure: true,
      });

      if (setupResult.exitCode !== 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: false,
                  steps,
                  error: 'setup-host.sh failed',
                  stdout: setupResult.stdout,
                  stderr: setupResult.stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Extract API key from credentials file
      const credsResult = await mp.exec(VM_HOST, 'cat /tmp/sync-e2e-credentials.json', {
        sudo: true,
        allowFailure: true,
      });
      let apiKey = '';
      try {
        const creds = JSON.parse(credsResult.stdout);
        apiKey = creds.apiKey || '';
      } catch {
        // credentials file may not exist if setup didn't generate one
      }

      const baseUrl = `http://${hostIp}:${port}`;
      updateState({ hostIp, baseUrl, port, apiKey });
      steps.push(`Server running at ${baseUrl}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                hostIp,
                baseUrl,
                port,
                steps,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                steps,
                error: err.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  },
};

export const provisionAgentTool = {
  name: 'provision_agent',
  description:
    'Full provisioning pipeline for the sync-agent VM. ' +
    'Installs Node.js, rclone, transfers the project, builds it, ' +
    'configures the agent to connect to sync-host, and starts the agent daemon. ' +
    'Requires provision_host to have run first.',
  inputSchema: z.object({}),
  async handler() {
    const state = loadState();
    const steps = [];

    if (!state.hostIp) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'Host not provisioned yet. Run provision_host first.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    try {
      // 1. Install Node.js 22 LTS (idempotent — skips if >= 22 already present)
      steps.push('Installing Node.js 22...');
      await mp.exec(
        VM_AGENT,
        'node -v 2>/dev/null | grep -qE "^v(2[2-9]|[3-9])" || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)',
        {
          sudo: true,
          timeout: 120_000,
        },
      );

      // 2. Install pnpm (idempotent)
      steps.push('Installing pnpm...');
      await mp.exec(VM_AGENT, 'which pnpm || npm install -g pnpm', { sudo: true, timeout: 60_000 });

      // 3. Install rclone (idempotent)
      steps.push('Installing rclone...');
      await mp.exec(VM_AGENT, 'which rclone || (curl -fsSL https://rclone.org/install.sh | bash)', {
        sudo: true,
        timeout: 120_000,
      });

      // 4. Install jq and curl
      await mp.exec(VM_AGENT, 'apt-get install -y jq curl', {
        sudo: true,
        timeout: 60_000,
      });

      // 5. Pack and transfer project
      steps.push('Transferring project to VM...');
      const tarball = '/tmp/sync-project.tar.gz';
      // Reuse existing tarball if it exists, otherwise pack again
      if (!fs.existsSync(tarball)) {
        await packProject();
      }
      await mp.transfer(tarball, `${VM_AGENT}:/tmp/sync-project.tar.gz`);
      await mp.exec(
        VM_AGENT,
        'rm -rf /opt/sync && mkdir -p /opt/sync && tar xzf /tmp/sync-project.tar.gz -C /opt/sync --strip-components=1',
        {
          sudo: true,
          timeout: 60_000,
        },
      );

      // 6. Install dependencies and build
      steps.push('Installing dependencies and building...');
      await mp.exec(VM_AGENT, 'cd /opt/sync && pnpm install && pnpm build', {
        sudo: true,
        timeout: 300_000,
      });

      // 7. Transfer test scripts
      steps.push('Transferring test scripts...');
      await transferTestScripts(VM_AGENT);

      // 8. Run setup-agent.sh
      steps.push('Running agent setup...');
      const agentIp = await mp.getIp(VM_AGENT);
      const apiKey = state.apiKey || 'e2e-test-key';
      const setupResult = await mp.exec(
        VM_AGENT,
        `bash /tmp/e2e/setup-agent.sh ${state.hostIp} ${state.port || DEFAULT_PORT} ${apiKey}`,
        { sudo: true, timeout: 120_000, allowFailure: true },
      );

      if (setupResult.exitCode !== 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: false,
                  steps,
                  error: 'setup-agent.sh failed',
                  stdout: setupResult.stdout,
                  stderr: setupResult.stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      updateState({ agentIp });
      steps.push(`Agent running on ${agentIp}, connected to ${state.baseUrl}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                agentIp,
                hostIp: state.hostIp,
                baseUrl: state.baseUrl,
                steps,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                steps,
                error: err.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  },
};

export const hotReloadTool = {
  name: 'hot_reload',
  description:
    'Re-pack and redeploy the sync project to a VM without full reprovisioning. ' +
    'Transfers the updated project, rebuilds, and restarts the relevant service. ' +
    'Much faster than full provision for code iteration.',
  inputSchema: z.object({
    vm: z.enum(['host', 'agent']).describe('Target VM to redeploy'),
  }),
  async handler({ vm } = {}) {
    const vmName = vm === 'host' ? VM_HOST : VM_AGENT;
    const steps = [];

    try {
      // Pack and transfer
      steps.push('Packing project...');
      const tarball = await packProject();

      steps.push('Transferring to VM...');
      await mp.transfer(tarball, `${vmName}:/tmp/sync-project.tar.gz`);
      await mp.exec(
        vmName,
        'rm -rf /opt/sync && mkdir -p /opt/sync && tar xzf /tmp/sync-project.tar.gz -C /opt/sync --strip-components=1',
        {
          sudo: true,
          timeout: 60_000,
        },
      );

      // Rebuild
      steps.push('Rebuilding...');
      await mp.exec(vmName, 'cd /opt/sync && pnpm install && pnpm build', {
        sudo: true,
        timeout: 300_000,
      });

      // Restart service
      if (vm === 'host') {
        steps.push('Restarting sync-server...');
        await mp.exec(vmName, 'systemctl restart sync-server', {
          sudo: true,
          allowFailure: true,
          timeout: 30_000,
        });
      } else {
        steps.push('Restarting sync-agent...');
        await mp.exec(vmName, 'systemctl restart sync-agent', {
          sudo: true,
          allowFailure: true,
          timeout: 30_000,
        });
      }

      steps.push('Done');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, vm: vmName, steps }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, steps, error: err.message }, null, 2),
          },
        ],
      };
    }
  },
};
