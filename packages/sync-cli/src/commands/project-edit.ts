import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';
import {
  SYNC_DIRECTIONS,
  SYNC_TRIGGERS,
  CONFLICT_STRATEGIES,
} from '@lamalibre/sync-shared';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface ProjectEditOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
  name?: string;
  remotePath?: string;
  direction?: string;
  trigger?: string;
  conflictStrategy?: string;
  encrypt?: boolean;
  encryptPassword?: string;
  excludes?: string;
  bandwidthLimit?: string;
  watchDebounce?: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function projectEditCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: ProjectEditOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection if no ID given
  if (!projectId) {
    const projectsRes = await client.get<{ projects: Project[] }>('/api/sync/projects');
    if (projectsRes.projects.length === 0) {
      process.stderr.write(pc.red('No projects configured.\n'));
      process.exit(1);
    }

    const selected = await p.select({
      message: 'Select a project to edit',
      options: projectsRes.projects.map((proj) => ({
        value: proj.id,
        label: `${proj.name} (${proj.direction})`,
        hint: proj.status,
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    projectId = selected as string;
  }

  // Fetch current project state
  const res = await client.get<{ project: Project }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}`,
  );
  const current = res.project;

  // Determine if non-interactive (any edit flag provided)
  const hasEditFlags =
    opts.name !== undefined ||
    opts.remotePath !== undefined ||
    opts.direction !== undefined ||
    opts.trigger !== undefined ||
    opts.conflictStrategy !== undefined ||
    opts.encrypt !== undefined ||
    opts.encryptPassword !== undefined ||
    opts.excludes !== undefined ||
    opts.bandwidthLimit !== undefined ||
    opts.watchDebounce !== undefined;

  const updates: Record<string, unknown> = {};

  if (hasEditFlags) {
    // Non-interactive: only update provided flags
    if (opts.name !== undefined) updates['name'] = opts.name;
    if (opts.remotePath !== undefined) updates['remotePath'] = opts.remotePath;
    if (opts.direction !== undefined) updates['direction'] = opts.direction;
    if (opts.trigger !== undefined) {
      updates['trigger'] = opts.trigger;
      updates['watch'] = opts.trigger === 'watch' || opts.trigger === 'watch+schedule';
    }
    if (opts.conflictStrategy !== undefined) updates['conflictStrategy'] = opts.conflictStrategy;
    if (opts.encrypt !== undefined) updates['encrypted'] = opts.encrypt;
    if (opts.encryptPassword !== undefined) updates['encryptionPassword'] = opts.encryptPassword;
    if (opts.excludes !== undefined) {
      updates['excludes'] = opts.excludes.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (opts.bandwidthLimit !== undefined) updates['bandwidthLimit'] = opts.bandwidthLimit;
    if (opts.watchDebounce !== undefined) {
      const parsed = parseInt(opts.watchDebounce, 10);
      if (isNaN(parsed)) {
        process.stderr.write(pc.red(`Invalid watch debounce value: "${opts.watchDebounce}" is not a valid number.\n`));
        process.exit(1);
      }
      updates['watchDebounceMs'] = parsed;
    }
  } else {
    // Interactive mode: show current values as defaults
    const nameResult = await p.text({
      message: 'Project name',
      initialValue: current.name,
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (v.length > 100) return 'Name must be 100 characters or less';
        return undefined;
      },
    });
    if (p.isCancel(nameResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newName = (nameResult as string).trim();
    if (newName !== current.name) updates['name'] = newName;

    const remotePathResult = await p.text({
      message: 'Remote path',
      initialValue: current.remotePath,
    });
    if (p.isCancel(remotePathResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newRemotePath = (remotePathResult as string).trim();
    if (newRemotePath !== current.remotePath) updates['remotePath'] = newRemotePath;

    const directionResult = await p.select({
      message: 'Sync direction',
      options: SYNC_DIRECTIONS.map((d) => ({ value: d, label: d })),
      initialValue: current.direction as typeof SYNC_DIRECTIONS[number],
    });
    if (p.isCancel(directionResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newDirection = directionResult as string;
    if (newDirection !== current.direction) updates['direction'] = newDirection;

    const triggerResult = await p.select({
      message: 'Trigger mode',
      options: SYNC_TRIGGERS.map((t) => ({ value: t, label: t })),
      initialValue: current.trigger as typeof SYNC_TRIGGERS[number],
    });
    if (p.isCancel(triggerResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newTrigger = triggerResult as string;
    if (newTrigger !== current.trigger) {
      updates['trigger'] = newTrigger;
      updates['watch'] = newTrigger === 'watch' || newTrigger === 'watch+schedule';
    }

    const conflictResult = await p.select({
      message: 'Conflict strategy',
      options: CONFLICT_STRATEGIES.map((c) => ({ value: c, label: c })),
      initialValue: current.conflictStrategy as typeof CONFLICT_STRATEGIES[number],
    });
    if (p.isCancel(conflictResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newConflict = conflictResult as string;
    if (newConflict !== current.conflictStrategy) updates['conflictStrategy'] = newConflict;

    const excludesResult = await p.text({
      message: 'Exclude patterns (comma-separated)',
      initialValue: current.excludes.join(', '),
    });
    if (p.isCancel(excludesResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newExcludes = (excludesResult as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (JSON.stringify(newExcludes) !== JSON.stringify(current.excludes)) {
      updates['excludes'] = newExcludes;
    }

    const bwResult = await p.text({
      message: 'Bandwidth limit (e.g. 10M, empty for unlimited)',
      initialValue: current.bandwidthLimit ?? '',
    });
    if (p.isCancel(bwResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    const newBw = (bwResult as string).trim() || undefined;
    if (newBw !== (current.bandwidthLimit ?? undefined)) {
      // Send null to clear the bandwidth limit when user enters empty string
      updates['bandwidthLimit'] = newBw ?? null;
    }

    if (newTrigger === 'watch' || newTrigger === 'watch+schedule') {
      const debounceResult = await p.text({
        message: 'Watch debounce (ms, 500-60000)',
        initialValue: String(current.watchDebounceMs ?? 5000),
        validate: (v) => {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 500 || n > 60_000) return 'Must be between 500 and 60000';
          return undefined;
        },
      });
      if (p.isCancel(debounceResult)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      const newDebounce = parseInt(debounceResult as string, 10);
      if (newDebounce !== (current.watchDebounceMs ?? 5000)) {
        updates['watchDebounceMs'] = newDebounce;
      }
    }
  }

  // Nothing changed
  if (Object.keys(updates).length === 0) {
    if (opts.json) {
      process.stdout.write(jsonOutput({ ok: true, changed: false, project: current }) + '\n');
    } else {
      p.log.info('No changes to apply.');
    }
    return;
  }

  // Confirm
  if (!opts.yes && !opts.json && !hasEditFlags) {
    const confirmed = await p.confirm({
      message: `Apply ${Object.keys(updates).length} change(s) to "${projectId}"?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.patch<{ ok: boolean; project: Project }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}`,
    updates,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Project "${result.project.name}" updated.`);
}
