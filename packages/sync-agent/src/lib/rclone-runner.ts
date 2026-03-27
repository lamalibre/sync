/**
 * Execute rclone sync commands via execa with array arguments.
 *
 * CRITICAL: All rclone invocations use array arguments with execa.
 * Never use shell interpolation — paths may contain spaces, quotes,
 * and special characters.
 */

import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  DEFAULT_TRANSFERS,
  DEFAULT_CHECKERS,
  DEFAULT_STATS_INTERVAL,
  DEFAULT_RETRIES,
  DEFAULT_LOW_LEVEL_RETRIES,
  sanitizeRcloneError,
} from '@lamalibre/sync-shared';
import { createProgressParser } from './progress-parser.js';
import {
  buildRemoteTrashPath,
  buildLocalTrashPath,
} from './trash-paths.js';
import type {
  RcloneSyncOptions,
  RcloneBisyncOptions,
  SyncProgress,
  SyncResult,
  BisyncConflict,
  ConflictStrategy,
} from './types.js';

// sanitizeRcloneError is imported from @lamalibre/sync-shared above and
// re-exported here so existing consumers (archive.ts, agent.ts) are not broken.
export { sanitizeRcloneError };

/**
 * Build a minimal env for rclone child processes.
 * Only passes through PATH and explicitly sets RCLONE_CONFIG.
 * Avoids leaking parent environment variables like RCLONE_CONFIG_PASS.
 */
export function buildRcloneEnv(configPath: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    RCLONE_CONFIG: configPath,
  };
}

/**
 * Build the include flags array from include patterns.
 * Each pattern becomes a separate --include argument.
 * When includes are present, rclone requires a trailing --exclude '*' to
 * exclude everything not matched by an include rule.
 */
export function buildIncludeFlags(includes: readonly string[], logger?: Logger): string[] {
  if (includes.length === 0) return [];
  const flags: string[] = [];
  for (const pattern of includes) {
    if (pattern.includes('\0') || /^[+\-!]/.test(pattern)) {
      logger?.warn({ pattern }, 'Skipping unsafe include pattern');
      continue;
    }
    flags.push('--include', pattern);
  }
  if (flags.length > 0) {
    flags.push('--exclude', '*');
  }
  return flags;
}

/**
 * Build the exclude flags array from exclude patterns.
 * Each pattern becomes a separate --exclude argument.
 */
export function buildExcludeFlags(excludes: readonly string[], logger?: Logger): string[] {
  const flags: string[] = [];
  for (const pattern of excludes) {
    // Defense in depth: reject patterns with null bytes or rclone filter prefixes
    // even though the server validates these — the agent may receive config from cache.
    if (pattern.includes('\0') || /^[+\-!]/.test(pattern)) {
      logger?.warn({ pattern }, 'Skipping unsafe exclude pattern');
      continue;
    }
    flags.push('--exclude', pattern);
  }
  return flags;
}

/**
 * Build exclude flags using an --exclude-from file.
 * Preferred over buildExcludeFlags when the ignore resolver has produced
 * a filter file (handles large pattern sets without hitting arg length limits).
 */
export function buildExcludeFromFlags(excludeFromPath: string): string[] {
  return ['--exclude-from', excludeFromPath];
}

/**
 * Build the appropriate exclude flags — prefers --exclude-from when available.
 */
function resolveExcludeFlags(options: { excludeFromPath?: string; excludes: readonly string[] }, logger?: Logger): string[] {
  if (options.excludeFromPath) {
    return buildExcludeFromFlags(options.excludeFromPath);
  }
  return buildExcludeFlags(options.excludes, logger);
}

/**
 * Build the bandwidth limit flags.
 * Returns empty array if no limit is set.
 */
export function buildBandwidthFlags(bandwidthLimit?: string): string[] {
  if (!bandwidthLimit || bandwidthLimit === '0') {
    return [];
  }
  return ['--bwlimit', bandwidthLimit];
}

/**
 * Build --backup-dir flags for push/pull sync.
 * Push: overwritten remote files go to remote trash.
 * Pull: overwritten local files go to local trash.
 */
export function buildBackupDirFlags(
  options: RcloneSyncOptions,
  agentDir: string,
): string[] {
  if (!options.softDelete?.enabled) return [];

  if (options.direction === 'push') {
    return [
      '--backup-dir',
      buildRemoteTrashPath(options.remoteName, options.bucket, options.projectId),
    ];
  }
  // pull
  return [
    '--backup-dir',
    buildLocalTrashPath(agentDir, options.projectId),
  ];
}

