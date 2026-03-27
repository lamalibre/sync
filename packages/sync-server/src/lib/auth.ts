import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig, saveConfig } from './state.js';

// ---------------------------------------------------------------------------
// In-memory cache for the API key hash.
// Avoids reading config from disk on every request.
// ---------------------------------------------------------------------------

let cachedApiKeyHash: string | null = null;
let cacheInitialized = false;

/**
 * Clear the cached API key hash.
 * Must be called whenever the API key is changed (e.g., in setupApiKey).
 */
export function clearAuthCache(): void {
  cachedApiKeyHash = null;
  cacheInitialized = false;
}

/**
 * Get the stored API key hash, using the in-memory cache when available.
 */
async function getCachedApiKeyHash(): Promise<string | null> {
  if (cacheInitialized) {
    return cachedApiKeyHash;
  }
  const config = await loadConfig();
  cachedApiKeyHash = config.apiKeyHash ?? null;
  cacheInitialized = true;
  return cachedApiKeyHash;
}

/**
 * Generate a cryptographically secure API key.
 * Returns the raw key (to display to the user once) and the hashed version (to store).
 */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = `sync_${randomBytes(32).toString('hex')}`;
  const hash = hashApiKey(raw);
  return { raw, hash };
}

/** Hash an API key for safe storage. */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Verify a Bearer token against the stored API key hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyApiKey(token: string): Promise<boolean> {
  const apiKeyHash = await getCachedApiKeyHash();
  if (!apiKeyHash) {
    return false;
  }
  const tokenHash = Buffer.from(hashApiKey(token), 'hex');
  const storedHash = Buffer.from(apiKeyHash, 'hex');
  if (tokenHash.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(tokenHash, storedHash);
}

/**
 * Generate and store a new API key in the server config.
 * Returns the raw key (displayed once, never stored in plaintext).
 */
export async function setupApiKey(): Promise<string> {
  const { raw, hash } = generateApiKey();
  const config = await loadConfig();
  config.apiKeyHash = hash;
  await saveConfig(config);
  clearAuthCache();
  return raw;
}

/**
 * Register authentication hook on the Fastify instance.
 *
 * - Skips auth when SYNC_SKIP_AUTH=1 (logs a loud warning at registration time)
 * - Skips auth for health checks
 * - Allows unauthenticated access to setup endpoint ONLY when no API key exists
 * - When no API key is configured yet, allow all requests (first-time setup)
 * - Requires Bearer token for all other routes once an API key is set
 */
export function registerAuthHook(app: FastifyInstance): void {
  const skipAuth = process.env['SYNC_SKIP_AUTH'] === '1';
  if (skipAuth) {
    // Refuse to start with auth disabled on a non-loopback address.
    // This prevents accidentally exposing an unauthenticated server to the network.
    // Positive allowlist: only permit auth skip on known loopback addresses.
    // 0.0.0.0 and :: bind to all interfaces and MUST be blocked.
    const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
    const host = process.env['SYNC_HOST'] ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        'SYNC_SKIP_AUTH cannot be used with a non-loopback SYNC_HOST. ' +
          `Host "${host}" is not a known loopback address (${[...LOOPBACK_HOSTS].join(', ')}). ` +
          'This would expose an unauthenticated server to the network.',
      );
    }

    app.log.warn('==========================================================');
    app.log.warn('WARNING: SYNC_SKIP_AUTH=1 — authentication is DISABLED.');
    app.log.warn('Do NOT use this in production. All endpoints are unprotected.');
    app.log.warn('==========================================================');
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth when explicitly opted in (NOT based on NODE_ENV)
    if (skipAuth) {
      return;
    }

    // Always allow health checks
    if (request.url === '/api/sync/health') {
      return;
    }

    // Check cached API key hash (avoids disk read on every request)
    const apiKeyHash = await getCachedApiKeyHash();

    // When no API key exists yet, only allow health check and initial setup.
    // All other endpoints require authentication — never open the full API
    // to unauthenticated access, even during first-time setup.
    if (!apiKeyHash) {
      if (request.url === '/api/sync/setup/api-key') {
        return;
      }
      return reply.status(401).send({
        ok: false,
        error: 'Initial setup required. Generate an API key first.',
      });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        ok: false,
        error: 'Authentication required. Provide Bearer token in Authorization header.',
      });
    }

    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(hashApiKey(token), 'hex');
    const keyBuf = Buffer.from(apiKeyHash, 'hex');
    if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
      return reply.status(403).send({
        ok: false,
        error: 'Invalid API key.',
      });
    }
  });
}
