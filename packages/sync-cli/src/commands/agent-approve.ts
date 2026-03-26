/**
 * CLI command: sync agent-approve
 *
 * Manages the agent-side path mapping. The agent refuses to sync, archive,
 * restore, or watch any project whose (projectId, localPath) pair has not
 * been explicitly set and approved by the local user.
 *
 * Local paths are machine-local and never come from the server. The user
 * sets them here; they are stored in ~/.sync-agent/approved-paths.json.
 *
 * Usage:
 *   sync agent-approve                   Interactive: list unmapped, select to approve
 *   sync agent-approve <project-id>      Set local path for a specific project
 *   sync agent-approve --list            Show all approved paths and unmapped projects
 *   sync agent-approve <id> --reject     Remove an existing approval
 *   sync agent-approve --yes             Re-approve all projects that already have paths
 *   sync agent-approve <id> --path /dir  Set path non-interactively
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';
import {
  readApprovedPaths,
  writeApprovedPaths,
  addApproval,
  removeApproval,
  getLocalPath,
  getUnmappedProjects,
  validateLocalPath,
  ACCESS_MODES,
  CONFIRM_MODES,
  type ApprovedPathsFile,
  type ProjectInfo,
  type AccessMode,
  type ConfirmMode,
} from '@lamalibre/sync-shared';

const DEFAULT_AGENT_DIR = join(homedir(), '.sync-agent');

const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  full: 'Full — allow all sync directions (server decides)',
  'push-only': 'Push only — only upload from this folder, never download or delete locally',
  'pull-only': 'Pull only — only download into this folder, never upload',
  protected: 'Protected — download new files only, never overwrite or delete existing files',
};

const CONFIRM_MODE_LABELS: Record<ConfirmMode, string> = {
  auto: 'Auto — sync immediately without preview',
  'confirm-destructive': 'Confirm destructive — require approval if files would be deleted',
  'confirm-always': 'Confirm always — always show preview before syncing',
};

const DIRECTION_DESCRIPTIONS: Record<string, string> = {
  push: 'Upload only — files go FROM this folder TO cloud',
  pull: 'Download only — files come FROM cloud INTO this folder',
  bidirectional: 'Bidirectional — files sync BOTH ways between this folder and cloud',
};

interface AgentApproveOptions {
  json?: boolean;
  yes?: boolean;
  project?: string;
  reject?: boolean;
  list?: boolean;
  agentDir?: string;
  accessMode?: string;
  confirmMode?: string;
  deleteThreshold?: string;
  path?: string;
}

export async function agentApproveCommand(
  client: ApiClient,
  positionalId: string | undefined,
  opts: AgentApproveOptions,
): Promise<void> {
  const agentDir = opts.agentDir ?? DEFAULT_AGENT_DIR;

  // Validate agent directory path
  const agentDirErr = validateLocalPath(agentDir);
  if (agentDirErr) {
    process.stderr.write(pc.red(`Invalid --agent-dir: ${agentDirErr}\n`));
    process.exit(1);
  }

  // Ensure agent directory exists
  await mkdir(agentDir, { recursive: true, mode: 0o700 });

  const approvedPaths = await readApprovedPaths(agentDir);

  // Fetch projects from server
  const { projects } = await client.get<{ projects: Project[] }>('/api/sync/projects');
  const activeProjects = projects.filter((proj) => proj.deletedAt === null);

  const projectId = positionalId ?? opts.project;

  // --list: show current state
  if (opts.list) {
    return showList(approvedPaths, activeProjects, opts.json);
  }

  // --reject: remove an approval
  if (opts.reject) {
    if (!projectId) {
      process.stderr.write(pc.red('Error: --reject requires a project ID.\n'));
      process.exit(1);
    }
    return rejectApproval(agentDir, approvedPaths, projectId, opts.json);
  }

  // Approve a specific project by ID
  if (projectId) {
    const project = activeProjects.find((proj) => proj.id === projectId);
    if (!project) {
      process.stderr.write(pc.red(`Error: project "${projectId}" not found on server.\n`));
      process.exit(1);
    }
    return approveProject(agentDir, approvedPaths, project, opts);
  }

  // --yes with no project ID: re-approve all that already have paths
  if (opts.yes) {
    return approveAll(agentDir, approvedPaths, activeProjects, opts);
  }

  // Interactive mode: show unmapped and let user select
  return interactiveApprove(agentDir, approvedPaths, activeProjects, opts.json);
}

// ---------------------------------------------------------------------------
// Sync preview display
// ---------------------------------------------------------------------------

function renderProjectPreview(project: Project): string {
  const dirDesc = DIRECTION_DESCRIPTIONS[project.direction] ?? project.direction;
  const triggerDesc = project.trigger === 'watch'
    ? 'Automatic (watches for file changes)'
    : project.trigger === 'schedule'
      ? `Scheduled (${project.schedule ?? 'cron'})`
      : project.trigger === 'watch+schedule'
        ? `Watch + Schedule (${project.schedule ?? 'cron'})`
        : 'Manual only';

  const excludeList = project.excludes.length > 0
    ? project.excludes.join(', ')
    : pc.dim('none');

  return [
    '',
    `  ${pc.bold('What will happen upon sync:')}`,
    `    Direction:   ${dirDesc}`,
    `    Destination: ${pc.cyan(project.remotePath)}`,
    `    Encrypted:   ${project.encrypted ? pc.green('yes') : 'no'}`,
    `    Excludes:    ${excludeList}`,
    `    Auto-sync:   ${triggerDesc}`,
    `    Conflicts:   ${project.conflictStrategy}`,
    '',
  ].join('\n');
}

function confirmQuestionForDirection(direction: string): string {
  switch (direction) {
    case 'push':
      return 'Allow the sync agent to READ files in this directory and UPLOAD them?';
    case 'pull':
      return 'Allow the sync agent to DOWNLOAD files into this directory?';
    case 'bidirectional':
      return 'Allow the sync agent to READ and WRITE files in this directory (both ways)?';
    default:
      return 'Allow the sync agent to sync this directory?';
  }
}

// ---------------------------------------------------------------------------
// Prompt for local path
// ---------------------------------------------------------------------------

async function promptForLocalPath(
  projectName: string,
  existingPath: string | null,
): Promise<string | null> {
  const result = await p.text({
    message: `Enter local directory path for "${projectName}":`,
    placeholder: existingPath ?? '/path/to/local/directory',
    defaultValue: existingPath ?? undefined,
    validate(value) {
      const trimmed = value.trim();
      if (trimmed.length === 0) return 'Path is required';
      return validateLocalPath(trimmed) ?? undefined;
    },
  });

  if (p.isCancel(result)) return null;
  return (result as string).trim();
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

function showList(
  approvedPaths: ApprovedPathsFile,
  projects: readonly Project[],
  json?: boolean,
): void {
  const projectInfos: ProjectInfo[] = projects.map((proj) => ({
    id: proj.id, name: proj.name,
  }));
  const unmapped = getUnmappedProjects(approvedPaths, projectInfos);

  if (json) {
    process.stdout.write(
      jsonOutput({
        approved: approvedPaths.entries,
        unmapped: unmapped.map((proj) => ({ projectId: proj.id, name: proj.name })),
      }) + '\n',
    );
    return;
  }

  process.stdout.write(pc.bold('\nApproved Paths\n\n'));

  if (approvedPaths.entries.length === 0) {
    process.stdout.write(pc.dim('  No paths approved yet.\n'));
  } else {
    for (const entry of approvedPaths.entries) {
      const isStale = !projects.some((proj) => proj.id === entry.projectId);
      const staleLabel = isStale ? pc.yellow(' (project removed)') : '';
      const modeLabel = entry.accessMode && entry.accessMode !== 'full'
        ? pc.blue(` [${entry.accessMode}]`)
        : '';
      const confirmLabel = entry.confirmMode && entry.confirmMode !== 'auto'
        ? pc.dim(` (${entry.confirmMode})`)
        : '';
      process.stdout.write(
        `  ${pc.green('\u2713')} ${pc.bold(entry.projectName)} ${pc.dim(`(${entry.projectId})`)}${modeLabel}${confirmLabel}${staleLabel}\n` +
          `    ${pc.dim(entry.localPath)}\n`,
      );
    }
  }

  process.stdout.write(pc.bold('\nUnmapped Projects\n\n'));

  if (unmapped.length === 0) {
    process.stdout.write(pc.dim('  All projects have local paths configured.\n\n'));
  } else {
    for (const proj of unmapped) {
      process.stdout.write(
        `  ${pc.yellow('\u25cb')} ${pc.bold(proj.name)} ${pc.dim(`(${proj.id})`)}\n` +
          `    ${pc.dim('no local path set')}\n`,
      );
    }
    process.stdout.write(
      `\n  Run ${pc.cyan('sync agent-approve <project-id>')} to set a local path.\n\n`,
    );
  }
}

async function rejectApproval(
  agentDir: string,
  approvedPaths: ApprovedPathsFile,
  projectId: string,
  json?: boolean,
): Promise<void> {
  const entry = approvedPaths.entries.find((e) => e.projectId === projectId);
  if (!entry) {
    if (json) {
      process.stdout.write(jsonOutput({ ok: false, error: 'Not found in approved list' }) + '\n');
    } else {
      process.stderr.write(pc.yellow(`Project "${projectId}" is not in the approved list.\n`));
    }
    return;
  }

  const updated = removeApproval(approvedPaths, projectId);
  await writeApprovedPaths(agentDir, updated);

  if (json) {
    process.stdout.write(jsonOutput({ ok: true, removed: projectId }) + '\n');
  } else {
    process.stdout.write(
      pc.green(`\nRemoved approval for "${entry.projectName}" (${entry.localPath}).\n`) +
        pc.dim('The agent will stop syncing this project on its next poll.\n\n'),
    );
  }
}

async function approveProject(
  agentDir: string,
  approvedPaths: ApprovedPathsFile,
  project: Project,
  opts: AgentApproveOptions,
): Promise<void> {
  let accessMode: AccessMode = parseAccessMode(opts.accessMode);
  let confirmMode: ConfirmMode = parseConfirmMode(opts.confirmMode, project.direction);
  let deleteThreshold: number | undefined;
  if (opts.deleteThreshold) {
    const parsed = parseInt(opts.deleteThreshold, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      process.stderr.write(pc.red(`Invalid delete threshold: "${opts.deleteThreshold}". Must be a non-negative integer.\n`));
      process.exit(1);
    }
    deleteThreshold = parsed;
  }

  // Resolve local path: --path flag, existing mapping, or prompt
  const existingPath = getLocalPath(approvedPaths, project.id);
  let localPath: string;

  if (opts.path) {
    // Non-interactive: --path flag
    const err = validateLocalPath(opts.path);
    if (err) {
      process.stderr.write(pc.red(`Invalid path: ${err}\n`));
      process.exit(1);
    }
    localPath = opts.path;
  } else if (opts.yes || opts.json) {
    // Non-interactive without --path: must have existing mapping
    if (!existingPath) {
      if (opts.json) {
        process.stdout.write(
          jsonOutput({ ok: false, error: 'No existing path. Use --path or interactive mode.' }) + '\n',
        );
      } else {
        process.stderr.write(
          pc.red(`Error: project "${project.id}" has no existing local path.\n`) +
            pc.dim('Use --path <dir> to set one, or run interactively.\n'),
        );
      }
      process.exit(1);
    }
    localPath = existingPath;
  } else {
    // Interactive: prompt for path
    process.stdout.write('\n');
    p.intro(pc.bold('Approve sync path'));

    process.stdout.write(
      `  Project:    ${pc.bold(project.name)}\n` +
        `  ID:         ${pc.dim(project.id)}\n`,
    );
    if (existingPath) {
      process.stdout.write(`  Current:    ${pc.cyan(existingPath)}\n`);
    }

    // Show full preview of what will happen
    process.stdout.write(renderProjectPreview(project));

    const prompted = await promptForLocalPath(project.name, existingPath);
    if (prompted === null) {
      p.outro(pc.dim('Cancelled.'));
      return;
    }
    localPath = prompted;

    // Ask for access mode
    if (!opts.accessMode) {
      const modeResult = await p.select({
        message: 'Select access mode for this project:',
        options: ACCESS_MODES.map((mode) => ({
          value: mode,
          label: ACCESS_MODE_LABELS[mode],
        })),
        initialValue: 'full' as AccessMode,
      });
      if (p.isCancel(modeResult)) {
        p.outro(pc.dim('Cancelled.'));
        return;
      }
      accessMode = modeResult;
    }

    // Ask for confirm mode
    if (!opts.confirmMode) {
      const defaultConfirm: ConfirmMode = project.direction === 'bidirectional'
        ? 'confirm-destructive'
        : 'auto';
      const confirmResult = await p.select({
        message: 'When should sync require your approval?',
        options: CONFIRM_MODES.map((mode) => ({
          value: mode,
          label: CONFIRM_MODE_LABELS[mode],
        })),
        initialValue: defaultConfirm,
      });
      if (p.isCancel(confirmResult)) {
        p.outro(pc.dim('Cancelled.'));
        return;
      }
      confirmMode = confirmResult;
    }

    // Final confirmation
    const confirm = await p.confirm({
      message: confirmQuestionForDirection(project.direction),
    });

    if (p.isCancel(confirm) || !confirm) {
      p.outro(pc.dim('Cancelled.'));
      return;
    }
  }

  const updated = addApproval(approvedPaths, {
    projectId: project.id,
    localPath,
    approvedAt: new Date().toISOString(),
    projectName: project.name,
    accessMode,
    confirmMode,
    deleteThreshold,
  });
  await writeApprovedPaths(agentDir, updated);

  if (opts.json) {
    process.stdout.write(
      jsonOutput({
        ok: true,
        approved: {
          projectId: project.id,
          localPath,
          accessMode,
          confirmMode,
        },
      }) + '\n',
    );
  } else {
    process.stdout.write(
      pc.green(`\nApproved "${project.name}" at ${localPath}`) +
        (accessMode !== 'full' ? pc.blue(` [${accessMode}]`) : '') +
        (confirmMode !== 'auto' ? pc.dim(` (${confirmMode})`) : '') +
        '.\n' +
        pc.dim('The agent will begin syncing this project on its next poll.\n\n'),
    );
  }
}

async function approveAll(
  agentDir: string,
  approvedPaths: ApprovedPathsFile,
  projects: readonly Project[],
  opts: AgentApproveOptions,
): Promise<void> {
  // --yes can only re-approve projects that already have paths in approved-paths.json.
  // New projects without paths require interactive mode.
  const projectInfos: ProjectInfo[] = projects.map((proj) => ({
    id: proj.id, name: proj.name,
  }));
  const unmapped = getUnmappedProjects(approvedPaths, projectInfos);

  // Only re-approve projects that already have entries
  const reapprovable = projects.filter(
    (proj) => getLocalPath(approvedPaths, proj.id) !== null,
  );

  if (reapprovable.length === 0) {
    if (opts.json) {
      process.stdout.write(jsonOutput({ ok: true, approved: [], skipped: unmapped.length }) + '\n');
    } else {
      process.stdout.write(
        pc.dim('No projects with existing local paths to re-approve.\n') +
          (unmapped.length > 0
            ? pc.yellow(`${unmapped.length} project(s) need a local path. Run interactively to set them.\n`)
            : ''),
      );
    }
    return;
  }

  const accessMode = parseAccessMode(opts.accessMode);
  let deleteThreshold: number | undefined;
  if (opts.deleteThreshold) {
    const parsed = parseInt(opts.deleteThreshold, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) deleteThreshold = parsed;
  }
  const approvedList: Array<{ projectId: string; localPath: string }> = [];

  let current = approvedPaths;
  for (const proj of reapprovable) {
    const existingPath = getLocalPath(approvedPaths, proj.id)!;
    const confirmMode = parseConfirmMode(opts.confirmMode, proj.direction);
    current = addApproval(current, {
      projectId: proj.id,
      localPath: existingPath,
      approvedAt: new Date().toISOString(),
      projectName: proj.name,
      accessMode,
      confirmMode,
      deleteThreshold,
    });
    approvedList.push({ projectId: proj.id, localPath: existingPath });
  }
  await writeApprovedPaths(agentDir, current);

  if (opts.json) {
    process.stdout.write(jsonOutput({ ok: true, approved: approvedList, skipped: unmapped.length }) + '\n');
  } else {
    process.stdout.write(pc.green(`\nRe-approved ${approvedList.length} project path(s):\n`));
    for (const item of approvedList) {
      process.stdout.write(`  ${pc.green('\u2713')} ${item.localPath}\n`);
    }
    if (unmapped.length > 0) {
      process.stdout.write(
        pc.yellow(`\n${unmapped.length} project(s) skipped (no local path set). Run interactively to configure them.\n`),
      );
    }
    process.stdout.write(pc.dim('\nThe agent will begin syncing on its next poll.\n\n'));
  }
}

async function interactiveApprove(
  agentDir: string,
  approvedPaths: ApprovedPathsFile,
  projects: readonly Project[],
  json?: boolean,
): Promise<void> {
  const projectInfos: ProjectInfo[] = projects.map((proj) => ({
    id: proj.id, name: proj.name,
  }));
  const unmapped = getUnmappedProjects(approvedPaths, projectInfos);

  if (unmapped.length === 0) {
    if (json) {
      process.stdout.write(jsonOutput({ ok: true, unmapped: [] }) + '\n');
    } else {
      process.stdout.write(pc.dim('\nAll projects have local paths configured.\n\n'));
    }
    return;
  }

  process.stdout.write('\n');
  p.intro(pc.bold('Configure sync paths'));

  process.stdout.write(
    pc.dim(
      '  The agent will only sync projects whose local paths you configure here.\n' +
        '  You will be prompted to enter a local directory for each selected project.\n\n',
    ),
  );

  // Show previews for each unmapped project
  for (const proj of unmapped) {
    const fullProject = projects.find((fp) => fp.id === proj.id);
    if (fullProject) {
      process.stdout.write(
        `  ${pc.yellow('\u25cb')} ${pc.bold(proj.name)} ${pc.dim(`(${proj.id})`)}\n` +
          `    ${pc.dim('no local path set')}\n`,
      );
      process.stdout.write(renderProjectPreview(fullProject));
    }
  }

  const options = unmapped.map((proj) => ({
    value: proj.id,
    label: proj.name,
  }));

  const selected = await p.multiselect({
    message: 'Select projects to configure:',
    options,
    required: false,
  });

  if (p.isCancel(selected)) {
    p.outro(pc.dim('Cancelled.'));
    return;
  }

  if (selected.length === 0) {
    p.outro(pc.dim('No projects selected.'));
    return;
  }

  // For each selected project, prompt for path and access mode
  let current = approvedPaths;
  for (const selectedProjectId of selected) {
    const proj = unmapped.find((u) => u.id === selectedProjectId);
    const fullProject = projects.find((fp) => fp.id === selectedProjectId);
    if (!proj || !fullProject) continue;

    // Prompt for local path
    const localPath = await promptForLocalPath(proj.name, null);
    if (localPath === null) {
      p.outro(pc.dim('Cancelled.'));
      return;
    }

    const modeResult = await p.select({
      message: `Access mode for "${proj.name}":`,
      options: ACCESS_MODES.map((mode) => ({
        value: mode,
        label: ACCESS_MODE_LABELS[mode],
      })),
      initialValue: 'full' as AccessMode,
    });
    if (p.isCancel(modeResult)) {
      p.outro(pc.dim('Cancelled.'));
      return;
    }

    const defaultConfirm: ConfirmMode = fullProject.direction === 'bidirectional'
      ? 'confirm-destructive'
      : 'auto';
    const confirmResult = await p.select({
      message: `Sync confirmation for "${proj.name}":`,
      options: CONFIRM_MODES.map((mode) => ({
        value: mode,
        label: CONFIRM_MODE_LABELS[mode],
      })),
      initialValue: defaultConfirm,
    });
    if (p.isCancel(confirmResult)) {
      p.outro(pc.dim('Cancelled.'));
      return;
    }

    current = addApproval(current, {
      projectId: proj.id,
      localPath,
      approvedAt: new Date().toISOString(),
      projectName: proj.name,
      accessMode: modeResult,
      confirmMode: confirmResult,
    });
  }
  await writeApprovedPaths(agentDir, current);

  p.outro(
    pc.green(`Configured ${selected.length} path(s). The agent will sync them on its next poll.`),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAccessMode(value: string | undefined): AccessMode {
  if (!value) return 'full';
  if ((ACCESS_MODES as readonly string[]).includes(value)) {
    return value as AccessMode;
  }
  process.stderr.write(
    pc.red(`Invalid access mode: "${value}". Valid values: ${ACCESS_MODES.join(', ')}\n`),
  );
  process.exit(1);
}

function parseConfirmMode(value: string | undefined, direction?: string): ConfirmMode {
  if (!value) return direction === 'bidirectional' ? 'confirm-destructive' : 'auto';
  if ((CONFIRM_MODES as readonly string[]).includes(value)) {
    return value as ConfirmMode;
  }
  process.stderr.write(
    pc.red(`Invalid confirm mode: "${value}". Valid values: ${CONFIRM_MODES.join(', ')}\n`),
  );
  process.exit(1);
}