/**
 * Build --backup-dir1/--backup-dir2 flags for bisync.
 * Local overwritten files go to local trash, remote to remote trash.
 */
export function buildBisyncBackupDirFlags(
  options: RcloneBisyncOptions,
  agentDir: string,
): string[] {
  if (!options.softDelete?.enabled) return [];

  return [
    '--backup-dir1',
    buildLocalTrashPath(agentDir, options.projectId),
    '--backup-dir2',
    buildRemoteTrashPath(options.remoteName, options.bucket, options.projectId),
  ];
}

/**
 * Build the source and destination arguments for an rclone sync command
 * based on the sync direction.
 */
function buildSyncEndpoints(options: RcloneSyncOptions): { source: string; destination: string } {
  const remote = `${options.remoteName}:${options.bucket}/${options.remotePath}`;

  switch (options.direction) {
    case 'push':
      return { source: options.localPath, destination: remote };
    case 'pull':
      return { source: remote, destination: options.localPath };
    case 'bidirectional':
      throw new Error('Bidirectional sync must use runRcloneBisync, not runRcloneSync');
  }
}

/**
 * Run an rclone sync operation.
 *
 * Returns a SyncResult with the outcome.
 * The onProgress callback is invoked periodically with parsed progress data.
 * The returned AbortController can be used to cancel the operation.
 */
export async function runRcloneSync(
  options: RcloneSyncOptions,
  logger: Logger,
  abortSignal?: AbortSignal,
  agentDir?: string,
): Promise<SyncResult> {
  const startTime = Date.now();
  const syncLogger = logger.child({
    component: 'rclone-runner',
    operationId: options.operationId,
    projectId: options.projectId,
    direction: options.direction,
  });

  const { source, destination } = buildSyncEndpoints(options);

  const args: string[] = [
    'sync',
    source,
    destination,
    '--progress',
    '--stats-one-line',
    '--stats',
    DEFAULT_STATS_INTERVAL,
    '--transfers',
    DEFAULT_TRANSFERS,
    '--checkers',
    DEFAULT_CHECKERS,
    '--retries',
    DEFAULT_RETRIES,
    '--low-level-retries',
    DEFAULT_LOW_LEVEL_RETRIES,
    ...buildIncludeFlags(options.includes, syncLogger),
    ...resolveExcludeFlags(options, syncLogger),
    ...buildBandwidthFlags(options.bandwidthLimit),
    ...(agentDir ? buildBackupDirFlags(options, agentDir) : []),
  ];

  syncLogger.info({ source, destination }, 'Starting rclone sync');

  let lastProgress: SyncProgress | undefined;

  try {
    const childProcess = execa('rclone', args, {
      cancelSignal: abortSignal,
      gracefulCancel: true,
      // Minimal env: only PATH, HOME, and RCLONE_CONFIG.
      // Prevents leaking parent env vars like RCLONE_CONFIG_PASS.
      env: buildRcloneEnv(options.rcloneConfigPath),
      extendEnv: false,
      // We read stderr for progress; stdout may have other output
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Set up progress parsing on stderr
    if (childProcess.stderr) {
      const parser = createProgressParser((progress) => {
        lastProgress = progress;
        options.onProgress?.(progress);
      });

      childProcess.stderr.on('data', (chunk: Buffer) => {
        parser.feed(chunk.toString('utf-8'));
      });
    }

    await childProcess;

    const durationMs = Date.now() - startTime;
    syncLogger.info(
      { durationMs, filesTransferred: lastProgress?.filesTransferred ?? 0 },
      'rclone sync completed successfully',
    );

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: options.direction,
      status: 'completed',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if it was a cancellation
    if (abortSignal?.aborted) {
      syncLogger.info({ durationMs }, 'rclone sync was cancelled');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: options.direction,
        status: 'error',
        filesTransferred: lastProgress?.filesTransferred ?? 0,
        bytesTransferred: lastProgress?.bytesTransferred ?? 0,
        durationMs,
        error: 'Sync cancelled',
      };
    }

    syncLogger.error({ err: sanitizeRcloneError(errorMessage), durationMs }, 'rclone sync failed');

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: options.direction,
      status: 'error',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
      error: sanitizeRcloneError(errorMessage),
    };
  }
}

