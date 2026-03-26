/**
 * CLI command: sync preview
 *
 * Shows pending sync previews and allows the user to approve or reject them.
 * The agent runs rclone --dry-run and saves the results when a project's
 * confirm mode requires approval. This command reads those previews.
 *
 * Usage:
 *   sync preview                        List all pending previews
 *   sync preview <project-id>           Show detailed diff for one project
 *   sync preview <project-id> --approve Approve and execute the sync
 *   sync preview <project-id> --reject  Reject the pending sync
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { jsonOutput, formatRelativeTime } from '../lib/format.js';

import {
  listPendingSyncs,
  readPendingSync,
  approvePendingSync,
  rejectPendingSync,
  validateLocalPath,
  type PendingSyncPreview,
} from '@lamalibre/sync-shared';

const DEFAULT_AGENT_DIR = join(homedir(), '.sync-agent');


interface PreviewOptions {
  json?: boolean;
  yes?: boolean;
  approve?: boolean;
  reject?: boolean;
  agentDir?: string;
  project?: string;
}

export async function previewCommand(
  positionalId: string | undefined,
  opts: PreviewOptions,
): Promise<void> {
  const agentDir = opts.agentDir ?? DEFAULT_AGENT_DIR;

  // Validate agent directory path
  const agentDirErr = validateLocalPath(agentDir);
  if (agentDirErr) {
    process.stderr.write(pc.red(`Invalid --agent-dir: ${agentDirErr}\n`));
    process.exit(1);
  }

  const projectId = positionalId ?? opts.project;

  // --approve: approve a specific project
  if (opts.approve && projectId) {
    return handleApprove(agentDir, projectId, opts.json);
  }

  // --reject: reject a specific project
  if (opts.reject && projectId) {
    return handleReject(agentDir, projectId, opts.json);
  }

  // Show specific project preview
  if (projectId) {
    return showProjectPreview(agentDir, projectId, opts);
  }

  // List all pending previews
  return listPreviews(agentDir, opts.json);
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

async function listPreviews(agentDir: string, json?: boolean): Promise<void> {
  const previews = await listPendingSyncs(agentDir);
  const now = Date.now();
  const pending = previews.filter(
    (preview) => preview.status === 'pending' && new Date(preview.expiresAt).getTime() > now,
  );

  if (json) {
    process.stdout.write(jsonOutput({ previews: pending }) + '\n');
    return;
  }

  if (pending.length === 0) {
    process.stdout.write(pc.dim('\nNo pending sync previews.\n\n'));
    return;
  }

  process.stdout.write(pc.bold('\nPending Sync Previews\n\n'));

  for (const preview of pending) {
    const remainingMs = new Date(preview.expiresAt).getTime() - Date.now();
    const remainingMin = Math.max(0, Math.ceil(remainingMs / 60_000));
    const expires = remainingMin > 0 ? `${remainingMin}m` : 'expired';
    process.stdout.write(
      `  ${pc.yellow('\u25cb')} ${pc.bold(preview.projectName)} ${pc.dim(`(${preview.projectId})`)}\n` +
        `    Direction:  ${preview.direction}\n` +
        `    Transfers:  ${pc.green(String(preview.copyCount))} file(s)\n` +
        `    Deletions:  ${preview.deleteCount > 0 ? pc.red(String(preview.deleteCount)) : pc.dim('0')} file(s)\n` +
        `    Created:    ${formatRelativeTime(preview.createdAt)}\n` +
        `    Expires in: ${expires}\n\n`,
    );
  }

  process.stdout.write(
    `  Run ${pc.cyan('sync preview <project-id>')} to see details.\n` +
      `  Run ${pc.cyan('sync preview <project-id> --approve')} to approve.\n` +
      `  Run ${pc.cyan('sync preview <project-id> --reject')} to reject.\n\n`,
  );
}

async function showProjectPreview(
  agentDir: string,
  projectId: string,
  opts: PreviewOptions,
): Promise<void> {
  const preview = await readPendingSync(agentDir, projectId);
  if (!preview) {
    if (opts.json) {
      process.stdout.write(jsonOutput({ ok: false, error: 'No pending preview found' }) + '\n');
    } else {
      process.stderr.write(pc.yellow(`No pending preview for project "${projectId}".\n`));
    }
    return;
  }

  if (opts.json) {
    process.stdout.write(jsonOutput(preview) + '\n');
    return;
  }

  process.stdout.write('\n');
  p.intro(pc.bold('Sync Preview'));

  renderPreviewDetails(preview);

  // Interactive: ask to approve or reject
  if (!opts.yes) {
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'approve', label: pc.green('Approve — execute this sync') },
        { value: 'reject', label: pc.red('Reject — skip this sync') },
        { value: 'cancel', label: pc.dim('Cancel — decide later') },
      ],
    });

    if (p.isCancel(action) || action === 'cancel') {
      p.outro(pc.dim('No action taken. Preview will expire automatically.'));
      return;
    }

    if (action === 'approve') {
      await approvePendingSync(agentDir, projectId);
      p.outro(pc.green('Sync approved. The agent will execute it on the next poll.'));
    } else {
      await rejectPendingSync(agentDir, projectId);
      p.outro(pc.red('Sync rejected.'));
    }
  }
}

function renderPreviewDetails(preview: PendingSyncPreview): void {
  process.stdout.write(
    `  Project:    ${pc.bold(preview.projectName)}\n` +
      `  Direction:  ${preview.direction}\n` +
      `  Path:       ${pc.cyan(preview.localPath)}\n` +
      `  Remote:     ${pc.dim(preview.remotePath)}\n` +
      `  Created:    ${formatRelativeTime(preview.createdAt)}\n\n`,
  );

  const copies = preview.changes.filter((c) => c.action === 'copy');
  const deletions = preview.changes.filter((c) => c.action === 'delete');

  // Show deletions first (most important to review)
  if (preview.deleteCount > 0) {
    process.stdout.write(
      pc.red(`  Files to DELETE (${preview.deleteCount}):\n`),
    );
    for (const change of deletions) {
      process.stdout.write(`    ${pc.red('-')} ${change.path}\n`);
    }
    if (preview.deleteCount > deletions.length) {
      process.stdout.write(
        pc.dim(`    ... and ${preview.deleteCount - deletions.length} more\n`),
      );
    }
    process.stdout.write('\n');
  }

  // Show copies
  if (preview.copyCount > 0) {
    process.stdout.write(
      pc.green(`  Files to TRANSFER (${preview.copyCount}):\n`),
    );
    const maxToShow = 20;
    for (const change of copies.slice(0, maxToShow)) {
      process.stdout.write(`    ${pc.green('+')} ${change.path}\n`);
    }
    if (preview.copyCount > maxToShow) {
      process.stdout.write(
        pc.dim(`    ... and ${preview.copyCount - maxToShow} more\n`),
      );
    }
    process.stdout.write('\n');
  }

  if (preview.copyCount === 0 && preview.deleteCount === 0) {
    process.stdout.write(pc.dim('  No changes detected.\n\n'));
  }
}

async function handleApprove(
  agentDir: string,
  projectId: string,
  json?: boolean,
): Promise<void> {
  const success = await approvePendingSync(agentDir, projectId);
  if (json) {
    process.stdout.write(jsonOutput({ ok: success }) + '\n');
  } else if (success) {
    process.stdout.write(
      pc.green('\nSync approved. The agent will execute it on the next poll.\n\n'),
    );
  } else {
    process.stderr.write(pc.yellow(`No pending preview for project "${projectId}".\n`));
  }
}

async function handleReject(
  agentDir: string,
  projectId: string,
  json?: boolean,
): Promise<void> {
  const success = await rejectPendingSync(agentDir, projectId);
  if (json) {
    process.stdout.write(jsonOutput({ ok: success }) + '\n');
  } else if (success) {
    process.stdout.write(pc.green('\nSync rejected.\n\n'));
  } else {
    process.stderr.write(pc.yellow(`No pending preview for project "${projectId}".\n`));
  }
}
