/**
 * Generate rclone.conf from server-provided provider configuration.
 *
 * Each provider type maps to specific rclone config entries.
 * The generated config file is written with mode 0600.
 *
 * When encryption is enabled for any project, a crypt overlay remote is
 * generated that wraps the base storage remote. The encryption password
 * is obscured using `rclone obscure` before being written to the config
 * — it is NEVER passed as a CLI argument or logged.
 *
 * Per-project encryption: each encrypted project can have its own password.
 * When projects share the same password, they share the same crypt remote.
 * When projects have different passwords, separate crypt remotes are generated
 * (sync-encrypted, sync-encrypted-2, etc.).
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import type { Logger } from 'pino';
import {
  atomicWriteFile,
  buildRcloneIni,
  buildCryptIni,
  RCLONE_REMOTE_NAME,
} from '@lamalibre/sync-shared';
import type { ProviderConfig, ProjectDefinition } from './types.js';

export { RCLONE_REMOTE_NAME } from '@lamalibre/sync-shared';

/** The default encrypted remote name used when a project has encryption enabled. */
export const RCLONE_ENCRYPTED_REMOTE_NAME = 'sync-encrypted';

/** Path to the rclone.conf file within the agent directory. */
export function getRcloneConfigPath(agentDir: string): string {
  return join(agentDir, 'rclone.conf');
}

/**
 * Obscure a password using `rclone obscure`.
 *
 * rclone stores passwords in its config file in an obscured format.
 * This function calls `rclone obscure` via execa with the password
 * passed through stdin to avoid it appearing in the process argument list.
 *
 * SECURITY NOTE: `rclone obscure` provides obfuscation, NOT encryption.
 * The obscured value is trivially reversible by anyone with access to the
 * rclone binary. This is the standard rclone approach — the crypt remote
 * requires the password field in the config or via `RCLONE_CONFIG_PASS`.
 * The real protection layer is the rclone.conf file permissions (mode 0600)
 * and the agent directory permissions (mode 0700).
 */
