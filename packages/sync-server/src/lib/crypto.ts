import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { isNodeError } from '@lamalibre/sync-shared';

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// ---------------------------------------------------------------------------
// Master key management
// ---------------------------------------------------------------------------

let cachedMasterKey: string | null = null;

/**
 * Retrieve or generate a random master key for encryption.
 *
 * On first run, generates a cryptographically random 32-byte key and
 * stores it at `<dataDir>/master.key` with mode 0600.
 * On subsequent runs, reads the existing key file.
 *
 * This replaces the old hostname+username derivation which had zero
 * secrecy — any process on the same machine could reconstruct the key.
 *
 * @param dataDir - The server data directory (e.g. ~/.sync/)
 */
async function getMasterKey(dataDir: string): Promise<string> {
  if (cachedMasterKey) return cachedMasterKey;

  const keyPath = join(dataDir, 'master.key');
  try {
    cachedMasterKey = (await readFile(keyPath, 'utf-8')).trim();
    return cachedMasterKey;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // First run — generate a new random key
      const keyDir = dirname(keyPath);
      await mkdir(keyDir, { recursive: true, mode: 0o700 });
      const key = randomBytes(32).toString('hex');
      await writeFile(keyPath, key, { mode: 0o600 });
      cachedMasterKey = key;
      return key;
    }
    throw err;
  }
}

/**
 * Clear the cached master key (useful for testing or data dir changes).
 */
export function clearMasterKeyCache(): void {
  cachedMasterKey = null;
}

// ---------------------------------------------------------------------------
// Data directory resolver
// ---------------------------------------------------------------------------

/**
 * Lazily-resolved reference to getDataDir from state.ts.
 * We import dynamically to avoid circular dependencies: state.ts imports
 * crypto.ts for encrypt/decrypt, so crypto.ts must not statically import
 * state.ts.
 */
let resolveDataDir: (() => string) | null = null;

/**
 * Provide the data directory resolver to the crypto module.
 * Must be called once at startup before any encrypt/decrypt calls.
 */
export function setCryptoDataDir(resolver: () => string): void {
  resolveDataDir = resolver;
}

function getDataDirOrThrow(): string {
  if (!resolveDataDir) {
    throw new Error('Crypto module not initialized: call setCryptoDataDir() at startup');
  }
  return resolveDataDir();
}

/**
 * Derive an encryption key using the random master key (async, non-blocking).
 */
async function deriveKey(salt: Buffer): Promise<Buffer> {
  const masterKey = await getMasterKey(getDataDirOrThrow());
  return scryptAsync(masterKey, salt, 32) as Promise<Buffer>;
}

/**
 * Encrypt a plaintext string.
 * Returns a base64 string containing: salt + iv + authTag + ciphertext
 */
export async function encrypt(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt(32) + iv(16) + authTag(16) + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a string previously encrypted with `encrypt()`.
 */
export async function decrypt(packed64: string): Promise<string> {
  const packed = Buffer.from(packed64, 'base64');

  const salt = packed.subarray(0, SALT_LENGTH);
  const iv = packed.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = packed.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = packed.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}
