/**
 * Pending sync preview management.
 *
 * When a project's confirm mode requires user approval before syncing,
 * the agent runs rclone --dry-run, saves the results here, and waits
 * for the user to approve or reject via CLI before executing.
 *
 * Pending syncs are stored as individual JSON files in
 * `<agentDir>/pending-syncs/<projectId>.json`.
 */

import { readFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-write.js';
import { isNodeError, PROJECT_ID_RE, PROJECT_ID_MAX_LENGTH, SYNC_DIRECTIONS, type SyncDirection } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file change detected by dry-run. */
export interface DryRunChange {
  readonly path: string;
  readonly action: 'copy' | 'delete';
}

/** A pending sync preview awaiting user approval. */
export interface PendingSyncPreview {
  readonly projectId: string;
  readonly projectName: string;
  readonly operationId: string;
  readonly direction: SyncDirection;
  readonly localPath: string;
  readonly remotePath: string;
  readonly trigger: 'manual' | 'watch' | 'schedule';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly copyCount: number;
  readonly deleteCount: number;
  /** Capped at MAX_PREVIEW_CHANGES to keep file size reasonable. */
  readonly changes: readonly DryRunChange[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a projectId is safe to use as a filename component.
 * Returns true if valid, false otherwise.
 */
function validateProjectId(projectId: string): boolean {
  return projectId.length > 0 && projectId.length <= PROJECT_ID_MAX_LENGTH && PROJECT_ID_RE.test(projectId);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_SYNCS_DIR = 'pending-syncs';
/** Maximum number of individual changes to store in the preview file. */
export const MAX_PREVIEW_CHANGES = 500;
/** Pending syncs expire after 1 hour. */
const EXPIRY_MS = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Ensure the pending-syncs directory exists.
 */
export async function ensurePendingSyncsDir(agentDir: string): Promise<void> {
  await mkdir(join(agentDir, PENDING_SYNCS_DIR), { recursive: true, mode: 0o700 });
}

/**
 * Save a pending sync preview to disk.
 */
export async function savePendingSync(
  agentDir: string,
  preview: PendingSyncPreview,
): Promise<void> {
  if (!validateProjectId(preview.projectId)) return;
  await ensurePendingSyncsDir(agentDir);
  const filePath = join(agentDir, PENDING_SYNCS_DIR, `${preview.projectId}.json`);
  await atomicWriteFile(filePath, JSON.stringify(preview, null, 2) + '\n', 0o600);
}

/**
 * Read a pending sync preview. Returns null if not found or expired.
 */
export async function readPendingSync(
  agentDir: string,
  projectId: string,
): Promise<PendingSyncPreview | null> {
  if (!validateProjectId(projectId)) return null;
  const filePath = join(agentDir, PENDING_SYNCS_DIR, `${projectId}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPendingSyncPreview(parsed)) return null;
    // Check expiry
    if (new Date(parsed.expiresAt).getTime() < Date.now()) {
      await safeUnlink(filePath);
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    // Fail-safe: corrupted JSON, permission denied, or other I/O errors.
    // Return null to treat as "no pending sync" — the agent will re-create
    // the preview on next dry-run if needed.
    return null;
  }
}

/**
 * List all pending sync previews (including expired ones for cleanup).
 */
export async function listPendingSyncs(agentDir: string): Promise<PendingSyncPreview[]> {
  const dirPath = join(agentDir, PENDING_SYNCS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    return [];
  }

  const results: PendingSyncPreview[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const basename = entry.slice(0, -5);
    if (!validateProjectId(basename)) continue;
    try {
      const raw = await readFile(join(dirPath, entry), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isValidPendingSyncPreview(parsed)) {
        results.push(parsed);
      }
    } catch {
      // Skip corrupted files
    }
  }
  return results;
}

/**
 * Approve a pending sync. The agent will execute it on next poll.
 */
export async function approvePendingSync(
  agentDir: string,
  projectId: string,
): Promise<boolean> {
  if (!validateProjectId(projectId)) return false;
  const preview = await readPendingSync(agentDir, projectId);
  if (!preview || preview.status !== 'pending') return false;

  const updated: PendingSyncPreview = { ...preview, status: 'approved' };
  await savePendingSync(agentDir, updated);
  return true;
}

/**
 * Reject a pending sync. The agent will skip it.
 */
export async function rejectPendingSync(
  agentDir: string,
  projectId: string,
): Promise<boolean> {
  if (!validateProjectId(projectId)) return false;
  const preview = await readPendingSync(agentDir, projectId);
  if (!preview || preview.status !== 'pending') return false;

  const updated: PendingSyncPreview = { ...preview, status: 'rejected' };
  await savePendingSync(agentDir, updated);
  return true;
}

/**
 * Remove a pending sync file.
 */
export async function removePendingSync(
  agentDir: string,
  projectId: string,
): Promise<void> {
  if (!validateProjectId(projectId)) return;
  const filePath = join(agentDir, PENDING_SYNCS_DIR, `${projectId}.json`);
  await safeUnlink(filePath);
}

/**
 * Clean up expired and rejected pending syncs.
 */
export async function cleanExpiredPendingSyncs(agentDir: string): Promise<void> {
  const dirPath = join(agentDir, PENDING_SYNCS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    // Validate the filename is a safe projectId before operating on it
    const basename = entry.slice(0, -5); // strip .json
    if (!validateProjectId(basename)) continue;
    try {
      const raw = await readFile(join(dirPath, entry), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isValidPendingSyncPreview(parsed)) {
        await safeUnlink(join(dirPath, entry));
        continue;
      }
      if (
        parsed.status === 'rejected' ||
        new Date(parsed.expiresAt).getTime() < now
      ) {
        await safeUnlink(join(dirPath, entry));
      }
    } catch {
      // Skip corrupted files
    }
  }
}

/**
 * Build a PendingSyncPreview from dry-run changes.
 */
export function buildPendingSyncPreview(
  projectId: string,
  projectName: string,
  operationId: string,
  direction: SyncDirection,
  localPath: string,
  remotePath: string,
  trigger: 'manual' | 'watch' | 'schedule',
  changes: readonly DryRunChange[],
): PendingSyncPreview {
  const now = new Date();
  const copyCount = changes.filter((c) => c.action === 'copy').length;
  const deleteCount = changes.filter((c) => c.action === 'delete').length;

  return {
    projectId,
    projectName,
    operationId,
    direction,
    localPath,
    remotePath,
    trigger,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString(),
    status: 'pending',
    copyCount,
    deleteCount,
    changes: changes.slice(0, MAX_PREVIEW_CHANGES),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed JSON value has the minimum required shape
 * for a PendingSyncPreview. Guards against corrupted or tampered files.
 */
const VALID_STATUSES: readonly string[] = ['pending', 'approved', 'rejected'];
const VALID_TRIGGERS: readonly string[] = ['manual', 'watch', 'schedule'];

function isValidPendingSyncPreview(value: unknown): value is PendingSyncPreview {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['projectId'] === 'string' &&
    typeof obj['projectName'] === 'string' &&
    typeof obj['localPath'] === 'string' &&
    typeof obj['remotePath'] === 'string' &&
    typeof obj['status'] === 'string' &&
    VALID_STATUSES.includes(obj['status'] as string) &&
    typeof obj['expiresAt'] === 'string' &&
    typeof obj['createdAt'] === 'string' &&
    typeof obj['direction'] === 'string' &&
    (SYNC_DIRECTIONS as readonly string[]).includes(obj['direction'] as string) &&
    typeof obj['trigger'] === 'string' &&
    VALID_TRIGGERS.includes(obj['trigger'] as string) &&
    typeof obj['operationId'] === 'string' &&
    typeof obj['copyCount'] === 'number' &&
    typeof obj['deleteCount'] === 'number' &&
    Array.isArray(obj['changes']) &&
    (obj['changes'] as unknown[]).every(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>)['path'] === 'string' &&
        typeof (c as Record<string, unknown>)['action'] === 'string' &&
        ((c as Record<string, unknown>)['action'] === 'copy' || (c as Record<string, unknown>)['action'] === 'delete'),
    )
  );
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore if already deleted
  }
}
