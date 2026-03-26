/**
 * Archive and restore operations using rclone.
 *
 * Archive: rclone move local -> remote, then write stub.
 * Restore: rclone copy remote -> local, then remove stub.
 *
 * All rclone invocations use execa with array arguments (never shell interpolation).
 */

import { execa } from 'execa';
import { stat, unlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import {
  DEFAULT_TRANSFERS,
  DEFAULT_CHECKERS,
  DEFAULT_STATS_INTERVAL,
  DEFAULT_RETRIES,
  DEFAULT_LOW_LEVEL_RETRIES,
} from '@lamalibre/sync-shared';
import { createProgressParser } from './progress-parser.js';
import { buildIncludeFlags, buildExcludeFlags, buildBandwidthFlags, buildRcloneEnv, sanitizeRcloneError } from './rclone-runner.js';
import { buildRemoteTrashPath } from './trash-paths.js';
import { scanDirectory, buildStubData, writeStub, readStub, STUB_FILENAME } from './stub.js';
import type { SyncProgress, SoftDeleteConfig, ProviderType } from './types.js';
import type { StubData } from './stub.js';

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export interface ArchiveOptions {
  readonly operationId: string;
  readonly projectId: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly rcloneConfigPath: string;
  readonly remoteName: string;
  readonly bucket: string;
  readonly provider: ProviderType;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly bandwidthLimit?: string;
  readonly softDelete?: SoftDeleteConfig;
  readonly onProgress?: (progress: SyncProgress) => void;
}

export interface ArchiveResult {
  readonly operationId: string;
  readonly projectId: string;
  readonly status: 'completed' | 'error';
  readonly totalSize: number;
  readonly fileCount: number;
  readonly spaceFreed: number;
  readonly durationMs: number;
  readonly error?: string;
}

/**
 * Archive a project's local files to the remote.
 *
 * 1. Scan the local directory to build the file manifest.
 * 2. Run `rclone move` to upload files and remove local copies.
 * 3. Write the stub file into the (now empty) local directory.
 */
export async function runArchive(
  options: ArchiveOptions,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<ArchiveResult> {
  const startTime = Date.now();
  const archiveLogger = logger.child({
    component: 'archive',
    operationId: options.operationId,
    projectId: options.projectId,
  });

  try {
    // 1. Scan before we move anything
    archiveLogger.info({ localPath: options.localPath }, 'Scanning directory before archive');
    const scan = await scanDirectory(options.localPath);

    if (scan.fileCount === 0) {
      archiveLogger.info('No files to archive');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'completed',
        totalSize: 0,
        fileCount: 0,
        spaceFreed: 0,
        durationMs: Date.now() - startTime,
      };
    }

    archiveLogger.info(
      { totalSize: scan.totalSize, fileCount: scan.fileCount },
      'Directory scan complete, starting rclone move',
    );

    // 2. rclone move local -> remote
    const remote = `${options.remoteName}:${options.bucket}/${options.remotePath}`;
    const args: string[] = [
      'move',
      options.localPath,
      remote,
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
      '--delete-empty-src-dirs',
      ...buildIncludeFlags(options.includes),
      ...buildExcludeFlags(options.excludes),
      // Exclude the stub file from being moved
      '--exclude',
      STUB_FILENAME,
      ...buildBandwidthFlags(options.bandwidthLimit),
      // When soft delete is enabled, overwritten remote files go to trash
      ...(options.softDelete?.enabled
        ? ['--backup-dir', buildRemoteTrashPath(options.remoteName, options.bucket, options.projectId)]
        : []),
    ];

    archiveLogger.info({ remote }, 'Starting rclone move');

    const childProcess = execa('rclone', args, {
      cancelSignal: abortSignal,
      gracefulCancel: true,
      env: buildRcloneEnv(options.rcloneConfigPath),
      extendEnv: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Parse progress from stderr
    if (childProcess.stderr) {
      const parser = createProgressParser((progress) => {
        options.onProgress?.(progress);
      });
      childProcess.stderr.on('data', (chunk: Buffer) => {
        parser.feed(chunk.toString('utf-8'));
      });
    }

    await childProcess;

    archiveLogger.info('rclone move completed');

    // 3. Ensure the local directory still exists (rclone --delete-empty-src-dirs may remove it)
    await mkdir(options.localPath, { recursive: true });

    // 4. Write the stub file
    const stubData = buildStubData({
      scan,
      remotePath: options.remotePath,
      provider: options.provider,
      bucket: options.bucket,
      projectId: options.projectId,
    });

    const stubPath = await writeStub(options.localPath, stubData);
    const stubStat = await stat(stubPath);
    const spaceFreed = Math.max(0, scan.totalSize - stubStat.size);

    archiveLogger.info({ spaceFreed, stubPath }, 'Stub written, archive complete');

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      status: 'completed',
      totalSize: scan.totalSize,
      fileCount: scan.fileCount,
      spaceFreed,
      durationMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (abortSignal?.aborted) {
      archiveLogger.info({ durationMs }, 'Archive was cancelled');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'error',
        totalSize: 0,
        fileCount: 0,
        spaceFreed: 0,
        durationMs,
        error: 'Archive cancelled',
      };
    }

    archiveLogger.error({ err: sanitizeRcloneError(errorMessage), durationMs }, 'Archive failed');
    return {
      operationId: options.operationId,
      projectId: options.projectId,
      status: 'error',
      totalSize: 0,
      fileCount: 0,
      spaceFreed: 0,
      durationMs,
      error: sanitizeRcloneError(errorMessage),
    };
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  readonly operationId: string;
  readonly projectId: string;
  readonly localPath: string;
  readonly rcloneConfigPath: string;
  readonly remoteName: string;
  readonly bucket: string;
  readonly bandwidthLimit?: string;
  /** When set, restore only a single file instead of the whole project. */
  readonly singleFilePath?: string;
  /** Pre-loaded stub data to avoid re-reading from disk. */
  readonly preloadedStub?: StubData;
  readonly onProgress?: (progress: SyncProgress) => void;
  /** Expected bucket from the project config, used to validate the stub. */
  readonly expectedBucket: string;
  /** Expected remote path from the project config, used to validate the stub. */
  readonly expectedRemotePath: string;
}

export interface RestoreResult {
  readonly operationId: string;
  readonly projectId: string;
  readonly status: 'completed' | 'error';
  readonly filesRestored: number;
  readonly bytesRestored: number;
  readonly durationMs: number;
  readonly error?: string;
}

/**
 * Restore an archived project (or a single file) from the remote.
 *
 * 1. Read the stub to discover the remote path.
 * 2. Run `rclone copy` from remote to local.
 * 3. Verify downloaded file sizes.
 * 4. Remove the stub file.
 */
export async function runRestore(
  options: RestoreOptions,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<RestoreResult> {
  const startTime = Date.now();
  const restoreLogger = logger.child({
    component: 'restore',
    operationId: options.operationId,
    projectId: options.projectId,
  });

  try {
    // 1. Use pre-loaded stub if available, otherwise read from disk
    const stub = options.preloadedStub ?? (await readStub(options.localPath));
    if (!stub) {
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'error',
        filesRestored: 0,
        bytesRestored: 0,
        durationMs: Date.now() - startTime,
        error: 'No stub file found — project may not be archived',
      };
    }

    // Validate stub bucket and remotePath against the project's configured values
    // to prevent a tampered stub from redirecting the restore to a different location.
    if (stub.bucket !== options.expectedBucket) {
      throw new Error(
        `Stub bucket mismatch: expected ${options.expectedBucket}, got ${stub.bucket}`,
      );
    }
    if (stub.remotePath !== options.expectedRemotePath) {
      throw new Error(
        `Stub remotePath mismatch: expected ${options.expectedRemotePath}, got ${stub.remotePath}`,
      );
    }
    if (stub.projectId !== options.projectId) {
      throw new Error(
        `Stub projectId mismatch: expected ${options.projectId}, got ${stub.projectId}`,
      );
    }

    restoreLogger.info(
      {
        remotePath: stub.remotePath,
        fileCount: stub.fileCount,
        totalSize: stub.totalSize,
        singleFile: options.singleFilePath ?? null,
      },
      'Stub file read, starting restore',
    );

    // 2. Build rclone copy command
    const remote = `${options.remoteName}:${stub.bucket}/${stub.remotePath}`;
    const args: string[] = [
      'copy',
      remote,
      options.localPath,
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
      ...buildBandwidthFlags(options.bandwidthLimit),
    ];

    // Single-file restore: use --include to limit to one file
    if (options.singleFilePath) {
      // Defense-in-depth: validate singleFilePath at the agent before passing to rclone.
      // The server validates this too, but the agent may receive values from cache or future code paths.
      if (
        options.singleFilePath.includes('\0') ||
        options.singleFilePath.includes('..') ||
        options.singleFilePath.startsWith('/')
      ) {
        throw new Error('Invalid singleFilePath: contains null bytes, ".." segments, or is absolute');
      }
      args.push('--include', options.singleFilePath);
    }

    restoreLogger.info({ remote }, 'Starting rclone copy');

    let lastProgress: SyncProgress | undefined;

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

    restoreLogger.info('rclone copy completed');

    // 3. Verify sizes if stub has file list (batched parallel stats)
    if (stub.files && !options.singleFilePath) {
      let verifiedCount = 0;
      const VERIFY_BATCH_SIZE = 50;

      for (let i = 0; i < stub.files.length; i += VERIFY_BATCH_SIZE) {
        const batch = stub.files.slice(i, i + VERIFY_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (entry) => {
            try {
              // Validate entry.path to prevent traversal via tampered stub.
              // Append separator to base to prevent prefix-match escape
              // (e.g. /foo/bar matching /foo/barsecret).
              const resolvedBase = resolve(options.localPath) + '/';
              const fullPath = resolve(join(options.localPath, entry.path));
              if (!fullPath.startsWith(resolvedBase)) {
                restoreLogger.warn({ path: entry.path }, 'Skipping stub entry with path traversal');
                return false;
              }
              const fileStat = await stat(fullPath);
              if (fileStat.size === entry.size) {
                return true;
              }
              restoreLogger.warn(
                {
                  path: entry.path,
                  expected: entry.size,
                  actual: fileStat.size,
                },
                'Size mismatch after restore',
              );
              return false;
            } catch {
              restoreLogger.warn({ path: entry.path }, 'File missing after restore');
              return false;
            }
          }),
        );
        verifiedCount += results.filter(Boolean).length;
      }
      restoreLogger.info({ verifiedCount, total: stub.files.length }, 'File verification complete');
    }

    // 4. Remove the stub file (full restore only)
    if (!options.singleFilePath) {
      const stubPath = join(options.localPath, STUB_FILENAME);
      try {
        await unlink(stubPath);
        restoreLogger.info('Stub file removed');
      } catch {
        restoreLogger.warn('Failed to remove stub file');
      }
    }

    const durationMs = Date.now() - startTime;
    const filesRestored = lastProgress?.filesTransferred ?? stub.fileCount;
    const bytesRestored = lastProgress?.bytesTransferred ?? stub.totalSize;

    restoreLogger.info({ filesRestored, bytesRestored, durationMs }, 'Restore complete');

    return {
      operationId: options.operationId,
      projectId: options.projectId,
      status: 'completed',
      filesRestored,
      bytesRestored,
      durationMs,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (abortSignal?.aborted) {
      restoreLogger.info({ durationMs }, 'Restore was cancelled');
      return {
        operationId: options.operationId,
        projectId: options.projectId,
        status: 'error',
        filesRestored: 0,
        bytesRestored: 0,
        durationMs,
        error: 'Restore cancelled',
      };
    }

    restoreLogger.error({ err: sanitizeRcloneError(errorMessage), durationMs }, 'Restore failed');
    return {
      operationId: options.operationId,
      projectId: options.projectId,
      status: 'error',
      filesRestored: 0,
      bytesRestored: 0,
      durationMs,
      error: sanitizeRcloneError(errorMessage),
    };
  }
}
