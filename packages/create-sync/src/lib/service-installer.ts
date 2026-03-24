import * as p from '@clack/prompts';
import pc from 'picocolors';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execa } from 'execa';
import { atomicWriteFile } from '@lamalibre/sync-shared';

// ---------------------------------------------------------------------------
// Service installation
// ---------------------------------------------------------------------------

export async function installService(serverUrl: string, apiKey: string): Promise<boolean> {
  const os = platform();
  const agentDir = join(homedir(), '.sync-agent');

  // Write agent settings (including API key) to the agent settings file
  // instead of embedding credentials in service environment variables.
  await writeAgentSettingsFile(agentDir, serverUrl, apiKey);

  if (os === 'darwin') {
    return installLaunchd(agentDir);
  } else if (os === 'linux') {
    return installSystemd(agentDir);
  } else {
    p.log.warn(`Automatic service installation is not supported on ${os}.`);
    p.log.info(
      'You can run the sync-agent manually or create a service configuration for your OS.',
    );
    return false;
  }
}

/**
 * Write agent settings to the agent settings file.
 * The API key is stored here rather than in service environment variables
 * to avoid credential exposure in process listings and service files.
 */
async function writeAgentSettingsFile(
  agentDir: string,
  serverUrl: string,
  apiKey: string,
): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(agentDir, 'agent-settings.json');
  const settings = {
    serverUrl,
    apiKey,
    pollIntervalMs: 30_000,
  };
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 0o600);
}

// ---------------------------------------------------------------------------
// macOS launchd
// ---------------------------------------------------------------------------

async function installLaunchd(agentDir: string): Promise<boolean> {
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, 'com.lamalibre.sync-agent.plist');

  // Find sync-agent binary
  const agentBin = await findAgentBinary();
  if (!agentBin) {
    p.log.error(
      'Could not locate sync-agent binary. Make sure @lamalibre/sync-agent is installed.',
    );
    return false;
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lamalibre.sync-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(process.execPath)}</string>
        <string>${escapeXml(agentBin)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>SYNC_AGENT_DIR</key>
        <string>${escapeXml(agentDir)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(agentDir, 'agent.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(agentDir, 'agent.err'))}</string>
</dict>
</plist>`;

  const spinner = p.spinner();
  spinner.start('Installing launchd service...');

  try {
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(plistPath, plistContent, { mode: 0o600 });
    await execa('launchctl', ['load', plistPath]);
    spinner.stop(pc.green('launchd service installed and started.'));
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    spinner.stop(pc.red('Failed to install launchd service'));
    p.log.error(msg);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux systemd
// ---------------------------------------------------------------------------

async function installSystemd(agentDir: string): Promise<boolean> {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, 'sync-agent.service');

  const agentBin = await findAgentBinary();
  if (!agentBin) {
    p.log.error(
      'Could not locate sync-agent binary. Make sure @lamalibre/sync-agent is installed.',
    );
    return false;
  }

  const unitContent = `[Unit]
Description=Sync Agent - File synchronization daemon
After=network.target

[Service]
Type=simple
ExecStart="${escapeSystemd(process.execPath)}" "${escapeSystemd(agentBin)}"
Environment="SYNC_AGENT_DIR=${escapeSystemd(agentDir)}"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

  const spinner = p.spinner();
  spinner.start('Installing systemd user service...');

  try {
    await mkdir(unitDir, { recursive: true });
    await writeFile(unitPath, unitContent, { mode: 0o600 });
    await execa('systemctl', ['--user', 'daemon-reload']);
    await execa('systemctl', ['--user', 'enable', 'sync-agent']);
    await execa('systemctl', ['--user', 'start', 'sync-agent']);
    spinner.stop(pc.green('systemd service installed and started.'));
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    spinner.stop(pc.red('Failed to install systemd service'));
    p.log.error(msg);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe inclusion in XML/plist content. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a string for safe inclusion in systemd unit files. */
function escapeSystemd(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$')
    .replace(/[\r\n]/g, '')
    .replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findAgentBinary(): Promise<string | null> {
  // Try common locations
  try {
    const result = await execa('which', ['sync-agent']);
    if (result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // not in PATH
  }

  // Try to resolve via npm/pnpm
  try {
    const result = await execa('npm', ['bin', '-g']);
    const globalBin = result.stdout.trim();
    const { access } = await import('node:fs/promises');
    const binPath = join(globalBin, 'sync-agent');
    await access(binPath);
    return binPath;
  } catch {
    // not found
  }

  // Try npx resolution
  try {
    const result = await execa('npx', ['--yes', 'which', 'sync-agent']);
    if (result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // not found
  }

  return null;
}
