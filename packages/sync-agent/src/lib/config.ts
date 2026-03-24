/**
 * Agent config management.
 * Handles reading/writing agent settings and caching server-provided config.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { atomicWriteFile, isNodeError } from '@lamalibre/sync-shared';
import type { AgentSettings, AgentConfig } from './types.js';

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Encryption helpers for cached config (credentials at rest)
// ---------------------------------------------------------------------------

const ENC_ALGORITHM = 'aes-256-gcm';
const ENC_IV_LENGTH = 16;
const ENC_AUTH_TAG_LENGTH = 16;
const ENC_SALT_LENGTH = 32;

// ---------------------------------------------------------------------------
// Master key management
// ---------------------------------------------------------------------------

let cachedAgentMasterKey: string | null = null;

/**
 * Retrieve or generate a random master key for agent-side encryption.
 *
 * On first run, generates a cryptographically random 32-byte key and
 * stores it at `<agentDir>/master.key` with mode 0600.
 * On subsequent runs, reads the existing key file.
 *
 * This replaces the old hostname+username derivation which had zero
 * secrecy — any process on the same machine could reconstruct the key.
 */
async function getAgentMasterKey(agentDir: string): Promise<string> {
  if (cachedAgentMasterKey) return cachedAgentMasterKey;

  const keyPath = join(agentDir, 'master.key');
  try {
    cachedAgentMasterKey = (await readFile(keyPath, 'utf-8')).trim();
    return cachedAgentMasterKey;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // First run — generate a new random key
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      const key = randomBytes(32).toString('hex');
      await writeFile(keyPath, key, { mode: 0o600 });
      cachedAgentMasterKey = key;
      return key;
    }
    throw err;
  }
}

/**
 * Clear the cached agent master key (useful for testing).
 */
export function clearAgentMasterKeyCache(): void {
  cachedAgentMasterKey = null;
}

/** The agent directory used for master key resolution in encrypt/decrypt. */
let resolvedAgentDir: string | null = null;

/**
 * Set the agent directory for encryption operations.
 * Must be called before any encryptJson/decryptJson calls.
 */
export function setAgentCryptoDir(agentDir: string): void {
  resolvedAgentDir = agentDir;
}

async function deriveAgentKey(salt: Buffer): Promise<Buffer> {
  if (!resolvedAgentDir) {
    throw new Error(
      'Agent crypto not initialized: call setAgentCryptoDir() before encrypt/decrypt',
    );
  }
  const masterKey = await getAgentMasterKey(resolvedAgentDir);
  return scryptAsync(masterKey, salt, 32) as Promise<Buffer>;
}

/** Encrypt a JSON-serialisable value. Returns a base64 string: salt + iv + authTag + ciphertext. */
async function encryptJson(value: unknown): Promise<string> {
  const plaintext = JSON.stringify(value);
  const salt = randomBytes(ENC_SALT_LENGTH);
  const key = await deriveAgentKey(salt);
  const iv = randomBytes(ENC_IV_LENGTH);

  const cipher = createCipheriv(ENC_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

/** Decrypt a value previously encrypted with encryptJson(). */
async function decryptJson<T>(packed64: string): Promise<T> {
  const packed = Buffer.from(packed64, 'base64');

  const salt = packed.subarray(0, ENC_SALT_LENGTH);
  const iv = packed.subarray(ENC_SALT_LENGTH, ENC_SALT_LENGTH + ENC_IV_LENGTH);
  const authTag = packed.subarray(
    ENC_SALT_LENGTH + ENC_IV_LENGTH,
    ENC_SALT_LENGTH + ENC_IV_LENGTH + ENC_AUTH_TAG_LENGTH,
  );
  const ciphertext = packed.subarray(ENC_SALT_LENGTH + ENC_IV_LENGTH + ENC_AUTH_TAG_LENGTH);

  const key = await deriveAgentKey(salt);
  const decipher = createDecipheriv(ENC_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(decrypted.toString('utf8')) as T;
}

/** Default agent directory path. */
export const AGENT_DIR = join(homedir(), '.sync-agent');

/** Agent settings file name. */
const SETTINGS_FILE = 'agent-settings.json';

/** Cached server config file name. */
const CACHED_CONFIG_FILE = 'cached-config.json';

/** Default polling interval (30 seconds). */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Ensure the agent directory exists with mode 0700.
 * Also initializes the crypto module with the agent directory
 * so that master key operations work.
 */
export async function ensureAgentDir(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  setAgentCryptoDir(agentDir);
}

/**
 * Read agent settings from disk.
 * Falls back to environment variables if the file does not exist.
 */
export async function readAgentSettings(agentDir: string, logger: Logger): Promise<AgentSettings> {
  const settingsPath = join(agentDir, SETTINGS_FILE);

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isAgentSettings(parsed)) {
      return parsed;
    }
    logger.warn('Agent settings file has invalid format, falling back to env vars');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      logger.info('No agent settings file found, using environment variables');
    } else {
      logger.warn({ err: error }, 'Failed to read agent settings file');
    }
  }

  // Fallback to environment variables
  const serverUrl = process.env['SYNC_SERVER_URL'] ?? 'http://localhost:9393';
  const apiKey = process.env['SYNC_API_KEY'] ?? '';
  const pollIntervalMs = Number.parseInt(
    process.env['SYNC_POLL_INTERVAL_MS'] ?? String(DEFAULT_POLL_INTERVAL_MS),
    10,
  );

  return {
    serverUrl,
    apiKey,
    pollIntervalMs: Number.isNaN(pollIntervalMs) ? DEFAULT_POLL_INTERVAL_MS : pollIntervalMs,
  };
}

/**
 * Write agent settings to disk atomically.
 */
export async function writeAgentSettings(agentDir: string, settings: AgentSettings): Promise<void> {
  const settingsPath = join(agentDir, SETTINGS_FILE);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 0o600);
}

/**
 * Read cached server config from disk.
 * The cached config is encrypted at rest with a random master key.
 * Returns null if no cached config exists or decryption fails.
 */
export async function readCachedConfig(
  agentDir: string,
  logger: Logger,
): Promise<AgentConfig | null> {
  // Ensure crypto module knows the agent dir for key derivation
  setAgentCryptoDir(agentDir);
  const configPath = join(agentDir, CACHED_CONFIG_FILE);

  try {
    const raw = await readFile(configPath, 'utf-8');
    const decrypted = await decryptJson<AgentConfig>(raw.trim());
    return decrypted;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      logger.debug('No cached config found');
    } else {
      logger.warn({ err: error }, 'Failed to read cached config (may need re-fetch from server)');
    }
    return null;
  }
}

/**
 * Write server config to disk cache atomically.
 * The config is encrypted at rest with a random master key so that
 * credentials are not stored in plaintext.
 */
export async function writeCachedConfig(agentDir: string, config: AgentConfig): Promise<void> {
  // Ensure crypto module knows the agent dir for key derivation
  setAgentCryptoDir(agentDir);
  const configPath = join(agentDir, CACHED_CONFIG_FILE);
  const encrypted = await encryptJson(config);
  await atomicWriteFile(configPath, encrypted + '\n', 0o600);
}

/** Type guard for AgentSettings. */
function isAgentSettings(value: unknown): value is AgentSettings {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['serverUrl'] === 'string' &&
    typeof obj['apiKey'] === 'string' &&
    typeof obj['pollIntervalMs'] === 'number'
  );
}
