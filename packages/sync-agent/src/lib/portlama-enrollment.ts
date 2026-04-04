/**
 * Portlama delegated enrollment.
 *
 * When the Sync server runs as a Portlama agent plugin, it may include a
 * `delegatedEnrollment` field in the registration response. This module
 * consumes that token to obtain a minimal Portlama mTLS certificate so
 * the Sync agent can participate in the ticket system.
 *
 * Enrollment is best-effort — failure never prevents the Sync agent from
 * starting or operating normally.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import type { Logger } from 'pino';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { execa } from 'execa';
import { atomicWriteFile } from '@lamalibre/sync-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortlamaEnrollmentResult {
  /** PEM-encoded client certificate signed by the Portlama CA. */
  readonly cert: string;
  /** PEM-encoded Portlama CA certificate. */
  readonly caCert: string;
  /** Certificate label (e.g. `plugin-agent:sync:myhost`). */
  readonly label: string;
  /** Certificate serial number (hex). */
  readonly serial: string;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
}

/** Paths to the Portlama certificate files stored on disk. */
export interface PortlamaCertPaths {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caCertPath: string;
}

// ---------------------------------------------------------------------------
// CSR generation via openssl
// ---------------------------------------------------------------------------

/**
 * Generate a PKCS#10 CSR using openssl.
 *
 * The CN is a placeholder — the Portlama panel overwrites it with the
 * label from the enrollment token during signing.
 *
 * The private key is written to a temporary file (mode 0600) and cleaned
 * up in a finally block.
 */
async function generateCSR(
  privateKeyPem: string,
  tempDir: string,
): Promise<string> {
  const tmpKeyPath = join(tempDir, '.tmp-portlama-enroll.key');
  try {
    await atomicWriteFile(tmpKeyPath, privateKeyPem, 0o600);

    const result = await execa('openssl', [
      'req',
      '-new',
      '-key', tmpKeyPath,
      '-subj', '/CN=sync-agent',
      '-sha256',
    ]);

    return result.stdout;
  } finally {
    // Clean up temporary key file
    try {
      await unlink(tmpKeyPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/**
 * Enroll with the Portlama panel using a delegated enrollment token.
 *
 * 1. Generates an RSA 4096-bit key pair
 * 2. Builds a PKCS#10 CSR via openssl
 * 3. POSTs to the public `/api/enroll` endpoint (no mTLS required)
 * 4. Saves cert files to `<agentDir>/portlama-cert/`
 *
 * Returns the enrollment result, or `null` on failure (best-effort).
 */
export async function enrollWithPortlama(
  panelUrl: string,
  enrollmentToken: string,
  agentDir: string,
  logger: Logger,
): Promise<PortlamaEnrollmentResult | null> {
  const log = logger.child({ component: 'portlama-enrollment' });

  try {
    log.info({ panelUrl }, 'Starting Portlama delegated enrollment');

    // 1. Generate RSA 4096-bit key pair
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // 2. Build CSR via openssl (temp key file, cleaned up in finally)
    const certDir = join(agentDir, 'portlama-cert');
    await mkdir(certDir, { recursive: true, mode: 0o700 });

    const csrPem = await generateCSR(privateKey, certDir);
    log.debug('CSR generated');

    // 3. POST to enrollment endpoint (public, no mTLS)
    //    Use undici with rejectUnauthorized: false — the Portlama panel may
    //    use a self-signed server certificate.
    const enrollUrl = `${panelUrl.replace(/\/+$/, '')}/api/enroll`;
    const dispatcher = new UndiciAgent({
      connect: { rejectUnauthorized: false },
    });

    let data: Record<string, unknown>;
    try {
      const response = await undiciFetch(enrollUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: enrollmentToken, csr: csrPem }),
        signal: AbortSignal.timeout(30_000),
        dispatcher,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn(
          { status: response.status, body },
          'Portlama enrollment request failed',
        );
        return null;
      }

      data = (await response.json()) as Record<string, unknown>;
    } finally {
      await dispatcher.close();
    }

    if (
      data['ok'] !== true ||
      typeof data['cert'] !== 'string' ||
      typeof data['caCert'] !== 'string' ||
      typeof data['label'] !== 'string' ||
      typeof data['serial'] !== 'string' ||
      typeof data['expiresAt'] !== 'string'
    ) {
      log.warn('Portlama enrollment returned unexpected response shape');
      return null;
    }

    const result: PortlamaEnrollmentResult = {
      cert: data['cert'] as string,
      caCert: data['caCert'] as string,
      label: data['label'] as string,
      serial: data['serial'] as string,
      expiresAt: data['expiresAt'] as string,
    };

    // 4. Save cert files atomically
    await atomicWriteFile(join(certDir, 'client.key'), privateKey, 0o600);
    await atomicWriteFile(join(certDir, 'client.crt'), result.cert, 0o644);
    await atomicWriteFile(join(certDir, 'ca.crt'), result.caCert, 0o644);

    log.info(
      { label: result.label, serial: result.serial, expiresAt: result.expiresAt },
      'Portlama delegated enrollment succeeded',
    );

    return result;
  } catch (error: unknown) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Portlama delegated enrollment failed (non-fatal)',
    );
    return null;
  }
}

/**
 * Return the paths where Portlama cert files are stored.
 */
export function getPortlamaCertPaths(agentDir: string): PortlamaCertPaths {
  const certDir = join(agentDir, 'portlama-cert');
  return {
    certPath: join(certDir, 'client.crt'),
    keyPath: join(certDir, 'client.key'),
    caCertPath: join(certDir, 'ca.crt'),
  };
}
