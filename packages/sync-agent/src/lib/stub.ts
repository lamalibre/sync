/**
 * Stub file management for archived projects.
 *
 * A stub file (.sync-stub.json) is a small metadata file placed in a project's
 * local directory after archiving. It records what was archived, where it lives
 * in the cloud, and how much space was freed — so the project can be restored
 * later without scanning the remote.
 *
 * Stubs must be small (a few KB at most). For large directories we only store
 * summary metrics (totalSize, fileCount) and omit the per-file listing.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { atomicWriteFile } from '@lamalibre/sync-shared';
import type { ProviderType } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file entry inside a stub's file list. */
export interface StubFileEntry {
  readonly path: string;
  readonly size: number;
  readonly modified: string;
}

/** The full stub file payload. */
export interface StubData {
  readonly syncStub: true;
  readonly version: 1;
  readonly archivedAt: string;
  readonly remotePath: string;
  readonly provider: ProviderType;
  readonly bucket: string;
  readonly projectId: string;
  readonly totalSize: number;
  readonly fileCount: number;
  /** Present only when file count is small enough to keep the stub under size. */
  readonly files?: readonly StubFileEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the stub file placed in the project root. */
export const STUB_FILENAME = '.sync-stub.json';

/**
 * Maximum number of individual file entries to include in the stub.
 * Beyond this threshold we only store aggregate metrics to keep stub size small.
 */
const MAX_FILE_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Result of scanning a local directory before archiving. */
export interface ScanResult {
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly StubFileEntry[];
}

/**
 * Recursively scan a directory and collect file metadata.
 * Skips the stub file itself and hidden files/directories that start with ".".
 * Uses streaming iteration (readdir) — does not hold the full tree in memory.
 */
export async function scanDirectory(localPath: string): Promise<ScanResult> {
  let totalSize = 0;
  let fileCount = 0;
  const files: StubFileEntry[] = [];
  const STAT_BATCH_SIZE = 50;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    // Separate directories and files for processing
    const dirs: string[] = [];
    const fileEntries: string[] = [];

    for (const entry of entries) {
      // Skip hidden files/directories and the stub file itself
      if (entry.name.startsWith('.') || entry.name === STUB_FILENAME) continue;

      // Explicitly skip symbolic links to avoid following them into
      // unexpected locations or creating infinite loops.
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(fullPath);
      } else if (entry.isFile()) {
        fileEntries.push(fullPath);
      }
    }

    // Stat files in batches for parallelism within each directory
    for (let i = 0; i < fileEntries.length; i += STAT_BATCH_SIZE) {
      const batch = fileEntries.slice(i, i + STAT_BATCH_SIZE);
      const statResults = await Promise.all(
        batch.map(async (fullPath) => {
          const fileStat = await stat(fullPath);
          return { fullPath, fileStat };
        }),
      );

      for (const { fullPath, fileStat } of statResults) {
        const relPath = relative(localPath, fullPath);
        totalSize += fileStat.size;
        fileCount += 1;

        // Only collect individual entries up to the threshold
        if (files.length < MAX_FILE_ENTRIES) {
          files.push({
            path: relPath,
            size: fileStat.size,
            modified: fileStat.mtime.toISOString(),
          });
        }
      }
    }

    // Recurse into subdirectories (sequentially to avoid overwhelming the OS)
    for (const subDir of dirs) {
      await walk(subDir);
    }
  }

  await walk(localPath);
  return { totalSize, fileCount, files };
}

// ---------------------------------------------------------------------------
// Write / Read
// ---------------------------------------------------------------------------

/**
 * Write a stub file into the project's local directory.
 * Uses atomic write (temp -> fsync -> rename).
 */
export async function writeStub(localPath: string, data: StubData): Promise<string> {
  const stubPath = join(localPath, STUB_FILENAME);
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(stubPath, json, 0o644);
  return stubPath;
}

/**
 * Read and parse a stub file from the project's local directory.
 * Returns null if no stub file exists or it is malformed.
 */
export async function readStub(localPath: string): Promise<StubData | null> {
  const stubPath = join(localPath, STUB_FILENAME);
  try {
    const raw = await readFile(stubPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isStubData(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a StubData object from scan results and project metadata.
 * If the file count exceeds the threshold, the individual file list is omitted.
 */
export function buildStubData(options: {
  scan: ScanResult;
  remotePath: string;
  provider: ProviderType;
  bucket: string;
  projectId: string;
}): StubData {
  const includeFiles = options.scan.fileCount <= MAX_FILE_ENTRIES;

  const data: StubData = {
    syncStub: true,
    version: 1,
    archivedAt: new Date().toISOString(),
    remotePath: options.remotePath,
    provider: options.provider,
    bucket: options.bucket,
    projectId: options.projectId,
    totalSize: options.scan.totalSize,
    fileCount: options.scan.fileCount,
    ...(includeFiles ? { files: options.scan.files } : {}),
  };

  return data;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isStubData(value: unknown): value is StubData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['syncStub'] === true &&
    obj['version'] === 1 &&
    typeof obj['archivedAt'] === 'string' &&
    typeof obj['remotePath'] === 'string' &&
    typeof obj['provider'] === 'string' &&
    typeof obj['bucket'] === 'string' &&
    typeof obj['projectId'] === 'string' &&
    typeof obj['totalSize'] === 'number' &&
    typeof obj['fileCount'] === 'number'
  );
}
