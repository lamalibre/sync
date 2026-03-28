/**
 * HTTP client for communicating with the sync-server.
 * Handles polling for config, reporting sync results, agent registration,
 * and heartbeat.
 */

import type { Dispatcher } from 'undici';
import type { Logger } from 'pino';
import type { AgentConfig, AgentReport } from './types.js';

export interface ServerClientOptions {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
  /**
   * When running in Portlama plugin mode, an undici Dispatcher (Agent)
   * configured with mTLS client certificates. Passed as `dispatcher`
   * to Node 22+ fetch. When set, Bearer token auth is skipped --
   * authentication happens at the TLS layer.
   */
  readonly httpsAgent?: Dispatcher;
  /** Per-agent authentication token for X-Agent-Token header. */
  readonly agentToken?: string;
}

/** Registration payload sent to POST /api/sync/agents. */
export interface AgentRegistrationPayload {
  readonly name: string;
  readonly hostname: string;
  readonly os: string;
  readonly osVersion?: string;
  readonly nodeVersion: string;
  readonly agentVersion?: string;
  readonly projectIds?: readonly string[];
}

/** Registration response from the server. */
export interface AgentRegistrationResponse {
  readonly ok: boolean;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly hostname: string;
    readonly status: string;
  };
  /** Per-agent authentication token — returned only on registration. */
  readonly agentToken?: string;
}

/** Heartbeat payload sent to POST /api/sync/agents/:agentId/heartbeat. */
export interface HeartbeatPayload {
  readonly activeSyncs: ReadonlyArray<{
    readonly projectId: string;
    readonly operationId: string;
    readonly startedAt: string;
  }>;
  readonly diskUsage?: {
    readonly totalBytes: number;
    readonly freeBytes: number;
    readonly usedBytes: number;
  };
}

/**
 * Client for the sync-server REST API.
 * Uses the built-in Node.js fetch (available in Node 22+).
 */
export class ServerClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly pluginMode: boolean;
  private agentToken: string | undefined;

  constructor(options: ServerClientOptions) {
    // Normalize server URL: remove trailing slash
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.logger = options.logger.child({ component: 'server-client' });
    this.dispatcher = options.httpsAgent;
    this.pluginMode = options.httpsAgent !== undefined;
    this.agentToken = options.agentToken;

    if (this.pluginMode) {
      this.logger.info('ServerClient configured for plugin mode (mTLS)');
    }
  }

  /**
   * Update the stored agent token (e.g. after registration returns a new token).
   */
  setAgentToken(token: string): void {
    this.agentToken = token;
  }

  /**
   * Fetch the agent configuration from the server.
   * GET /api/sync/agent-config
   */
  async fetchConfig(): Promise<AgentConfig> {
    const url = `${this.serverUrl}/api/sync/agent-config`;
    this.logger.debug({ url }, 'Fetching agent config from server');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(30_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to fetch agent config: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }

    const data: unknown = await response.json();
    // Basic runtime validation: ensure required fields exist
    if (!isAgentConfig(data)) {
      throw new Error('Invalid agent config response from server');
    }
    return data;
  }

  /**
   * Report a sync operation result to the server.
   * POST /api/sync/agent-report
   */
  async report(report: AgentReport): Promise<void> {
    const url = `${this.serverUrl}/api/sync/agent-report`;
    this.logger.debug(
      { url, operationId: report.operationId, status: report.status },
      'Reporting sync result to server',
    );

    const headers = this.buildHeaders();
    if (this.agentToken) {
      headers['X-Agent-Token'] = this.agentToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(30_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn({ status: response.status, body }, 'Failed to report sync result to server');
      throw new Error(
        `Failed to report sync result: HTTP ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * Register this agent with the server.
   * POST /api/sync/agents
   *
   * Returns the agent ID assigned by the server. This ID should be persisted
   * in the agent settings for subsequent heartbeats.
   */
  async register(payload: AgentRegistrationPayload): Promise<AgentRegistrationResponse> {
    const url = `${this.serverUrl}/api/sync/agents`;
    this.logger.info(
      { name: payload.name, hostname: payload.hostname },
      'Registering agent with server',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to register agent: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }

    const data = (await response.json()) as AgentRegistrationResponse;

    this.logger.info(
      { agentId: data.agent.id, status: data.agent.status },
      'Agent registered successfully',
    );

    return data;
  }

  /**
   * Send a heartbeat to the server.
   * POST /api/sync/agents/:agentId/heartbeat
   *
   * @param agentToken - Per-agent authentication token (sent in X-Agent-Token header)
   */
  async heartbeat(agentId: string, payload: HeartbeatPayload, agentToken?: string): Promise<void> {
    const url = `${this.serverUrl}/api/sync/agents/${agentId}/heartbeat`;
    this.logger.debug({ agentId }, 'Sending heartbeat');

    const headers = this.buildHeaders();
    if (agentToken) {
      headers['X-Agent-Token'] = agentToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn({ status: response.status, body }, 'Heartbeat failed');
      throw new Error(`Heartbeat failed: HTTP ${response.status} ${response.statusText}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // In plugin mode, mTLS handles auth at the TLS layer — no Bearer token needed.
    // In standalone mode, use the API key.
    if (!this.pluginMode) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}

/** Runtime type guard for AgentConfig. */
function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['provider'] !== 'object' || obj['provider'] === null) return false;
  if (!Array.isArray(obj['projects'])) return false;

  const provider = obj['provider'] as Record<string, unknown>;
  if (typeof provider['type'] !== 'string') return false;
  if (typeof provider['bucket'] !== 'string') return false;

  return true;
}
