// ============================================================================
// E2E MCP — Configuration & Constants
// ============================================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Root of the sync repository. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** E2E test directory. */
export const E2E_DIR = path.join(REPO_ROOT, 'tests', 'e2e');

/** E2E logs directory (committed). */
export const E2E_LOGS_DIR = path.join(REPO_ROOT, 'e2e-logs');

/** Temp directory for intermediate run data. */
export const TEMP_DIR = '/tmp/sync-e2e';

/** Default server port. */
export const DEFAULT_PORT = 9393;

/** VM names. */
export const VM_HOST = 'sync-host';
export const VM_AGENT = 'sync-agent';
export const ALL_VMS = [VM_HOST, VM_AGENT];

/** VM short-name → full multipass name mapping. */
export const VM_NAME_MAP = { host: VM_HOST, agent: VM_AGENT };

/** VM profiles — resource allocation tiers. */
export const PROFILES = {
  production: {
    description: 'Minimal resources — final publishable runs only',
    cpus: 1,
    memory: '512M',
    disk: '10G',
  },
  development: {
    description: 'Fast iteration — comfortable resources for development',
    cpus: 2,
    memory: '2G',
    disk: '10G',
  },
  performance: {
    description: 'Heavy lifting — fast builds, parallel tests',
    cpus: 4,
    memory: '4G',
    disk: '20G',
  },
};

/** Snapshot checkpoints — named save-points in the VM lifecycle. */
export const CHECKPOINTS = {
  'post-create': 'VMs exist but no setup has run',
  'post-setup': 'Both VMs provisioned, server running, agent registered',
};
