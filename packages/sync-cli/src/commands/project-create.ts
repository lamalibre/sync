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

interface ProjectCreateOptions {
  json?: boolean;
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

export async function projectCreateCommand(
  client: ApiClient,
  opts: ProjectCreateOptions,
): Promise<void> {
  const isNonInteractive = opts.name !== undefined;

  let name: string;
  let remotePath: string | undefined;
  let direction: string;
  let trigger: string;
  let conflictStrategy: string;
  let encrypted: boolean;
  let encryptionPassword: string | undefined;
  let excludes: string[];
  let bandwidthLimit: string | undefined;
  let watchDebounceMs: number | undefined;

  if (isNonInteractive) {
    name = opts.name!; // Safe: guarded by isNonInteractive check above (opts.name !== undefined)
    remotePath = opts.remotePath;
    direction = opts.direction ?? 'push';
    trigger = opts.trigger ?? 'manual';
    conflictStrategy = opts.conflictStrategy ?? 'newest-wins';
    encrypted = opts.encrypt === true;
    encryptionPassword = opts.encryptPassword;
    excludes = opts.excludes ? opts.excludes.split(',').map((s) => s.trim()).filter(Boolean) : [];
    bandwidthLimit = opts.bandwidthLimit;
    if (opts.watchDebounce) {
      const parsed = parseInt(opts.watchDebounce, 10);
      if (isNaN(parsed)) {
        process.stderr.write(pc.red(`Invalid watch debounce value: "${opts.watchDebounce}" is not a valid number.\n`));
        process.exit(1);
      }
      watchDebounceMs = parsed;
    }
  } else {
    // Interactive mode
    const nameResult = await p.text({
      message: 'Project name',
      placeholder: 'my-project',
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
    name = (nameResult as string).trim();

    const remotePathResult = await p.text({
      message: 'Remote path (optional, defaults to project name)',
      placeholder: name,
    });
    if (p.isCancel(remotePathResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    remotePath = (remotePathResult as string).trim() || undefined;

    const directionResult = await p.select({
      message: 'Sync direction',
      options: SYNC_DIRECTIONS.map((d) => ({ value: d, label: d })),
      initialValue: 'push' as const,
    });
    if (p.isCancel(directionResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    direction = directionResult as string;

    const triggerResult = await p.select({
      message: 'Trigger mode',
      options: SYNC_TRIGGERS.map((t) => ({ value: t, label: t })),
      initialValue: 'manual' as const,
    });
    if (p.isCancel(triggerResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    trigger = triggerResult as string;

    const conflictResult = await p.select({
      message: 'Conflict strategy',
      options: CONFLICT_STRATEGIES.map((c) => ({ value: c, label: c })),
      initialValue: 'newest-wins' as const,
    });
    if (p.isCancel(conflictResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    conflictStrategy = conflictResult as string;

    const encryptResult = await p.confirm({
      message: 'Enable encryption?',
      initialValue: false,
    });
    if (p.isCancel(encryptResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    encrypted = encryptResult as boolean;

    if (encrypted) {
      const pwResult = await p.password({
        message: 'Encryption password (min 12 chars). WARNING: Password loss = data loss.',
        validate: (v) => {
          if (!v || v.length < 12) return 'Password must be at least 12 characters';
          return undefined;
        },
      });
      if (p.isCancel(pwResult)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      encryptionPassword = pwResult as string;
    }

    const excludesResult = await p.text({
      message: 'Exclude patterns (comma-separated, optional)',
      placeholder: 'node_modules/**, .git/**',
    });
    if (p.isCancel(excludesResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    excludes = (excludesResult as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const bwResult = await p.text({
      message: 'Bandwidth limit (optional, e.g. 10M, 500k)',
      placeholder: 'unlimited',
    });
    if (p.isCancel(bwResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    bandwidthLimit = (bwResult as string).trim() || undefined;

    if (trigger === 'watch' || trigger === 'watch+schedule') {
      const debounceResult = await p.text({
        message: 'Watch debounce (ms, 500-60000)',
        placeholder: '5000',
        initialValue: '5000',
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
      watchDebounceMs = parseInt(debounceResult as string, 10);
    }
  }

  // Build request body
  const body: Record<string, unknown> = {
    name,
    direction,
    trigger,
    conflictStrategy,
    encrypted,
  };
  if (remotePath) body['remotePath'] = remotePath;
  if (encryptionPassword) body['encryptionPassword'] = encryptionPassword;
  if (excludes.length > 0) body['excludes'] = excludes;
  if (bandwidthLimit) body['bandwidthLimit'] = bandwidthLimit;
  if (watchDebounceMs !== undefined) body['watchDebounceMs'] = watchDebounceMs;
  // Set watch based on trigger
  body['watch'] = trigger === 'watch' || trigger === 'watch+schedule';

  const result = await client.post<{
    ok: boolean;
    project: Project;
    warnings?: string[];
  }>('/api/sync/projects', body);

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Project "${result.project.name}" created (ID: ${pc.cyan(result.project.id)})`);

  if (result.warnings) {
    for (const warning of result.warnings) {
      p.log.warn(warning);
    }
  }
}
