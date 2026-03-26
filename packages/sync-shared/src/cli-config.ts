/**
 * Shared CLI configuration read/write.
 *
 * Config is stored at ~/.sync-cli/config.json.
 * Used by both sync-cli and create-sync.
 *
 * The API key is encrypted at rest using a random master key stored at
 * ~/.sync-cli/master.key (mode 0600). Backward compatibility is maintained:
 * if a config file contains a plaintext `apiKey` field, it is read and
 * then re-saved in encrypted form on the next write.
 */

import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { atomicWriteFile } from './atomic-write.js';
import { isNodeError } from './types.js';

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliConfig {
  serverUrl: string;
  apiKey?: string;
}

/** On-disk format when the API key is encrypted. */
interface EncryptedCliConfig {
  serverUrl: string;
  /** Encrypted API key (base64: salt + iv + authTag + ciphertext). */
  apiKeyEncrypted?: string;
  /** Legacy plaintext API key — read for backward compatibility, never written. */
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.sync-cli');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const MASTER_KEY_PATH = join(CONFIG_DIR, 'master.key');

const DEFAULT_CONFIG: CliConfig = {
  serverUrl: 'http://localhost:9393',
};

// ---------------------------------------------------------------------------
// Master key management
// ---------------------------------------------------------------------------

let cachedCliMasterKey: string | null = null;

/**
 * Retrieve or generate a random master key for CLI config encryption.
 * Stored at ~/.sync-cli/master.key with mode 0600.
 */
async function getCliMasterKey(): Promise<string> {
  if (cachedCliMasterKey) return cachedCliMasterKey;

  try {
    cachedCliMasterKey = (await readFile(MASTER_KEY_PATH, 'utf-8')).trim();
    return cachedCliMasterKey;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // Use O_CREAT|O_EXCL to prevent a race where two processes both see
      // ENOENT and generate different keys (second write would silently
      // overwrite the first, making data encrypted by the first process
      // permanently unrecoverable).
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      const key = randomBytes(32).toString('hex');
      try {
        const fd = await open(MASTER_KEY_PATH, 'wx', 0o600);
        try {
          await fd.writeFile(key);
          await fd.sync();
        } finally {
          await fd.close();
        }
      } catch (createErr: unknown) {
        if (isNodeError(createErr) && createErr.code === 'EEXIST') {
          cachedCliMasterKey = (await readFile(MASTER_KEY_PATH, 'utf-8')).trim();
          return cachedCliMasterKey;
        }
        throw createErr;
      }
      cachedCliMasterKey = key;
      return key;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt helpers (self-contained — no dependency on sync-server)
// ---------------------------------------------------------------------------

const CLI_ALGORITHM = 'aes-256-gcm';
const CLI_IV_LENGTH = 16;
const CLI_AUTH_TAG_LENGTH = 16;
const CLI_SALT_LENGTH = 32;

async function encryptValue(plaintext: string): Promise<string> {
  const masterKey = await getCliMasterKey();
  const salt = randomBytes(CLI_SALT_LENGTH);
  const key = (await scryptAsync(masterKey, salt, 32)) as Buffer;
  const iv = randomBytes(CLI_IV_LENGTH);

  const cipher = createCipheriv(CLI_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt(32) + iv(16) + authTag(16) + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

async function decryptValue(packed64: string): Promise<string> {
  const masterKey = await getCliMasterKey();
  const packed = Buffer.from(packed64, 'base64');

  const salt = packed.subarray(0, CLI_SALT_LENGTH);
  const iv = packed.subarray(CLI_SALT_LENGTH, CLI_SALT_LENGTH + CLI_IV_LENGTH);
  const authTag = packed.subarray(
    CLI_SALT_LENGTH + CLI_IV_LENGTH,
    CLI_SALT_LENGTH + CLI_IV_LENGTH + CLI_AUTH_TAG_LENGTH,
  );
  const ciphertext = packed.subarray(CLI_SALT_LENGTH + CLI_IV_LENGTH + CLI_AUTH_TAG_LENGTH);

  const key = (await scryptAsync(masterKey, salt, 32)) as Buffer;
  const decipher = createDecipheriv(CLI_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function loadCliConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const stored = JSON.parse(raw) as EncryptedCliConfig;

    const config: CliConfig = {
      serverUrl: stored.serverUrl ?? DEFAULT_CONFIG.serverUrl,
    };

    if (stored.apiKeyEncrypted) {
      // Decrypt the API key
      try {
        config.apiKey = await decryptValue(stored.apiKeyEncrypted);
      } catch {
        // Decryption failed (master key changed, corrupted, etc.)
        // Return config without the API key — user will need to re-authenticate
      }
    } else if (stored.apiKey) {
      // Backward compatibility: plaintext API key from older config
      config.apiKey = stored.apiKey;
      // Re-save encrypted (fire-and-forget — don't block the load)
      void saveCliConfig(config).catch(() => {});
    }

    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  const stored: EncryptedCliConfig = {
    serverUrl: config.serverUrl,
  };

  if (config.apiKey) {
    stored.apiKeyEncrypted = await encryptValue(config.apiKey);
  }

  await atomicWriteFile(CONFIG_PATH, JSON.stringify(stored, null, 2), 0o600);
}
