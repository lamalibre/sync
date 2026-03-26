/**
 * Parse rclone --dry-run -v output to extract planned file changes.
 *
 * rclone with `--dry-run -v` outputs lines like:
 *   NOTICE: path/to/file: Skipped copy as --dry-run is set
 *   NOTICE: path/to/file: Skipped delete as --dry-run is set
 *   NOTICE: path/to/file: Skipped update modification time as --dry-run is set
 */

import type { DryRunChange } from '@lamalibre/sync-shared';

const COPY_PATTERN = /NOTICE:\s+(.+?):\s+Skipped (?:copy|move) as --dry-run is set/;
const DELETE_PATTERN = /NOTICE:\s+(.+?):\s+Skipped delete as --dry-run is set/;

/**
 * Parse rclone dry-run output into structured changes.
 * Handles both sync and bisync output formats.
 */
export function parseDryRunOutput(output: string): DryRunChange[] {
  const changes: DryRunChange[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let match = COPY_PATTERN.exec(trimmed);
    if (match?.[1]) {
      changes.push({ path: match[1].trim(), action: 'copy' });
      continue;
    }

    match = DELETE_PATTERN.exec(trimmed);
    if (match?.[1]) {
      changes.push({ path: match[1].trim(), action: 'delete' });
    }
  }

  return changes;
}
