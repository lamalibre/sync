import { loadCliConfig, saveCliConfig } from '@lamalibre/sync-shared';
import type { CliConfig } from '@lamalibre/sync-shared';

export { loadCliConfig, saveCliConfig };
export type { CliConfig };

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface ApiError {
  ok: false;
  error: string;
  details?: unknown;
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  static async fromConfig(overrides?: { server?: string; apiKey?: string }): Promise<ApiClient> {
    const config = await loadCliConfig();
    const baseUrl = overrides?.server ?? config.serverUrl;
    const apiKey = overrides?.apiKey ?? config.apiKey;
    return new ApiClient(baseUrl, apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({
        error: `HTTP ${res.status}`,
      }))) as ApiError;
      throw new ApiRequestError(res.status, body.error);
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const respBody = (await res.json().catch(() => ({
        error: `HTTP ${res.status}`,
      }))) as ApiError;
      throw new ApiRequestError(res.status, respBody.error);
    }
    return (await res.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const respBody = (await res.json().catch(() => ({
        error: `HTTP ${res.status}`,
      }))) as ApiError;
      throw new ApiRequestError(res.status, respBody.error);
    }
    return (await res.json()) as T;
  }

  async delete<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const respBody = (await res.json().catch(() => ({
        error: `HTTP ${res.status}`,
      }))) as ApiError;
      throw new ApiRequestError(res.status, respBody.error);
    }
    return (await res.json()) as T;
  }
}

export class ApiRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}
