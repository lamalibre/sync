/**
 * Trash cleanup — removes expired timestamped directories from both
 * the local agent directory and the remote storage.
 *
 * All rclone invocations use execa with array arguments (never shell interpolation).
 */

import { readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Logger } from 'pino';
import { isNodeError } from '@lamalibre/sync-shared';
import { SYNC_TRASH_DIR, parseTrashTimestamp } from './trash-paths.js';

export interface TrashCleanupOptions {
  readonly projectId: string;
  readonly agentDir: string;
  readonly rcloneConfigPath: string;
  readonly remoteName: string;
  readonly bucket: string;
  readonly retentionDays: number;
}

export interface TrashCleanupResult {
  readonly localDirsRemoved: number;
  readonly remoteDirsRemoved: number;
}

/**
 * Clean up expired trash directories for a single project.
 *
 * Local: reads directories under {agentDir}/.sync-trash/{projectId}/
 * Remote: uses `rclone lsf --dirs-only` then `rclone purge` for expired dirs.
 */
export async function cleanupProjectTrash(
  options: TrashCleanupOptions,
  logger: Logger,
): Promise<TrashCleanupResult> {
  const cutoff = Date.now() - options.retentionDays * 86_400_000;
  const cleanupLogger = logger.child({
    component: 'trash-cleanup',
    projectId: options.projectId,
  });

  let localDirsRemoved = 0;
  let remoteDirsRemoved = 0;

  // --- Local cleanup ---
  const localTrashDir = join(options.agentDir, SYNC_TRASH_DIR, options.projectId);
  try {
    const entries = await readdir(localTrashDir);
    for (const entry of entries) {
      const ts = parseTrashTimestamp(entry);
      if (!ts || ts.getTime() >= cutoff) continue;

      const entryPath = join(localTrashDir, entry);
      try {
        const st = await lstat(entryPath);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          await rm(entryPath, { recursive: true });
          localDirsRemoved++;
        }
      } catch (err: unknown) {
        cleanupLogger.warn(
          { err: err instanceof Error ? err.message : String(err), path: entryPath },
          'Failed to remove local trash directory',
        );
      }
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // No local trash directory — nothing to clean
    } else {
      cleanupLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to read local trash directory',
      );
    }
  }

  // --- Remote cleanup ---
  const remoteTrashPrefix = `${options.remoteName}:${options.bucket}/${SYNC_TRASH_DIR}/${options.projectId}/`;
  try {
    const { stdout } = await execa('rclone', [
      'lsf',
      '--dirs-only',
      '--config',
      options.rcloneConfigPath,
      remoteTrashPrefix,
    ], {
      env: { RCLONE_CONFIG: options.rcloneConfigPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const remoteDirs = stdout.split('\n').filter((line) => line.trim().length > 0);
    for (const dirName of remoteDirs) {
      // rclone lsf returns names with trailing slash, strip it
      const name = dirName.replace(/\/$/, '');

      // Validate directory name: must be a pure timestamp with no path separators
      // or traversal sequences. This prevents a malicious remote directory from
      // causing rclone purge to target paths outside the project's trash scope.
      if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
        cleanupLogger.warn({ dir: name }, 'Skipping remote trash directory with unsafe name');
        continue;
      }

      const ts = parseTrashTimestamp(name);
      if (!ts || ts.getTime() >= cutoff) continue;

      try {
        await execa('rclone', [
          'purge',
          '--config',
          options.rcloneConfigPath,
          `${remoteTrashPrefix}${name}/`,
        ], {
          env: { RCLONE_CONFIG: options.rcloneConfigPath },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        remoteDirsRemoved++;
      } catch (err: unknown) {
        cleanupLogger.warn(
          { err: err instanceof Error ? err.message : String(err), dir: name },
          'Failed to purge remote trash directory',
        );
      }
    }
  } catch (err: unknown) {
    // rclone lsf fails if the directory doesn't exist — that's fine
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('directory not found') && !msg.includes('not exist')) {
      cleanupLogger.warn(
        { err: msg },
        'Failed to list remote trash directories',
      );
    }
  }

  if (localDirsRemoved > 0 || remoteDirsRemoved > 0) {
    cleanupLogger.info(
      { localDirsRemoved, remoteDirsRemoved },
      'Trash cleanup completed',
    );
  }

  return { localDirsRemoved, remoteDirsRemoved };
}
