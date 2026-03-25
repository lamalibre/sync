/**
 * Build trash directory paths for --backup-dir usage.
 *
 * Each sync/bisync operation that deletes or overwrites a file sends the
 * old version to a timestamped directory under `.sync-trash/`.
 */

import { join } from 'node:path';

export const SYNC_TRASH_DIR = '.sync-trash';

/** Validate that a projectId is safe for path construction. */
function assertSafeProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId.includes('..') ||
    projectId.includes('\0')
  ) {
    throw new Error(`Unsafe projectId for path construction: "${projectId}"`);
  }
}

/**
 * Hourly timestamp safe for directory names (no colons).
 *
 * Uses hour-level granularity so that multiple syncs within the same hour
 * share a single trash directory. This prevents unbounded directory
 * accumulation for high-frequency watch-triggered syncs.
 */
function trashTimestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-00-00-000Z`;
}

/** Parse timestamp from trash directory name back to Date. Returns null if invalid. */
export function parseTrashTimestamp(dirName: string): Date | null {
  // Format: 2026-03-25T14-30-00-000Z → reverse to 2026-03-25T14:30:00.000Z
  const iso = dirName.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
    'T$1:$2:$3.$4Z',
  );
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Remote: {remoteName}:{bucket}/.sync-trash/{projectId}/{timestamp}/ */
export function buildRemoteTrashPath(
  remoteName: string,
  bucket: string,
  projectId: string,
): string {
  assertSafeProjectId(projectId);
  return `${remoteName}:${bucket}/${SYNC_TRASH_DIR}/${projectId}/${trashTimestamp()}`;
}

/** Local: {agentDir}/.sync-trash/{projectId}/{timestamp}/ */
export function buildLocalTrashPath(
  agentDir: string,
  projectId: string,
): string {
  assertSafeProjectId(projectId);
  return join(agentDir, SYNC_TRASH_DIR, projectId, trashTimestamp());
}
