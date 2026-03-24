/**
 * Atomic file write: write to temp file, fsync, then rename.
 * Ensures that partial writes never corrupt the target file.
 */

import { writeFile, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write data to a file atomically.
 * Creates a temporary file in the same directory, writes + fsyncs it,
 * then renames it to the target path.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  mode?: number,
): Promise<void> {
  const dir = dirname(filePath);
  const tmpName = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);

  try {
    // Write to temp file
    await writeFile(tmpName, data, { mode: mode ?? 0o644 });

    // fsync the file to ensure data is on disk
    const fd = await open(tmpName, 'r');
    await fd.sync();
    await fd.close();

    // Atomic rename
    await rename(tmpName, filePath);
  } catch (error: unknown) {
    // Clean up temp file on failure
    try {
      await unlink(tmpName);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
