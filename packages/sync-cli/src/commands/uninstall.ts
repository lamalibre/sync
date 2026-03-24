import * as p from '@clack/prompts';
import pc from 'picocolors';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platform } from 'node:os';

interface UninstallOptions {
  yes?: boolean;
  json?: boolean;
}

export async function uninstallCommand(opts: UninstallOptions): Promise<void> {
  const steps: string[] = [];

  if (!opts.yes && !opts.json) {
    p.intro(pc.red('Uninstall Sync'));

    const confirmed = await p.confirm({
      message: 'This will remove the sync agent service, CLI config, and agent data. Continue?',
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const os = platform();

  // 1. Stop and remove system service
  try {
    if (os === 'darwin') {
      const plistPath = join(
        homedir(),
        'Library',
        'LaunchAgents',
        'com.lamalibre.sync-agent.plist',
      );
      const { execa } = await import('execa');
      await execa('launchctl', ['unload', plistPath]).catch(() => {
        // Service may not be loaded
      });
      await rm(plistPath, { force: true });
      steps.push('Removed launchd service');
    } else if (os === 'linux') {
      const { execa } = await import('execa');
      await execa('systemctl', ['--user', 'stop', 'sync-agent']).catch(() => {});
      await execa('systemctl', ['--user', 'disable', 'sync-agent']).catch(() => {});
      const unitPath = join(homedir(), '.config', 'systemd', 'user', 'sync-agent.service');
      await rm(unitPath, { force: true });
      await execa('systemctl', ['--user', 'daemon-reload']).catch(() => {});
      steps.push('Removed systemd service');
    }
  } catch {
    steps.push('Service removal: skipped (not found or permission denied)');
  }

  // 2. Remove agent data directory
  const agentDir = join(homedir(), '.sync-agent');
  try {
    await rm(agentDir, { recursive: true, force: true });
    steps.push(`Removed ${agentDir}`);
  } catch {
    steps.push(`Could not remove ${agentDir}`);
  }

  // 3. Remove CLI config
  const cliConfigDir = join(homedir(), '.sync-cli');
  try {
    await rm(cliConfigDir, { recursive: true, force: true });
    steps.push(`Removed ${cliConfigDir}`);
  } catch {
    steps.push(`Could not remove ${cliConfigDir}`);
  }

  // 4. Note: do NOT remove ~/.sync (server data) — user may want to keep it
  // The user can remove it manually if needed.

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, steps }, null, 2) + '\n');
    return;
  }

  process.stdout.write('\n');
  for (const step of steps) {
    p.log.info(step);
  }
  p.log.warn(
    `Server data at ${join(homedir(), '.sync')} was preserved. Remove it manually if no longer needed.`,
  );
  p.outro(pc.green('Uninstall complete.'));
}
