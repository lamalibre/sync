import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateApiKey, clearAuthCache } from '../lib/auth.js';
import { loadConfig, saveConfig } from '../lib/state.js';

/** Declaration merging so we can access the optional setupToken decoration. */
declare module 'fastify' {
  interface FastifyInstance {
    setupToken?: string;
  }
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/sync/setup/api-key — Generate a new API key.
   *
   * - First-time setup (no key exists): requires the one-time setup token
   *   from the X-Setup-Token header (logged to console on server start).
   * - Regeneration (key already exists): requires a valid Bearer token
   *   (enforced by the auth hook — setup endpoint is no longer exempt
   *   when a key is already configured).
   *
   * The raw API key is returned once in the response. It is stored
   * as a SHA-256 hash in the server config and cannot be retrieved again.
   */
  app.post('/api/sync/setup/api-key', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = await loadConfig();

    // If no API key exists, validate the setup token to prevent
    // race-condition hijacking of the first-time setup endpoint.
    if (!config.apiKeyHash) {
      const setupToken = request.server.setupToken;
      if (setupToken) {
        const providedToken = request.headers['x-setup-token'] as string | undefined;
        if (!providedToken || providedToken !== setupToken) {
          return reply.status(401).send({
            ok: false,
            error: 'Setup token required. Check server logs.',
          });
        }
      }
    }

    // If an API key already exists, the auth hook has already verified the
    // Bearer token (setup is only exempt from auth when no key exists).
    // We proceed to regenerate.

    const { raw, hash } = generateApiKey();
    config.apiKeyHash = hash;
    await saveConfig(config);
    clearAuthCache();

    return reply.send({
      ok: true,
      apiKey: raw,
    });
  });
}
