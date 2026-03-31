import {
  detectServer,
  getServerSource,
  getServerUrl,
  setServerUrl,
  clearServerConfig,
  type DetectionResult,
} from './api.js';

// ---------------------------------------------------------------------------
// Reactive detection state (module-scoped Svelte 5 runes)
// ---------------------------------------------------------------------------

export type DetectionPhase = 'idle' | 'detecting' | 'done';

let phase: DetectionPhase = $state('idle');
let result: DetectionResult | null = $state(null);

export function getDetectionPhase(): DetectionPhase {
  return phase;
}

export function getDetectionResult(): DetectionResult | null {
  return result;
}

/**
 * Probe known endpoints to find a running sync-server.
 * Skips detection if the user has manually configured a URL.
 * When a server is found, the URL is persisted as 'auto-detected'.
 */
export async function runDetection(): Promise<void> {
  if (getServerSource() === 'manual') {
    phase = 'done';
    return;
  }

  phase = 'detecting';
  const detected = await detectServer();
  result = detected;

  if (detected.found && detected.baseUrl) {
    setServerUrl(detected.baseUrl, 'auto-detected');
  }

  phase = 'done';
}

/**
 * Clear persisted server config and re-run detection from scratch.
 * Returns the updated server URL after detection completes.
 */
export async function redetect(): Promise<string> {
  clearServerConfig();
  phase = 'idle';
  result = null;
  await runDetection();
  return getServerUrl();
}