export async function obscurePassword(plainPassword: string): Promise<string> {
  const result = await execa('rclone', ['obscure', '-'], {
    input: plainPassword,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
    },
    extendEnv: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.trim();
}

/**
 * Get the rclone remote name for a specific project.
 *
 * For encrypted projects, this returns the crypt remote name.
 * For unencrypted projects, this returns the base remote name.
 *
 * When per-project encryption passwords are used, a mapping is built
 * so each unique password gets its own crypt remote.
 */
export function getProjectRemoteName(
  project: ProjectDefinition,
  provider: ProviderConfig,
  cryptRemoteMap?: ReadonlyMap<string, string>,
): string {
  if (!project.encrypted) {
    return RCLONE_REMOTE_NAME;
  }

  // Determine the effective encryption password for this project
  const effectivePassword = project.encryptionPassword ?? provider.encryptionPassword;
  if (!effectivePassword) {
    // No encryption password available — fall back to base remote
    return RCLONE_REMOTE_NAME;
  }

  // Look up the crypt remote name from the mapping (keyed by password hash)
  if (cryptRemoteMap) {
    const remoteName = getCryptRemoteName(cryptRemoteMap, effectivePassword);
    if (remoteName) {
      return remoteName;
    }
  }

  return RCLONE_ENCRYPTED_REMOTE_NAME;
}

/**
 * Build a mapping from unique encryption passwords to crypt remote names.
 *
 * When all encrypted projects share the same password, they all use
 * "sync-encrypted". When different passwords exist, subsequent remotes
 * are named "sync-encrypted-2", "sync-encrypted-3", etc.
 */
/**
 * Build a mapping from encryption password hash → crypt remote name.
 *
 * Uses SHA-256 hashes as map keys instead of raw passwords so that
 * plaintext passwords are not held as strongly-referenced Map keys
 * for the lifetime of the process.
 *
 * Callers use `getCryptRemoteName` to look up the remote name for a password.
 */
export function buildCryptRemoteMap(
  projects: readonly ProjectDefinition[],
  provider: ProviderConfig,
): Map<string, string> {
  const map = new Map<string, string>();
  let counter = 1;

  for (const project of projects) {
    if (!project.encrypted) continue;

    const effectivePassword = project.encryptionPassword ?? provider.encryptionPassword;
    if (!effectivePassword) continue;

    const passwordHash = createHash('sha256').update(effectivePassword).digest('hex');
    if (map.has(passwordHash)) continue;

    const remoteName =
      counter === 1 ? RCLONE_ENCRYPTED_REMOTE_NAME : `${RCLONE_ENCRYPTED_REMOTE_NAME}-${counter}`;
    map.set(passwordHash, remoteName);
    counter += 1;
  }

  return map;
}

/**
 * Look up the crypt remote name for a given encryption password.
 */
export function getCryptRemoteName(
  cryptRemoteMap: ReadonlyMap<string, string>,
  password: string,
): string | undefined {
  const passwordHash = createHash('sha256').update(password).digest('hex');
  return cryptRemoteMap.get(passwordHash);
}

/**
 * Generate rclone.conf content from provider configuration.
 *
 * Async because obscuring encryption passwords requires calling `rclone obscure`.
 * Returns the INI-format config string.
 */
export async function generateRcloneConfig(
  provider: ProviderConfig,
  projects: readonly ProjectDefinition[],
): Promise<string> {
  const sections: string[] = [];

  // Generate the base remote section
  sections.push(generateBaseRemote(provider));

  // Build the crypt remote map (hash → remoteName) for all encrypted projects,
  // then generate a crypt remote section for each unique password.
  const cryptRemoteMap = buildCryptRemoteMap(projects, provider);
  const generatedRemotes = new Set<string>();

  for (const project of projects) {
    if (!project.encrypted) continue;
    const effectivePassword = project.encryptionPassword ?? provider.encryptionPassword;
    if (!effectivePassword) continue;

    const remoteName = getCryptRemoteName(cryptRemoteMap, effectivePassword);
    if (!remoteName || generatedRemotes.has(remoteName)) continue;

    generatedRemotes.add(remoteName);
    const cryptSection = await generateCryptRemote(provider.bucket, effectivePassword, remoteName);
    sections.push(cryptSection);
  }

  return sections.join('\n\n') + '\n';
}

/**
 * Write rclone.conf to disk atomically with mode 0600.
 */
export async function writeRcloneConfig(
  agentDir: string,
  provider: ProviderConfig,
  projects: readonly ProjectDefinition[],
  logger: Logger,
): Promise<string> {
  const configPath = getRcloneConfigPath(agentDir);
  const content = await generateRcloneConfig(provider, projects);

  logger.debug({ configPath }, 'Writing rclone config');
  await atomicWriteFile(configPath, content, 0o600);

  return configPath;
}

/**
 * Generate the base remote section based on provider type.
 *
 * Maps the agent's ProviderConfig to the shared RcloneConfigInput
 * format, then delegates to the shared buildRcloneIni.
 */
function generateBaseRemote(provider: ProviderConfig): string {
  // Map provider-specific credential fields to the unified accessKey/secretKey model
  let accessKey: string | undefined;
  let secretKey: string | undefined;

  switch (provider.type) {
    case 'gcs':
      accessKey = provider.serviceAccountKey;
      break;
    case 'azure':
      accessKey = provider.storageAccountName;
      secretKey = provider.storageAccountKey;
      break;
    case 'b2':
      accessKey = provider.applicationKeyId;
      secretKey = provider.applicationKey;
      break;
    default:
      accessKey = provider.accessKeyId;
      secretKey = provider.secretAccessKey;
      break;
  }

  return buildRcloneIni({
    provider: provider.type,
    accessKey,
    secretKey,
    endpoint: provider.endpoint,
    bucket: provider.bucket,
    region: provider.region,
    forcePathStyle: provider.forcePathStyle,
  });
}

/**
 * Generate the crypt remote overlay for encrypted projects.
 *
 * The password is obscured using `rclone obscure` so it is not stored
 * in plaintext in the rclone.conf file.
 */
/** Minimum encryption password length — mirrors the server-side Zod schema. */
const MIN_ENCRYPTION_PASSWORD_LENGTH = 12;

async function generateCryptRemote(
  bucket: string,
  encryptionPassword: string,
  remoteName: string = RCLONE_ENCRYPTED_REMOTE_NAME,
): Promise<string> {
  if (encryptionPassword.length < MIN_ENCRYPTION_PASSWORD_LENGTH) {
    throw new Error(
      `Encryption password must be at least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters (got ${encryptionPassword.length})`,
    );
  }
  const obscured = await obscurePassword(encryptionPassword);
  return buildCryptIni(remoteName, bucket, obscured);
}