/**
 * Generate a unique operation ID for a sync operation.
 */
export function generateOperationId(): string {
  return randomUUID();
}

/**
 * Run an rclone sync dry-run to preview what would change.
 *
 * Executes `rclone sync --dry-run -v` with the same arguments as a real sync,
 * then returns the captured stderr output for parsing by `parseDryRunOutput()`.
 */
export async function runRcloneDryRun(
  options: RcloneSyncOptions,
  logger: Logger,
  agentDir?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const syncLogger = logger.child({
    component: 'rclone-dry-run',
    operationId: options.operationId,
    projectId: options.projectId,
    direction: options.direction,
  });

  const { source, destination } = buildSyncEndpoints(options);

  const args: string[] = [
    'sync',
    source,
    destination,
    '--dry-run',
    '-v',
    '--transfers',
    DEFAULT_TRANSFERS,
    '--checkers',
    DEFAULT_CHECKERS,
    '--retries',
    DEFAULT_RETRIES,
    '--low-level-retries',
    DEFAULT_LOW_LEVEL_RETRIES,
    ...buildIncludeFlags(options.includes, syncLogger),
    ...resolveExcludeFlags(options, syncLogger),
  ];

  syncLogger.info({ source, destination }, 'Starting rclone dry-run');

  /** Bounded stderr collection. */
  const MAX_LINES = 10_000;
  const stderrLines: string[] = [];
  let lineBuffer = '';

  try {
    const childProcess = execa('rclone', args, {
      ...(abortSignal ? { cancelSignal: abortSignal, gracefulCancel: true } : {}),
      env: buildRcloneEnv(options.rcloneConfigPath),
      extendEnv: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000, // 2 minute timeout for dry-run
    });

    if (childProcess.stderr) {
      childProcess.stderr.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString('utf-8');
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (stderrLines.length < MAX_LINES) {
            stderrLines.push(line);
          }
        }
      });
    }

    await childProcess;

    // Flush remaining buffer
    if (lineBuffer.length > 0 && stderrLines.length < MAX_LINES) {
      stderrLines.push(lineBuffer);
    }

    syncLogger.info({ lineCount: stderrLines.length }, 'rclone dry-run completed');
    return stderrLines.join('\n');
  } catch (error: unknown) {
    const errorMessage = sanitizeRcloneError(error instanceof Error ? error.message : String(error));
    syncLogger.error({ err: errorMessage }, 'rclone dry-run failed');
    throw new Error(errorMessage);
  }
}

/**
 * Run an rclone copy with --ignore-existing for protected pull mode.
 *
 * Downloads new files from remote without overwriting or deleting existing local files.
 * Uses `rclone copy` (not sync) with `--ignore-existing` to ensure:
 * - New remote files are downloaded
 * - Existing local files are never overwritten
 * - No local files are ever deleted
 */
