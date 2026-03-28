import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import {
  renderTable,
  formatRelativeTime,
  formatBytes,
  jsonOutput,
} from '../lib/format.js';

// ---------------------------------------------------------------------------
// Types matching server response shapes
// ---------------------------------------------------------------------------

interface AgentDiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

interface AgentActiveSync {
  projectId: string;
  operationId: string;
  startedAt: string;
}

interface Agent {
  id: string;
  name: string;
  hostname: string;
  os: string;
  osVersion?: string;
  nodeVersion: string;
  agentVersion?: string;
  projectIds: string[];
  lastHeartbeat: string;
  registeredAt: string;
  activeSyncs: AgentActiveSync[];
  diskUsage?: AgentDiskUsage;
  status: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface AgentsOptions {
  json?: boolean;
  yes?: boolean;
  delete?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function agentsCommand(
  client: ApiClient,
  agentArg: string | undefined,
  opts: AgentsOptions,
): Promise<void> {
  // Delete an agent
  if (agentArg && opts.delete) {
    await deleteAgent(client, agentArg, opts);
    return;
  }

  // Show detail for a specific agent
  if (agentArg) {
    await showAgent(client, agentArg, opts);
    return;
  }

  // List all agents
  await listAgents(client, opts);
}

// ---------------------------------------------------------------------------
// List all agents
// ---------------------------------------------------------------------------

async function listAgents(client: ApiClient, opts: AgentsOptions): Promise<void> {
  const res = await client.get<{ agents: Agent[] }>('/api/sync/agents');

  if (opts.json) {
    process.stdout.write(jsonOutput(res.agents) + '\n');
    return;
  }

  if (res.agents.length === 0) {
    process.stdout.write(pc.dim('\n  No agents registered.\n\n'));
    return;
  }

  process.stdout.write(pc.bold('\nAgents\n\n'));

  const rows = res.agents.map((agent) => ({
    name: agent.name,
    hostname: agent.hostname,
    os: `${agent.os}${agent.osVersion ? ` ${agent.osVersion}` : ''}`,
    version: agent.agentVersion ?? pc.dim('unknown'),
    status: agent.status === 'online' ? pc.green('online') : pc.red('offline'),
    syncs: String(agent.activeSyncs.length),
    disk: agent.diskUsage
      ? `${formatBytes(agent.diskUsage.usedBytes)} / ${formatBytes(agent.diskUsage.totalBytes)}`
      : pc.dim('n/a'),
  }));

  const table = renderTable(
    [
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Hostname', key: 'hostname', width: 20 },
      { header: 'OS', key: 'os', width: 16 },
      { header: 'Version', key: 'version', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Syncs', key: 'syncs', width: 6, align: 'right' },
      { header: 'Disk', key: 'disk' },
    ],
    rows,
  );

  process.stdout.write(`${table}\n\n`);
}

// ---------------------------------------------------------------------------
// Show a single agent
// ---------------------------------------------------------------------------

async function showAgent(client: ApiClient, agentId: string, opts: AgentsOptions): Promise<void> {
  const res = await client.get<{ agent: Agent }>(
    `/api/sync/agents/${encodeURIComponent(agentId)}`,
  );
  const agent = res.agent;

  if (opts.json) {
    process.stdout.write(jsonOutput(agent) + '\n');
    return;
  }

  const statusLabel =
    agent.status === 'online' ? pc.green('online') : pc.red('offline');

  process.stdout.write(pc.bold(`\nAgent: ${agent.name}\n\n`));
  process.stdout.write(
    `  ID:           ${agent.id}\n` +
      `  Hostname:     ${agent.hostname}\n` +
      `  OS:           ${agent.os}${agent.osVersion ? ` ${agent.osVersion}` : ''}\n` +
      `  Node:         ${agent.nodeVersion}\n` +
      `  Version:      ${agent.agentVersion ?? pc.dim('unknown')}\n` +
      `  Status:       ${statusLabel}\n` +
      `  Registered:   ${formatRelativeTime(agent.registeredAt)}\n` +
      `  Last beat:    ${formatRelativeTime(agent.lastHeartbeat)}\n` +
      `  Projects:     ${agent.projectIds.length > 0 ? agent.projectIds.join(', ') : pc.dim('all')}\n`,
  );

  if (agent.diskUsage) {
    const pct = ((agent.diskUsage.usedBytes / agent.diskUsage.totalBytes) * 100).toFixed(1);
    process.stdout.write(
      `  Disk:         ${formatBytes(agent.diskUsage.usedBytes)} / ${formatBytes(agent.diskUsage.totalBytes)} (${pct}%)\n`,
    );
  }

  if (agent.activeSyncs.length > 0) {
    process.stdout.write(`\n  ${pc.bold('Active syncs:')}\n`);
    for (const sync of agent.activeSyncs) {
      process.stdout.write(
        `    - ${sync.projectId} (${pc.dim(sync.operationId)}) started ${formatRelativeTime(sync.startedAt)}\n`,
      );
    }
  }

  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Delete an agent
// ---------------------------------------------------------------------------

async function deleteAgent(
  client: ApiClient,
  agentId: string,
  opts: AgentsOptions,
): Promise<void> {
  if (!opts.yes && !opts.json) {
    const confirmed = await p.confirm({
      message: `Remove agent "${agentId}"? This cannot be undone.`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.delete<{ ok: boolean }>(
    `/api/sync/agents/${encodeURIComponent(agentId)}`,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Agent "${agentId}" removed.`);
}
