/**
 * Shared response types for CLI commands.
 *
 * These mirror the server's project JSON shape so each command
 * file does not need its own interface definition.
 */

/** Project as returned by the server's GET /api/sync/projects endpoint. */
export interface Project {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  direction: string;
  excludes: string[];
  schedule: string | null;
  encrypted: boolean;
  conflictStrategy: string;
  watch: boolean;
  trigger: string;
  status: string;
  lastSync: string | null;
  deletedAt: string | null;
}
