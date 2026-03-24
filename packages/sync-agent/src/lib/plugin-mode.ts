/**
 * Plugin mode support for the sync-agent.
 *
 * When running as a Portlama plugin agent, authentication uses mTLS
 * certificates provided by Portlama (via the config bundle) instead
 * of a Bearer API key.
 *
 * The agent receives its certs in the agent-settings.json:
 * {
 *   "serverUrl": "https://...",
 *   "pluginMode": true,
 *   "mtls": {
 *     "certPath": "/path/to/agent-cert.pem",
 *     "keyPath": "/path/to/agent-key.pem",
 *     "caPath": "/path/to/ca-cert.pem"
 *   }
 * }
 */

import { readFile } from 'node:fs/promises';
import { Agent as UndiciAgent } from 'undici';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** mTLS certificate configuration for plugin mode. */
export interface MtlsConfig {
  /** Path to the agent's client certificate (PEM). */
  readonly certPath: string;
  /** Path to the agent's private key (PEM). */
  readonly keyPath: string;
  /** Path to the CA certificate (PEM) that signed the server cert. */
  readonly caPath: string;
}

/** Pre-read mTLS certificate contents. */
export interface MtlsCertContents {
  readonly cert: string;
  readonly key: string;
  readonly ca: string;
}

/** Extended agent settings with optional plugin mode fields. */
export interface PluginModeSettings {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly pollIntervalMs: number;
  readonly agentId?: string;
  readonly agentName?: string;
  /** When true, the agent uses mTLS instead of Bearer token auth. */
  readonly pluginMode?: boolean;
  /** mTLS certificate paths, required when pluginMode is true. */
  readonly mtls?: MtlsConfig;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the agent should run in plugin mode.
 *
 * Detection is based on:
 * 1. `pluginMode: true` in agent settings
 * 2. `PORTLAMA_PLUGIN` environment variable set to "1" or "true"
 * 3. Presence of mTLS config in agent settings
 */
export function isAgentPluginMode(settings: PluginModeSettings): boolean {
  if (settings.pluginMode === true) return true;

  const envFlag = process.env['PORTLAMA_PLUGIN'];
  if (envFlag === '1' || envFlag === 'true') return true;

  if (settings.mtls) return true;

  return false;
}

// ---------------------------------------------------------------------------
// mTLS HTTPS agent
// ---------------------------------------------------------------------------

/**
 * Create an HTTPS agent configured with mTLS client certificates.
 *
 * Accepts pre-read certificate contents (from validateMtlsConfig) to avoid
 * reading the same files twice.
 *
 * This agent is used by the ServerClient's fetch calls when the
 * sync-agent is running in Portlama plugin mode. The mTLS certificates
 * authenticate the agent to the server without needing a Bearer API key.
 */
export function createMtlsAgent(certContents: MtlsCertContents, logger: Logger): UndiciAgent {
  const agent = new UndiciAgent({
    connect: {
      cert: certContents.cert,
      key: certContents.key,
      ca: certContents.ca,
      rejectUnauthorized: true,
    },
  });

  logger.info('mTLS undici agent created successfully');
  return agent;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that mTLS configuration is complete and cert files are readable.
 * Returns the file contents on success so they can be passed directly to
 * createMtlsAgent without re-reading from disk.
 * Throws descriptive errors if the configuration is invalid.
 */
export async function validateMtlsConfig(
  config: MtlsConfig,
  logger: Logger,
): Promise<MtlsCertContents> {
  const pathEntries = [
    { label: 'certificate', path: config.certPath, field: 'cert' as const },
    { label: 'private key', path: config.keyPath, field: 'key' as const },
    { label: 'CA certificate', path: config.caPath, field: 'ca' as const },
  ];

  const contents: Record<string, string> = {};

  for (const { label, path, field } of pathEntries) {
    try {
      contents[field] = await readFile(path, 'utf-8');
      logger.debug({ label, path }, 'mTLS file readable');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read mTLS ${label} at ${path}: ${message}`);
    }
  }

  return {
    cert: contents['cert']!,
    key: contents['key']!,
    ca: contents['ca']!,
  };
}
