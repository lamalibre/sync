/**
 * Write resolved rclone exclude patterns to an --exclude-from file.
 *
 * Each project gets its own filter file under `<agentDir>/exclude-filters/`.
 * The file is written atomically and only rewritten when content changes
 * (compared by SHA-256 hash to avoid unnecessary disk writes).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-write.js';
import { isNodeError } from './types.js';

/** Directory name under the agent dir where filter files are stored. */
const FILTER_DIR = 'exclude-filters';

/** Only allow safe characters in projectId to prevent path traversal. */
const SAFE_PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Patterns starting with rclone filter prefixes (+, -, !) could alter
 * rclone's include/exclude logic when written to an --exclude-from file.
 * Strip them as defense-in-depth (the server also validates API excludes).
 */
const RCLONE_FILTER_PREFIX = /^[+\-!]/;

/**
 * Write resolved rclone exclude patterns to a filter file.
 *
 * Uses atomic write (temp → fsync → rename). Returns the absolute path to
 * the file, which can be passed to rclone via `--exclude-from`.
 *
 * Only rewrites the file if the content has changed (SHA-256 comparison).
 */
export async function writeExcludeFromFile(
  agentDir: string,
  projectId: string,
  patterns: readonly string[],
): Promise<string> {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new Error(`Invalid projectId for exclude file: ${projectId}`);
  }

  const filterDir = join(agentDir, FILTER_DIR);
  await mkdir(filterDir, { recursive: true, mode: 0o700 });

  const filePath = join(filterDir, `${projectId}.exclude`);

  // Strip patterns that start with rclone filter prefixes to prevent
  // a malicious .gitignore/.syncignore from injecting include rules.
  const safePatterns = patterns.filter((p) => !RCLONE_FILTER_PREFIX.test(p));
  const content = safePatterns.join('\n') + '\n';

  // Check if the file already has the same content (avoid unnecessary writes)
  const newHash = createHash('sha256').update(content).digest('hex');

  try {
    const existing = await readFile(filePath, 'utf-8');
    const existingHash = createHash('sha256').update(existing).digest('hex');
    if (newHash === existingHash) {
      return filePath;
    }
  } catch (err: unknown) {
    // File doesn't exist yet — write it
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      // Unexpected error reading; proceed to overwrite
    }
  }

  await atomicWriteFile(filePath, content, 0o600);
  return filePath;
}
