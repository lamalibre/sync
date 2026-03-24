import { execa } from 'execa';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { platform } from 'node:os';

export interface RcloneInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export async function detectRclone(): Promise<RcloneInfo> {
  try {
    const result = await execa('rclone', ['version', '--check']);
    // Parse version from first line like "rclone v1.68.2"
    const firstLine = result.stdout.split('\n')[0] ?? '';
    const versionMatch = firstLine.match(/v([\d.]+)/);
    const version = versionMatch ? versionMatch[1]! : null;

    // Find path
    const whichResult = await execa('which', ['rclone']).catch(() => null);
    const rclonePath = whichResult?.stdout.trim() ?? null;

    return { installed: true, version, path: rclonePath };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

export async function ensureRclone(): Promise<boolean> {
  const info = await detectRclone();

  if (info.installed) {
    p.log.success(`rclone ${info.version ?? ''}detected at ${info.path ?? 'PATH'}`);
    return true;
  }

  p.log.error('rclone is not installed.');

  const os = platform();
  let instructions: string;

  if (os === 'darwin') {
    instructions = [
      'Install rclone on macOS:',
      '',
      `  ${pc.cyan('brew install rclone')}`,
      '',
      'Or download from https://rclone.org/downloads/',
    ].join('\n');
  } else if (os === 'linux') {
    instructions = [
      'Install rclone on Linux:',
      '',
      `  ${pc.cyan('curl https://rclone.org/install.sh | sudo bash')}`,
      '',
      'Or use your package manager:',
      `  ${pc.cyan('sudo apt install rclone')}     # Debian/Ubuntu`,
      `  ${pc.cyan('sudo dnf install rclone')}     # Fedora/RHEL`,
      '',
      'Or download from https://rclone.org/downloads/',
    ].join('\n');
  } else {
    instructions = 'Download rclone from https://rclone.org/downloads/';
  }

  p.note(instructions, 'Install rclone');
  p.log.warn('Please install rclone and run this installer again.');

  return false;
}
