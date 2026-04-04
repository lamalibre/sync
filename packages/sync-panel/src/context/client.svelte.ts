import { getContext, setContext } from 'svelte';
import type { SyncClient } from '../lib/client.js';

const CLIENT_KEY = Symbol('sync-client');

/**
 * Set the SyncClient in Svelte context.
 * Must be called during component initialization (in a parent component).
 */
export function setSyncClient(client: SyncClient): void {
  setContext(CLIENT_KEY, client);
}

/**
 * Get the SyncClient from Svelte context.
 * Must be called during component initialization.
 */
export function getSyncClient(): SyncClient {
  return getContext<SyncClient>(CLIENT_KEY);
}
