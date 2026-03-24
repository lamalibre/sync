// ============================================================================
// Multipass CLI Wrapper
// ============================================================================
// All VM operations go through multipass with execa (array arguments only).
// Returns structured { stdout, stderr, exitCode } for every operation.

import { execa } from 'execa';
import fs from 'node:fs';

/**
 * Resolve the multipass binary path.
 * MCP server processes inherit a minimal PATH, so we check common locations.
 */
let _multipassBin = null;
function getMultipassBin() {
  if (_multipassBin) return _multipassBin;

  // Check absolute paths first (MCP subprocesses may have minimal PATH)
  const absoluteCandidates = [
    '/usr/local/bin/multipass',
    '/opt/homebrew/bin/multipass',
    '/snap/bin/multipass',
    '/usr/bin/multipass',
  ];

  for (const bin of absoluteCandidates) {
    if (fs.existsSync(bin)) {
      _multipassBin = bin;
      return bin;
    }
  }

  // Fall back to bare name (relies on PATH)
  _multipassBin = 'multipass';
  return _multipassBin;
}

/**
 * Run a multipass command with standardized error handling.
 * @param {string[]} args — multipass subcommand + arguments
 * @param {object} [options]
 * @param {boolean} [options.allowFailure=false] — return result instead of throwing
 * @param {number} [options.timeout=60000] — timeout in ms
 */
export async function run(args, { allowFailure = false, timeout = 60_000 } = {}) {
  const bin = getMultipassBin();
  // Ensure common bin directories are on PATH (MCP subprocesses may have minimal PATH)
  const extendedPath = [
    process.env.PATH,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/snap/bin',
  ]
    .filter(Boolean)
    .join(':');
  try {
    const result = await execa(bin, args, { timeout, env: { ...process.env, PATH: extendedPath } });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err) {
    const out = {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.exitCode ?? 1,
    };
    if (allowFailure) return out;
    throw new Error(`multipass ${args[0]} failed (exit ${out.exitCode}): ${out.stderr}`);
  }
}

/** Launch a new VM with the given specs. */
export async function launch(name, { cpus = 1, memory = '512M', disk = '10G' } = {}) {
  return run(
    ['launch', '--name', name, '--cpus', String(cpus), '--memory', memory, '--disk', disk, '24.04'],
    { timeout: 300_000 },
  );
}

/** Delete a VM and purge its disk. */
export async function deleteVm(name) {
  await run(['delete', name], { allowFailure: true });
  await run(['purge'], { allowFailure: true, timeout: 30_000 });
}

/** Get VM info as parsed JSON. Returns null if VM doesn't exist. */
export async function info(name) {
  const result = await run(['info', name, '--format', 'json'], { allowFailure: true });
  if (result.exitCode !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** Get the IPv4 address of a VM. Returns null if unavailable. */
export async function getIp(name) {
  const data = await info(name);
  return data?.info?.[name]?.ipv4?.[0] || null;
}

/** List all VMs as parsed JSON. */
export async function list() {
  const result = await run(['list', '--format', 'json'], { allowFailure: true });
  if (result.exitCode !== 0) return { list: [] };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { list: [] };
  }
}

/**
 * Execute a command on a VM.
 * @param {string} vmName — target VM
 * @param {string|string[]} command — command to execute
 * @param {object} [options]
 * @param {boolean} [options.sudo=false] — prefix with sudo
 * @param {boolean} [options.allowFailure=false]
 * @param {number} [options.timeout=120000]
 */
export async function exec(
  vmName,
  command,
  { sudo = false, allowFailure = false, timeout = 120_000 } = {},
) {
  const cmdStr = Array.isArray(command) ? command.join(' ') : command;
  const fullCmd = sudo ? `sudo bash -c '${cmdStr.replace(/'/g, "'\\''")}'` : cmdStr;

  return run(['exec', vmName, '--', 'bash', '-c', fullCmd], { allowFailure, timeout });
}

/** Transfer a file from the host to a VM. */
export async function transfer(localPath, vmDest) {
  return run(['transfer', localPath, vmDest], { timeout: 60_000 });
}

/** Transfer a file from a VM to the host. */
export async function transferFrom(vmSource, localPath) {
  return run(['transfer', vmSource, localPath], { timeout: 60_000 });
}

/** Create a snapshot of a VM. */
export async function snapshot(vmName, snapshotName) {
  return run(['snapshot', vmName, '--name', snapshotName], { timeout: 120_000 });
}

/** Restore a VM to a named snapshot. */
export async function restore(vmName, snapshotName) {
  return run(['restore', `${vmName}.${snapshotName}`, '--destructive'], { timeout: 120_000 });
}

/** List snapshots for a VM. Returns array of snapshot names. */
export async function listSnapshots(vmName) {
  const result = await run(['list', '--snapshots', '--format', 'json'], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  try {
    const data = JSON.parse(result.stdout);
    // multipass puts snapshots under "info", not "snapshots"
    const vmSnapshots = data?.info?.[vmName] || {};
    return Object.keys(vmSnapshots);
  } catch {
    return [];
  }
}

/** Delete a specific snapshot. */
export async function deleteSnapshot(vmName, snapshotName) {
  return run(['delete', vmName, '--snap', snapshotName], { allowFailure: true });
}

/** Check if multipass is installed and the daemon is running. */
export async function isAvailable() {
  const result = await run(['version'], { allowFailure: true, timeout: 10_000 });
  return result.exitCode === 0;
}
