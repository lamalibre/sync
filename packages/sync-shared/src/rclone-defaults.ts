/**
 * Default rclone transfer settings per the ARCHITECTURE.md spec.
 *
 * These constants are used by both rclone-runner.ts (sync/bisync)
 * and archive.ts (archive/restore) in the sync-agent package.
 */

export const DEFAULT_TRANSFERS = '4';
export const DEFAULT_CHECKERS = '8';
export const DEFAULT_STATS_INTERVAL = '2s';
export const DEFAULT_RETRIES = '3';
export const DEFAULT_LOW_LEVEL_RETRIES = '10';
