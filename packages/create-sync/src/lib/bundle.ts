import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { createDecipheriv, scryptSync } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config bundle format
// ---------------------------------------------------------------------------

/**
 * A config bundle is a JSON file encrypted with AES-256-GCM.
 * It contains everything needed to set up a sync agent:
 * - Server URL
 * - API key
 * - Storage provider config
 * - Project definitions
 *
 * Format: base64(salt(32) + iv(16) + authTag(16) + ciphertext)
 * The passphrase is provided out-of-band (e.g., displayed on server screen).
 */

export interface BundleContents {
  serverUrl: string;
  apiKey: string;
  storage: {
    provider: string;
    endpoint: string;
    bucket: string;
    region?: string;
    accessKey: string;
    secretKey: string;
  };
  projects: Array<{
    name: string;
    localPath: string;
    remotePath: string;
    direction: string;
    excludes: string[];
  }>;
}

export async function promptAndDecryptBundle(): Promise<BundleContents | null> {
  const filePath = await p.text({
    message: 'Enter the path to the config bundle file',
    placeholder: '~/Downloads/sync-bundle.enc',
    validate: (v) => {
      if (!v) return 'File path is required';
      return undefined;
    },
  });

  if (p.isCancel(filePath)) return null;

  // Resolve tilde
  const resolvedPath = filePath.replace(/^~/, process.env['HOME'] ?? '');

  let fileContents: string;
  try {
    fileContents = await readFile(resolvedPath, 'utf8');
  } catch {
    p.log.error(`Could not read file: ${resolvedPath}`);
    return null;
  }

  const passphrase = await p.password({
    message: 'Enter the bundle passphrase',
    validate: (v) => {
      if (!v) return 'Passphrase is required';
      return undefined;
    },
  });

  if (p.isCancel(passphrase)) return null;

  const spinner = p.spinner();
  spinner.start('Decrypting bundle...');

  try {
    const packed = Buffer.from(fileContents.trim(), 'base64');
    const salt = packed.subarray(0, 32);
    const iv = packed.subarray(32, 48);
    const authTag = packed.subarray(48, 64);
    const ciphertext = packed.subarray(64);

    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const contents = JSON.parse(decrypted.toString('utf8')) as BundleContents;
    spinner.stop(pc.green('Bundle decrypted successfully.'));
    return contents;
  } catch {
    spinner.stop(pc.red('Decryption failed'));
    p.log.error('Could not decrypt the bundle. Check that the passphrase is correct.');
    return null;
  }
}
