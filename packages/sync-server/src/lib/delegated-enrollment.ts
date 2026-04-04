/**
 * Delegated enrollment announcement for Portlama integration.
 *
 * When the Sync server runs as a Portlama plugin and creates a new Sync agent
 * token, it pre-announces a delegated enrollment to the Portlama panel. This
 * gives the Sync agent a Portlama identity for ticket authorization.
 *
 * The announcement is best-effort — failures are logged but never prevent
 * agent registration from succeeding.
 */

import { fetch, type Dispatcher } from 'undici';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegatedEnrollmentResult {
  /** One-time enrollment token the Sync agent uses to enroll with Portlama. */
  readonly enrollmentToken: string;
  /** ISO timestamp when the token expires. */
  readonly expiresAt: string;
  /** Agent label used for the delegated enrollment. */
  readonly pluginAgentLabel: string;
}

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Announce a delegated enrollment to the Portlama panel.
 *
 * Makes a POST request to the panel's delegated enrollment endpoint using the
 * mTLS dispatcher (Portlama agent cert) for authentication.
 *
 * @returns The enrollment result, or `null` if the request failed.
 *          Failures are logged but never thrown — agent registration must not
 *          be blocked by Portlama communication issues.
 */
export async function announceDelegatedEnrollment(
  panelUrl: string,
  dispatcher: Dispatcher,
  pluginAgentLabel: string,
  scope: string,
  logger: Logger,
): Promise<DelegatedEnrollmentResult | null> {
  const normalizedPanelUrl = panelUrl.replace(/\/+$/, '');
  const url = `${normalizedPanelUrl}/api/certs/agent/enroll-delegated`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginAgentLabel, scope }),
      dispatcher,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      logger.warn(
        { status: response.status, body: text, pluginAgentLabel },
        'Delegated enrollment announcement rejected by panel',
      );
      return null;
    }

    const body: unknown = await response.json();

    if (!isObject(body)) {
      logger.warn(
        { pluginAgentLabel },
        'Delegated enrollment response is not an object',
      );
      return null;
    }

    const enrollmentToken = body['enrollmentToken'];
    const expiresAt = body['expiresAt'];

    if (typeof enrollmentToken !== 'string' || typeof expiresAt !== 'string') {
      logger.warn(
        { pluginAgentLabel, body },
        'Delegated enrollment response missing expected fields',
      );
      return null;
    }

    logger.info(
      { pluginAgentLabel, expiresAt },
      'Delegated enrollment announced to Portlama panel',
    );

    return { enrollmentToken, expiresAt, pluginAgentLabel };
  } catch (err: unknown) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        pluginAgentLabel,
      },
      'Failed to announce delegated enrollment to Portlama panel',
    );
    return null;
  }
}
