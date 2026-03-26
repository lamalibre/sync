/**
 * Machine-local path mapping for sync projects.
 *
 * Local filesystem paths never leave any machine. Projects are identified
 * by UUID. Each machine stores its own `projectId → localPath` mapping
 * privately in this file. No local path ever appears in API requests
 * or responses.
 *
 * This module is the primary mechanism for resolving which local directory
 * a project maps to. The `agent-approve` CLI command is where users set
 * these mappings.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, normalize } from 'node:path';
import { atomicWriteFile } from './atomic-write.js';
import { DEFAULT_DELETE_THRESHOLD, PROJECT_ID_RE, type AccessMode, type ConfirmMode, type SyncDirection } from './types.js';

/**
 * Check whether an entry has a valid projectId and localPath.
 * Used to silently discard corrupted or tampered entries on load.
 */
function isValidEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  if (typeof obj['projectId'] !== 'string' || !PROJECT_ID_RE.test(obj['projectId'])) return false;
  if (typeof obj['localPath'] !== 'string') return false;
  const localPath = obj['localPath'];
  if (localPath.length > 4096) return false;
  if (!isAbsolute(localPath)) return false;
  if (localPath.includes('\0')) return false;
  if (/[\x01-\x1f\x7f]/.test(localPath)) return false;
  const normalized = normalize(localPath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) return false;
  return true;
}

/**
 * Validate a local filesystem path for use in path mappings.
 * Returns null if valid, or a human-readable error message if invalid.
 */
export function validateLocalPath(inputPath: string): string | null {
  if (inputPath.length > 4096) {
    return 'Path must be at most 4096 characters';
  }
  if (!isAbsolute(inputPath)) {
    return 'Path must be absolute (e.g. /Users/you/projects/my-project)';
  }
  if (inputPath.includes('\0')) {
    return 'Path must not contain null bytes';
  }
  if (/[\x01-\x1f\x7f]/.test(inputPath)) {
    return 'Path must not contain control characters';
  }
  const normalized = normalize(inputPath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) {
    return 'Path must not contain ".." segments';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single path mapping entry binding a project to a local directory. */
export interface ApprovedPathEntry {
  /** The project ID this mapping is bound to. */
  readonly projectId: string;
  /** The local absolute path this project maps to on this machine. */
  readonly localPath: string;
  /** ISO 8601 timestamp of when the mapping was created/updated. */
  readonly approvedAt: string;
  /** Human-readable project name at the time of approval (informational only). */
  readonly projectName: string;
  /** Local access mode override. Defaults to 'full' if absent. */
  readonly accessMode?: AccessMode;
  /** Confirmation mode for sync preview. Defaults based on project direction if absent. */
  readonly confirmMode?: ConfirmMode;
  /** Require confirmation if more than this many files would be deleted. */
  readonly deleteThreshold?: number;
}

/** On-disk format for the path mapping file. */
export interface ApprovedPathsFile {
  /** Schema version for forward compatibility. */
  readonly version: 1;
  readonly entries: readonly ApprovedPathEntry[];
}

/** Minimal project info from server (no localPath — server doesn't know it). */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APPROVED_PATHS_FILENAME = 'approved-paths.json';

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read the path mapping file from disk.
 * Returns an empty file structure if the file doesn't exist or is corrupted.
 */
export async function readApprovedPaths(
  agentDir: string,
  onError?: (error: Error) => void,
): Promise<ApprovedPathsFile> {
  const filePath = join(agentDir, APPROVED_PATHS_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      (parsed as { version: unknown }).version === 1 &&
      'entries' in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
    ) {
      // Filter out entries with invalid projectId or localPath to guard
      // against tampered or corrupted data on disk.
      const validated = parsed as { version: 1; entries: unknown[] };
      const validEntries = validated.entries.filter(isValidEntry) as ApprovedPathEntry[];
      return { version: 1, entries: validEntries };
    }
    return emptyApprovedPaths();
  } catch (err: unknown) {
    // ENOENT is expected on first run — no need to report.
    // Other errors (permission denied, corrupted JSON) are unexpected
    // and should be surfaced to the caller for logging.
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound && onError && err instanceof Error) {
      onError(err);
    }
    // Fail-safe: return empty set — blocks all syncs until re-approved.
    return emptyApprovedPaths();
  }
}

