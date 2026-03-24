/**
 * Parse rclone --progress stderr output into structured progress data.
 *
 * rclone outputs lines like:
 *   Transferred:      1.024 GiB / 5.000 GiB, 20%, 50.000 MiB/s, ETA 1m20s
 *   Transferred:           312 / 1247, 25%
 *
 * The first "Transferred:" line is bytes, the second is file counts.
 */

import type { SyncProgress } from './types.js';

/** Accumulated state for the progress parser. Updated as new lines arrive. */
interface ProgressState {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: string;
  eta: string;
  filesTransferred: number;
  filesTotal: number;
}

/**
 * Parse a byte size string with unit to a number of bytes.
 * Handles: "1.024 GiB", "50.000 MiB", "512 KiB", "1024 B", "1.024 Gi", "50 Mi"
 * Also handles rclone decimal units: "1.024 GByte", "50 MByte", "1 kByte"
 */
function parseSizeToBytes(value: string, unit: string): number {
  const num = Number.parseFloat(value);
  if (Number.isNaN(num)) return 0;

  const u = unit.toLowerCase();
  if (u.startsWith('gib') || u.startsWith('gi')) return num * 1024 * 1024 * 1024;
  if (u.startsWith('mib') || u.startsWith('mi')) return num * 1024 * 1024;
  if (u.startsWith('kib') || u.startsWith('ki')) return num * 1024;
  if (u.startsWith('gbyte') || u === 'gb') return num * 1e9;
  if (u.startsWith('mbyte') || u === 'mb') return num * 1e6;
  if (u.startsWith('kbyte') || u === 'kb') return num * 1e3;
  if (u === 'b' || u.startsWith('byte')) return num;
  // Fallback: treat unknown unit as bytes
  return num;
}

// Bytes transferred line:
// "Transferred:      1.024 GiB / 5.000 GiB, 20%, 50.000 MiB/s, ETA 1m20s"
// Can also look like:
// "Transferred:        0 B / 0 B, -, 0 B/s, ETA -"
const BYTES_REGEX =
  /Transferred:\s+([\d.]+)\s+(\S+)\s*\/\s*([\d.]+)\s+(\S+),\s*(\d+|-)%?,?\s*([\d.]+\s*\S+\/s|-)?,?\s*(?:ETA\s+(\S+))?/;

// File count line:
// "Transferred:           312 / 1247, 25%"
const FILES_REGEX = /Transferred:\s+(\d+)\s*\/\s*(\d+),\s*(\d+)%/;

/**
 * Create a progress parser that accumulates state across multiple stderr chunks.
 * Call `feed()` with each chunk of stderr data, and it will invoke the callback
 * whenever progress is updated.
 */
export function createProgressParser(onProgress: (progress: SyncProgress) => void): {
  feed: (chunk: string) => void;
  getState: () => SyncProgress;
} {
  const state: ProgressState = {
    bytesTransferred: 0,
    totalBytes: 0,
    percentage: 0,
    speed: '',
    eta: '',
    filesTransferred: 0,
    filesTotal: 0,
  };

  let lineBuffer = '';

  function processLine(line: string): boolean {
    let updated = false;

    const bytesMatch = BYTES_REGEX.exec(line);
    if (bytesMatch) {
      const [, transValue, transUnit, totalValue, totalUnit, pct, speed, eta] = bytesMatch;
      if (transValue && transUnit) {
        state.bytesTransferred = parseSizeToBytes(transValue, transUnit);
      }
      if (totalValue && totalUnit) {
        state.totalBytes = parseSizeToBytes(totalValue, totalUnit);
      }
      if (pct && pct !== '-') {
        state.percentage = Number.parseInt(pct, 10);
      }
      if (speed && speed !== '-') {
        state.speed = speed.trim();
      }
      if (eta && eta !== '-') {
        state.eta = eta.trim();
      }
      updated = true;
    }

    const filesMatch = FILES_REGEX.exec(line);
    if (filesMatch && !bytesMatch) {
      const [, transferred, total, pct] = filesMatch;
      if (transferred) state.filesTransferred = Number.parseInt(transferred, 10);
      if (total) state.filesTotal = Number.parseInt(total, 10);
      if (pct) state.percentage = Number.parseInt(pct, 10);
      updated = true;
    }

    return updated;
  }

  function feed(chunk: string): void {
    // rclone uses \r for in-place updates and \n for new lines
    lineBuffer += chunk;

    // Split on both \n and \r to handle rclone's output style
    const parts = lineBuffer.split(/[\r\n]/);
    // Last part may be incomplete; keep it in the buffer
    lineBuffer = parts.pop() ?? '';

    let updated = false;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && processLine(trimmed)) {
        updated = true;
      }
    }

    if (updated) {
      onProgress({ ...state });
    }
  }

  function getState(): SyncProgress {
    return { ...state };
  }

  return { feed, getState };
}
