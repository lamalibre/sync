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
} from '@lamalibre/sync-shared';
import { createProgressParser } from './progress-parser.js';
import type {
  RcloneSyncOptions,
  RcloneBisyncOptions,
  SyncProgress,
  SyncResult,
  BisyncConflict,
  ConflictStrategy,
} from './types.js';

/**
 * Build the exclude flags array from exclude patterns.
 * Each pattern becomes a separate --exclude argument.
 */
export function buildExcludeFlags(excludes: readonly string[]): string[] {
  const flags: string[] = [];
  for (const pattern of excludes) {
    flags.push('--exclude', pattern);
  }
  return flags;
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
      // Bidirectional is handled by runRcloneBisync; if called here, fall through to push
      return { source: options.localPath, destination: remote };
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
    '--config',
    options.rcloneConfigPath,
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
    ...buildExcludeFlags(options.excludes),
    ...buildBandwidthFlags(options.bandwidthLimit),
  ];

  syncLogger.info({ source, destination }, 'Starting rclone sync');

  let lastProgress: SyncProgress | undefined;

  try {
    const childProcess = execa('rclone', args, {
      cancelSignal: abortSignal,
      gracefulCancel: true,
      // Do not pass credentials as CLI arguments;
      // rclone reads them from the config file.
      env: {
        // Inherit parent env, only set RCLONE_CONFIG explicitly
        RCLONE_CONFIG: options.rcloneConfigPath,
      },
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

    syncLogger.error({ err: errorMessage, durationMs }, 'rclone sync failed');

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      direction: options.direction,
      status: 'error',
      filesTransferred: lastProgress?.filesTransferred ?? 0,
      bytesTransferred: lastProgress?.bytesTransferred ?? 0,
      durationMs,
      error: errorMessage,
    };
  }
}

/**
 * Generate a unique operation ID for a sync operation.
 */
export function generateOperationId(): string {
  return randomUUID();
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
    '--config',
    options.rcloneConfigPath,
    '--verbose',
    '--retries',
    DEFAULT_RETRIES,
    '--low-level-retries',
    DEFAULT_LOW_LEVEL_RETRIES,
    ...buildExcludeFlags(options.excludes),
    ...buildBandwidthFlags(options.bandwidthLimit),
    ...buildConflictFlags(options.conflictStrategy),
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
      env: {
        RCLONE_CONFIG: options.rcloneConfigPath,
      },
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
      { err: errorMessage, durationMs, conflictCount: conflicts.length },
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
      error: errorMessage,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }
}
