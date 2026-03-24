/**
 * Bisync state persistence.
 *
 * Tracks whether the initial --resync has been performed for each project
 * and records conflicts from the most recent bisync run.
 * State is persisted to disk so it survives agent restarts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { atomicWriteFile, isNodeError } from '@lamalibre/sync-shared';
import type { BisyncState } from './types.js';

/** File name for bisync state within the agent directory. */
const BISYNC_STATE_FILE = 'bisync-state.json';

/** Per-project bisync state, keyed by project ID. */
export interface BisyncStateFile {
  readonly projects: Record<string, BisyncState>;
}

const DEFAULT_STATE: BisyncState = {
  baselineEstablished: false,
  lastBisync: null,
  conflicts: [],
};

/**
 * Read bisync state for all projects from disk.
 */
export async function readBisyncStateFile(
  agentDir: string,
  logger: Logger,
): Promise<BisyncStateFile> {
  const filePath = join(agentDir, BISYNC_STATE_FILE);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isBisyncStateFile(parsed)) {
      return parsed;
    }
    logger.warn('Bisync state file has invalid format, using defaults');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      logger.debug('No bisync state file found, using defaults');
    } else {
      logger.warn({ err: error }, 'Failed to read bisync state file');
    }
  }

  return { projects: {} };
}

/** Result of getBisyncState, includes the full state file for pass-through to updateBisyncState. */
export interface BisyncStateResult {
  readonly state: BisyncState;
  readonly stateFile: BisyncStateFile;
}

/**
 * Get bisync state for a specific project.
 * Returns both the project state and the full state file, so the caller
 * can pass the state file to updateBisyncState to avoid a redundant disk read.
 */
export async function getBisyncState(
  agentDir: string,
  projectId: string,
  logger: Logger,
): Promise<BisyncStateResult> {
  const stateFile = await readBisyncStateFile(agentDir, logger);
  return {
    state: stateFile.projects[projectId] ?? DEFAULT_STATE,
    stateFile,
  };
}

/**
 * Update bisync state for a specific project.
 *
 * If `existingStateFile` is provided, it is used instead of re-reading from disk.
 * This avoids a redundant disk read when the caller has already loaded the state
 * (e.g., from getBisyncState).
 */
export async function updateBisyncState(
  agentDir: string,
  projectId: string,
  state: BisyncState,
  logger: Logger,
  existingStateFile?: BisyncStateFile,
): Promise<void> {
  const stateFile = existingStateFile ?? (await readBisyncStateFile(agentDir, logger));
  const updated: BisyncStateFile = {
    projects: {
      ...stateFile.projects,
      [projectId]: state,
    },
  };

  const filePath = join(agentDir, BISYNC_STATE_FILE);
  await atomicWriteFile(filePath, JSON.stringify(updated, null, 2) + '\n', 0o600);
}

/**
 * Remove bisync state for a deleted project.
 */
export async function removeBisyncState(
  agentDir: string,
  projectId: string,
  logger: Logger,
): Promise<void> {
  const stateFile = await readBisyncStateFile(agentDir, logger);
  const { [projectId]: _removed, ...remaining } = stateFile.projects;
  const updated: BisyncStateFile = { projects: remaining };

  const filePath = join(agentDir, BISYNC_STATE_FILE);
  await atomicWriteFile(filePath, JSON.stringify(updated, null, 2) + '\n', 0o600);
}

function isBisyncStateFile(value: unknown): value is BisyncStateFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['projects'] === 'object' && obj['projects'] !== null;
}