/**
 * Write the path mapping file atomically.
 * File is written with mode 0600 (owner read/write only).
 */
export async function writeApprovedPaths(
  agentDir: string,
  data: ApprovedPathsFile,
): Promise<void> {
  const filePath = join(agentDir, APPROVED_PATHS_FILENAME);
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n', 0o600);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local path for a project. Returns null if no mapping exists.
 * This is the primary lookup — local paths come from here, never from the server.
 */
export function getLocalPath(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
): string | null {
  const entry = approvedPaths.entries.find((e) => e.projectId === projectId);
  return entry?.localPath ?? null;
}

/**
 * Check whether a project has an approved local path mapping.
 */
export function hasApprovedPath(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
): boolean {
  return approvedPaths.entries.some((e) => e.projectId === projectId);
}

// ---------------------------------------------------------------------------
// Mutation functions
// ---------------------------------------------------------------------------

/**
 * Add or update a path mapping entry.
 * If an entry for the same projectId already exists, it is replaced.
 */
export function addApproval(
  approvedPaths: ApprovedPathsFile,
  entry: ApprovedPathEntry,
): ApprovedPathsFile {
  const validationError = validateLocalPath(entry.localPath);
  if (validationError) {
    throw new Error(`Cannot add approval: ${validationError}`);
  }
  const filtered = approvedPaths.entries.filter((e) => e.projectId !== entry.projectId);
  return {
    version: 1,
    entries: [
      ...filtered,
      {
        ...entry,
        localPath: resolve(entry.localPath),
      },
    ],
  };
}

/**
 * Remove a path mapping by projectId.
 */
export function removeApproval(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
): ApprovedPathsFile {
  return {
    version: 1,
    entries: approvedPaths.entries.filter((e) => e.projectId !== projectId),
  };
}

/**
 * List projects from the server that have no local path mapping yet.
 * These need the user to run `agent-approve` to set a local path.
 */
export function getUnmappedProjects(
  approvedPaths: ApprovedPathsFile,
  projects: readonly ProjectInfo[],
): readonly ProjectInfo[] {
  return projects.filter(
    (project) => !hasApprovedPath(approvedPaths, project.id),
  );
}

/**
 * Prune entries whose projectId no longer exists in the active project set.
 */
export function pruneStaleApprovals(
  approvedPaths: ApprovedPathsFile,
  activeProjectIds: ReadonlySet<string>,
): ApprovedPathsFile {
  return {
    version: 1,
    entries: approvedPaths.entries.filter((e) => activeProjectIds.has(e.projectId)),
  };
}

// ---------------------------------------------------------------------------
// Access mode and confirm mode helpers
// ---------------------------------------------------------------------------

/**
 * Get the access mode for a project. Returns 'full' if not set.
 */
export function getAccessMode(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
): AccessMode {
  const entry = approvedPaths.entries.find((e) => e.projectId === projectId);
  return entry?.accessMode ?? 'full';
}

/**
 * Get the confirm mode for a project.
 * Defaults to 'confirm-destructive' for bidirectional, 'auto' for push/pull.
 */
export function getConfirmMode(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
  projectDirection: SyncDirection,
): ConfirmMode {
  const entry = approvedPaths.entries.find((e) => e.projectId === projectId);
  if (entry?.confirmMode) return entry.confirmMode;
  return projectDirection === 'bidirectional' ? 'confirm-destructive' : 'auto';
}

/**
 * Get the delete threshold for a project. Returns default if not set.
 */
export function getDeleteThreshold(
  approvedPaths: ApprovedPathsFile,
  projectId: string,
): number {
  const entry = approvedPaths.entries.find((e) => e.projectId === projectId);
  return entry?.deleteThreshold ?? DEFAULT_DELETE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyApprovedPaths(): ApprovedPathsFile {
  return { version: 1, entries: [] };
}
