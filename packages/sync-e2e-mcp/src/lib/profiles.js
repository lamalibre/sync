// ============================================================================
// VM Profile Selection & Hardware Detection
// ============================================================================

import os from 'node:os';
import { PROFILES } from '../config.js';

/** Parse a memory string like "2G" or "512M" into megabytes. */
function parseMemoryMB(mem) {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*(G|M)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return match[2].toUpperCase() === 'G' ? value * 1024 : value;
}

/** Detect host hardware capabilities. */
export function detectHardware() {
  const cpus = os.cpus().length;
  const totalMemoryGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const freeMemoryGB = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;

  return { cpus, totalMemoryGB, freeMemoryGB };
}

/**
 * Recommend a VM profile based on available hardware.
 * Sync uses 2 VMs (host + agent), so we need memory × 2 + 2GB host reserve.
 */
export function recommendProfile(hardware) {
  const VM_COUNT = 2;
  const HOST_RESERVE_MB = 2048;

  const availableMemMB = hardware.freeMemoryGB * 1024;
  const supported = [];
  let recommended = 'production'; // always fallback

  // Check profiles from least to most demanding — last match wins
  const orderedProfiles = [
    ['production', PROFILES.production],
    ['development', PROFILES.development],
    ['performance', PROFILES.performance],
  ];

  for (const [name, spec] of orderedProfiles) {
    const memPerVmMB = parseMemoryMB(spec.memory);
    const totalNeededMB = memPerVmMB * VM_COUNT + HOST_RESERVE_MB;
    const totalNeededCpus = spec.cpus * VM_COUNT;

    if (availableMemMB >= totalNeededMB && hardware.cpus >= totalNeededCpus) {
      supported.push(name);
      recommended = name;
    }
  }

  // Production is always supported (minimum tier)
  if (!supported.includes('production')) {
    supported.push('production');
  }

  const note =
    recommended === 'production' && supported.length === 1
      ? 'Limited resources — production profile only. Tests will be slower.'
      : `Recommended: ${recommended} (${supported.length} profile(s) available)`;

  return { name: recommended, supported, note };
}
