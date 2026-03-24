// ============================================================================
// Sync E2E MCP Server
// ============================================================================
// MCP server for managing the Sync E2E test infrastructure: two-VM lifecycle,
// provisioning, snapshots, test execution with dependency resolution, and
// two-tier logging.
//
// Usage:
//   node src/index.js              # stdio transport (for Claude Code)
//   sync-e2e-mcp                   # via bin link
//
// VMs:
//   sync-host   — runs sync-server (Fastify REST API)
//   sync-agent  — runs sync-agent daemon (polls server, executes rclone)
//
// Tools:
//   env_detect          — detect hardware, recommend VM profile
//   vm_create           — create VMs with a resource profile
//   vm_list             — list running VMs
//   vm_delete           — tear down VMs
//   vm_exec             — execute command on a VM
//   snapshot_create     — snapshot VMs at a checkpoint
//   snapshot_restore    — restore VMs to a checkpoint
//   snapshot_list       — list available snapshots
//   provision_host      — full host provisioning pipeline
//   provision_agent     — agent setup and registration
//   hot_reload          — re-pack and redeploy a single VM
//   test_run            — run a specific test with dependency resolution
//   test_run_all        — run full test suite
//   test_list           — list tests with dependency graph
//   test_reset          — clean up test artifacts on both VMs
//   env_status          — full environment health check
//   test_log            — fetch raw log for a test run
//   prereq_check        — verify prerequisites are installed
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { envDetectTool } from './tools/env.js';
import { vmCreateTool, vmListTool, vmDeleteTool, vmExecTool } from './tools/vm.js';
import { snapshotCreateTool, snapshotRestoreTool, snapshotListTool } from './tools/snapshots.js';
import { provisionHostTool, provisionAgentTool, hotReloadTool } from './tools/provision.js';
import { testRunTool, testRunAllTool, testListTool, testResetTool } from './tools/tests.js';
import { envStatusTool, testLogTool, prereqCheckTool } from './tools/status.js';

const server = new McpServer({
  name: 'sync-e2e',
  version: '0.1.0',
});

// Register all tools
const tools = [
  envDetectTool,
  vmCreateTool,
  vmListTool,
  vmDeleteTool,
  vmExecTool,
  snapshotCreateTool,
  snapshotRestoreTool,
  snapshotListTool,
  provisionHostTool,
  provisionAgentTool,
  hotReloadTool,
  testRunTool,
  testRunAllTool,
  testListTool,
  testResetTool,
  envStatusTool,
  testLogTool,
  prereqCheckTool,
];

for (const tool of tools) {
  // MCP SDK expects raw Zod shape ({ key: z.string() }), not z.object({ ... })
  const shape = tool.inputSchema.shape || {};
  server.tool(tool.name, tool.description, shape, async (args) => {
    return tool.handler(args || {});
  });
}

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