export async function runRcloneProtectedPull(
  options: Omit<RcloneSyncOptions, 'direction'>,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<SyncResult> {
  const startTime = Date.now();
  const syncLogger = logger.child({
    component: 'rclone-runner',
    operationId: options.operationId,
    projectId: options.projectId,
    direction: 'pull' as const,
    mode: 'protected',
  });

  const remote = `${options.remoteName}:${options.bucket}/${options.remotePath}`;

  const args: string[] = [
    'copy',
    remote,
    options.localPath,
    '--ignore-existing',
    '--progress',
    '--stats-one-line',
    '--stats',
    DEFAULT_STATS_INTERVAL,
    '--transfers',
    DEFAULT_TRANSFERS,
    '--checkers',
    DEFAULT_CHECKERS,
    '--retries',
    DEFAULT_RETRIES,
    '--low-level-retries',
    DEFAULT_LOW_LEVEL_RETRIES,
    ...buildIncludeFlags(options.includes, syncLogger),
    ...resolveExcludeFlags(options, syncLogger),
    ...buildBandwidthFlags(options.bandwidthLimit),
  ];

  syncLogger.info({ remote, localPath: options.localPath }, 'Starting rclone protected pull (copy --ignore-existing)');

  let lastProgress: SyncProgress | undefined;

  try {
    const childProcess = execa('rclone', args, {
      cancelSignal: abortSignal,
      gracefulCancel: true,
      env: buildRcloneEnv(options.rcloneConfigPath),
      extendEnv: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (childProcess.stderr) {
      const parser = createProgressParser((progress) => {
        lastProgress = progress;
        options.onProgress?.(progress);
      });

      childProcess.stderr.on('data', (chunk: Buffer) => {
        parser.feed(chunk.toString('utf-8'));
      });
    }

    await childProcess;

    const durationMs = Date.now() - startTime;
    syncLogger.info(
      { durationMs, filesTransferred: lastProgress?.filesTransferred ?? 0 },
      'rclone protected pull completed successfully',
    );

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: 'pull',
      status: 'completed',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (abortSignal?.aborted) {
      syncLogger.info({ durationMs }, 'rclone protected pull was cancelled');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: 'pull',
        status: 'error',
        filesTransferred: lastProgress?.filesTransferred ?? 0,
        bytesTransferred: lastProgress?.bytesTransferred ?? 0,
        durationMs,
        error: 'Protected pull cancelled',
      };
    }

    syncLogger.error({ err: sanitizeRcloneError(errorMessage), durationMs }, 'rclone protected pull failed');

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: 'pull',
      status: 'error',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
      error: sanitizeRcloneError(errorMessage),
    };
  }
}

// ---------------------------------------------------------------------------
// Bisync conflict output parsing
// ---------------------------------------------------------------------------

/**
 * Regex patterns to detect conflict lines in rclone bisync stderr/stdout.
 *
 * rclone bisync reports conflicts with lines like:
 *   NOTICE: file.txt: is new on both paths
 *   NOTICE: file.txt: is changed on both paths
 *   WARNING: file.txt: files differ on both paths
 */
const BISYNC_CONFLICT_PATTERNS: ReadonlyArray<{
  readonly regex: RegExp;
  readonly type: BisyncConflict['type'];
}> = [
  {
    regex: /NOTICE:\s+(.+?):\s+is changed on both paths/,
    type: 'file-modified-both-sides',
  },
  {
    regex: /WARNING:\s+(.+?):\s+files differ on both paths/,
    type: 'file-modified-both-sides',
  },
  {
    regex: /NOTICE:\s+(.+?):\s+is new on both paths/,
    type: 'file-new-both-sides',
  },
  {
    regex: /NOTICE:\s+(.+?):\s+.*conflict/i,
    type: 'unknown',
  },
  {
    regex: /WARNING:\s+(.+?):\s+.*conflict/i,
    type: 'unknown',
  },
];

/**
 * Parse rclone bisync output for conflict information.
 */
export function parseBisyncConflicts(output: string): BisyncConflict[] {
  const conflicts: BisyncConflict[] = [];
  const seenPaths = new Set<string>();
  const now = new Date().toISOString();

  for (const line of output.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    for (const { regex, type } of BISYNC_CONFLICT_PATTERNS) {
      const match = regex.exec(trimmed);
      if (match?.[1]) {
        const filePath = match[1].trim();
        if (!seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          conflicts.push({
            path: filePath,
            type,
            detectedAt: now,
          });
        }
        break;
      }
    }
  }

  return conflicts;
}

/**
 * Build conflict resolution flags for rclone bisync.
 */
function buildConflictFlags(strategy: ConflictStrategy): string[] {
  switch (strategy) {
    case 'newest-wins':
      return ['--conflict-resolve', 'newer'];
    case 'local-wins':
      return ['--conflict-resolve', 'path1'];
    case 'remote-wins':
      return ['--conflict-resolve', 'path2'];
    case 'manual':
      // For manual resolution, don't auto-resolve — rclone will stop on conflicts.
      // Use --conflict-loser num to keep both versions with numbering.
      return ['--conflict-loser', 'num'];
  }
}

/**
 * Run an rclone bisync operation.
 *
 * Bidirectional sync using rclone bisync. The first run requires --resync
 * to establish the baseline. Subsequent runs detect and sync changes in
 * both directions.
 */
export async function runRcloneBisync(
  options: RcloneBisyncOptions,
  logger: Logger,
  abortSignal?: AbortSignal,
  agentDir?: string,
): Promise<SyncResult> {
  const startTime = Date.now();
  const syncLogger = logger.child({
    component: 'rclone-runner',
    operationId: options.operationId,
    projectId: options.projectId,
    direction: 'bidirectional' as const,
  });

  const remote = `${options.remoteName}:${options.bucket}/${options.remotePath}`;

  const args: string[] = [
    'bisync',
    options.localPath,
    remote,
    '--verbose',
    '--retries',
    DEFAULT_RETRIES,
    '--low-level-retries',
    DEFAULT_LOW_LEVEL_RETRIES,
    ...buildIncludeFlags(options.includes, syncLogger),
    ...resolveExcludeFlags(options, syncLogger),
    ...buildBandwidthFlags(options.bandwidthLimit),
    ...buildConflictFlags(options.conflictStrategy),
    ...(agentDir ? buildBisyncBackupDirFlags(options, agentDir) : []),
  ];

  // First run requires --resync to establish baseline
  if (options.resync) {
    args.push('--resync');
    syncLogger.info('Running bisync with --resync to establish baseline');
  }

  syncLogger.info(
    { localPath: options.localPath, remote, resync: options.resync },
    'Starting rclone bisync',
  );

  let lastProgress: SyncProgress | undefined;

  /** Maximum number of conflicts to collect from output. */
  const MAX_CONFLICTS = 1000;

  // Instead of accumulating all output, parse conflict lines as they arrive
  const conflicts: BisyncConflict[] = [];
  const seenConflictPaths = new Set<string>();
  const conflictTimestamp = new Date().toISOString();

  /**
   * Parse a single line for conflict patterns and add to the conflicts array.
   * Discards the raw text after parsing.
   */
  function parseLineForConflicts(line: string): void {
    if (conflicts.length >= MAX_CONFLICTS) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    for (const { regex, type } of BISYNC_CONFLICT_PATTERNS) {
      const match = regex.exec(trimmed);
      if (match?.[1]) {
        const filePath = match[1].trim();
        if (!seenConflictPaths.has(filePath)) {
          seenConflictPaths.add(filePath);
          conflicts.push({
            path: filePath,
            type,
            detectedAt: conflictTimestamp,
          });
        }
        break;
      }
    }
  }

  // Line buffers for incremental parsing (handles chunks that split across lines)
  let stderrLineBuffer = '';
  let stdoutLineBuffer = '';

  try {
    const childProcess = execa('rclone', args, {
      cancelSignal: abortSignal,
      gracefulCancel: true,
      env: buildRcloneEnv(options.rcloneConfigPath),
      extendEnv: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Parse stderr line-by-line for conflicts and progress
    if (childProcess.stderr) {
      const parser = createProgressParser((progress) => {
        lastProgress = progress;
        options.onProgress?.(progress);
      });

      childProcess.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        parser.feed(text);

        // Parse lines for conflict detection
        stderrLineBuffer += text;
        const lines = stderrLineBuffer.split(/\r?\n/);
        // Keep the last (potentially incomplete) line in the buffer
        stderrLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          parseLineForConflicts(line);
        }
      });
    }

    // Parse stdout line-by-line for conflicts (bisync may output conflict info there)
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          parseLineForConflicts(line);
        }
      });
    }

    await childProcess;

    // Flush any remaining buffered content
    if (stderrLineBuffer.length > 0) parseLineForConflicts(stderrLineBuffer);
    if (stdoutLineBuffer.length > 0) parseLineForConflicts(stdoutLineBuffer);

    const durationMs = Date.now() - startTime;

    if (conflicts.length > 0) {
      syncLogger.info({ conflictCount: conflicts.length }, 'Bisync completed with conflicts');
    } else {
      syncLogger.info({ durationMs }, 'rclone bisync completed successfully');
    }

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: 'bidirectional',
      status: 'completed',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Flush any remaining buffered content
    if (stderrLineBuffer.length > 0) parseLineForConflicts(stderrLineBuffer);
    if (stdoutLineBuffer.length > 0) parseLineForConflicts(stdoutLineBuffer);

    if (abortSignal?.aborted) {
      syncLogger.info({ durationMs }, 'rclone bisync was cancelled');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        direction: 'bidirectional',
        status: 'error',
        filesTransferred: lastProgress?.filesTransferred ?? 0,
        bytesTransferred: lastProgress?.bytesTransferred ?? 0,
        durationMs,
        error: 'Bisync cancelled',
      };
    }

    syncLogger.error(
      { err: sanitizeRcloneError(errorMessage), durationMs, conflictCount: conflicts.length },
      'rclone bisync failed',
    );

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: 'bidirectional',
      status: 'error',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
      error: sanitizeRcloneError(errorMessage),
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }
}
