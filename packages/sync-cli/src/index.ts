import { checkNodeVersion } from '@lamalibre/sync-shared';

checkNodeVersion();

import pc from 'picocolors';
import { ApiClient, ApiRequestError } from './lib/api-client.js';
import { statusCommand } from './commands/status.js';
import { triggerCommand } from './commands/trigger.js';
import { archiveCommand } from './commands/archive.js';
import { restoreCommand } from './commands/restore.js';
import { configCommand } from './commands/config.js';
import { projectsCommand } from './commands/projects.js';
import { uninstallCommand } from './commands/uninstall.js';
import { trashListCommand } from './commands/trash-list.js';
import { trashPurgeCommand } from './commands/trash-purge.js';
import { projectDeleteCommand } from './commands/project-delete.js';
import { projectRestoreCommand } from './commands/project-restore.js';
import { trashRestoreCommand } from './commands/trash-restore.js';
import { agentApproveCommand } from './commands/agent-approve.js';
import { previewCommand } from './commands/preview.js';
import { agentsCommand } from './commands/agents.js';
import { storageCommand } from './commands/storage.js';
import { projectCreateCommand } from './commands/project-create.js';
import { projectEditCommand } from './commands/project-edit.js';
import { historyCommand } from './commands/history.js';
import { healthCommand } from './commands/health.js';

export const PACKAGE_NAME = '@lamalibre/sync-cli';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        // Check if next arg is a value (not a flag)
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`
${pc.bold('sync-cli')} - Sync project management CLI

${pc.bold('Usage:')}
  sync <command> [options]

${pc.bold('Commands:')}
  status                Show all projects and their sync status
  trigger [project]     Trigger sync for a project
  archive [project]     Archive project files to cloud storage
  restore [project]     Restore archived files from cloud storage
  config                Show current configuration
  projects              List projects (interactive detail selection)
  project-create        Create a new project
  project-edit [id]     Edit an existing project
  project-delete [id]   Delete a project (soft delete by default)
  project-restore [id]  Restore a soft-deleted project
  agents [agent-id]     List or manage agents
  storage [subcommand]  Configure and test storage (configure, test, create-bucket)
  history [project-id]  Show operation history
  health                Test server connection
  trash-list [project]  List trash entries for a project
  trash-purge [project] Purge trash for a project
  trash-restore [project] [timestamp] Restore files from trash
  agent-approve [id]    Approve or manage agent path allowlist
  preview [project]     Review pending sync changes before execution
  uninstall             Remove agent, config, and service
  help                  Show this help message

${pc.bold('Global Flags:')}
  --server <url>      Server URL (default: http://localhost:9393)
  --api-key <key>     API key for authentication (or SYNC_API_KEY env var)
  --json              Output in JSON format (non-interactive)
  --yes               Skip confirmation prompts
  --project <id>      Specify project ID (non-interactive)
  --detail <id>       Show details for a specific project (projects command)

${pc.bold('Agent Approve Flags:')}
  --list              Show approved and unmapped projects
  --reject            Remove an existing approval
  --path <dir>        Local directory path (non-interactive)
  --access-mode <m>   Access mode: full, push-only, pull-only, protected
  --confirm-mode <m>  Confirm mode: auto, confirm-destructive, confirm-always
  --delete-threshold <n>  Max deletions before requiring confirmation (default: 10)
  --agent-dir <path>  Override agent directory (default: ~/.sync-agent)

${pc.bold('Preview Flags:')}
  --approve           Approve a pending sync
  --reject            Reject a pending sync

${pc.bold('Agents Flags:')}
  --delete            Remove the specified agent

${pc.bold('Storage Configure Flags:')}
  --provider <type>   Provider type (spaces, s3, gcs, azure, b2, custom, local)
  --endpoint <url>    Storage endpoint URL
  --bucket <name>     Bucket name
  --region <region>   Region (optional)
  --access-key <key>  Access key (or SYNC_STORAGE_ACCESS_KEY env var)
  --secret-key <key>  Secret key (or SYNC_STORAGE_SECRET_KEY env var)
  --encrypt           Enable encryption at rest
  --encrypt-password <pw>  Encryption password (min 12 chars)

  ${pc.dim('Note: --access-key and --secret-key expose secrets in process arguments.')}
  ${pc.dim('Prefer SYNC_STORAGE_ACCESS_KEY and SYNC_STORAGE_SECRET_KEY env vars.')}

${pc.bold('Project Create/Edit Flags:')}
  --name <name>       Project name
  --remote-path <p>   Remote path
  --direction <d>     push, pull, or bidirectional
  --trigger <t>       manual, watch, schedule, or watch+schedule
  --conflict-strategy <s>  newest-wins, local-wins, remote-wins, or manual
  --encrypt           Enable encryption
  --encrypt-password <pw>  Encryption password (min 12 chars)
  --excludes <pats>   Comma-separated exclude patterns
  --bandwidth-limit <l>    Bandwidth limit (e.g. 10M, 500k)
  --watch-debounce <ms>    Watch debounce in ms (500-60000)

${pc.bold('History Flags:')}
  --limit <n>         Number of entries to show (default: 20)

${pc.bold('Delete/Restore Flags:')}
  --permanent         Hard delete (project-delete only)
  --older-than <7d>   Purge trash older than N days (trash-purge only)

${pc.bold('Examples:')}
  sync status
  sync trigger my-project --yes
  sync archive my-project --json
  sync projects --detail my-project
  sync project-create --name my-project --direction push --trigger watch
  sync project-edit my-project --direction bidirectional
  sync project-delete my-project --permanent --yes
  sync project-restore my-project
  sync agents
  sync agents <agent-id> --delete --yes
  sync storage
  sync storage configure
  sync storage test
  sync storage create-bucket --yes
  sync history
  sync history my-project --limit 50
  sync health
  sync trash-list my-project
  sync trash-purge my-project --older-than 7d --yes
  sync agent-approve --list
  sync agent-approve my-project --path /Users/me/projects/my-project
  sync agent-approve my-project --access-mode push-only
  sync preview
  sync preview my-project --approve
  sync status --server http://remote:9393 --api-key sync_abc123

${pc.bold('Configuration:')}
  CLI config is stored at ~/.sync-cli/config.json
  Server defaults to http://localhost:9393

`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  const json = flags['json'] === true;
  const yes = flags['yes'] === true;
  const server = typeof flags['server'] === 'string' ? flags['server'] : undefined;
  const apiKey = typeof flags['api-key'] === 'string' ? flags['api-key'] : (process.env['SYNC_API_KEY'] ?? undefined);
  const project = typeof flags['project'] === 'string' ? flags['project'] : undefined;
  const detail = typeof flags['detail'] === 'string' ? flags['detail'] : undefined;
  const permanent = flags['permanent'] === true;
  const olderThan = typeof flags['older-than'] === 'string' ? flags['older-than'] : undefined;
  const reject = flags['reject'] === true;
  const list = flags['list'] === true;
  const approve = flags['approve'] === true;
  const agentDir = typeof flags['agent-dir'] === 'string' ? flags['agent-dir'] : undefined;
  const accessMode = typeof flags['access-mode'] === 'string' ? flags['access-mode'] : undefined;
  const confirmMode = typeof flags['confirm-mode'] === 'string' ? flags['confirm-mode'] : undefined;
  const deleteThreshold = typeof flags['delete-threshold'] === 'string' ? flags['delete-threshold'] : undefined;
  const pathFlag = typeof flags['path'] === 'string' ? flags['path'] : undefined;
  const deleteFlag = flags['delete'] === true;
  const limit = typeof flags['limit'] === 'string' ? flags['limit'] : undefined;
  const provider = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const endpoint = typeof flags['endpoint'] === 'string' ? flags['endpoint'] : undefined;
  const bucket = typeof flags['bucket'] === 'string' ? flags['bucket'] : undefined;
  const region = typeof flags['region'] === 'string' ? flags['region'] : undefined;
  const accessKey = typeof flags['access-key'] === 'string' ? flags['access-key'] : undefined;
  const secretKey = typeof flags['secret-key'] === 'string' ? flags['secret-key'] : undefined;
  const encrypt = flags['encrypt'] === true;
  const encryptPassword = typeof flags['encrypt-password'] === 'string' ? flags['encrypt-password'] : undefined;
  const name = typeof flags['name'] === 'string' ? flags['name'] : undefined;
  const remotePath = typeof flags['remote-path'] === 'string' ? flags['remote-path'] : undefined;
  const direction = typeof flags['direction'] === 'string' ? flags['direction'] : undefined;
  const trigger = typeof flags['trigger'] === 'string' ? flags['trigger'] : undefined;
  const conflictStrategy = typeof flags['conflict-strategy'] === 'string' ? flags['conflict-strategy'] : undefined;
  const excludes = typeof flags['excludes'] === 'string' ? flags['excludes'] : undefined;
  const bandwidthLimit = typeof flags['bandwidth-limit'] === 'string' ? flags['bandwidth-limit'] : undefined;
  const watchDebounce = typeof flags['watch-debounce'] === 'string' ? flags['watch-debounce'] : undefined;

  // Commands that don't need the API client
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'uninstall') {
    await uninstallCommand({ yes, json });
    return;
  }

  // Create API client for commands that need it
  let client: ApiClient;
  try {
    client = await ApiClient.fromConfig({ server, apiKey });
  } catch (err) {
    process.stderr.write(
      pc.red(
        `Failed to initialize API client: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exit(1);
  }

  try {
    switch (command) {
      case 'status':
        await statusCommand(client, { json });
        break;

      case 'trigger':
      case 'sync':
        await triggerCommand(client, positional[0], { project, json, yes });
        break;

      case 'archive':
        await archiveCommand(client, positional[0], { project, json, yes });
        break;

      case 'restore':
        await restoreCommand(client, positional[0], { project, json, yes });
        break;

      case 'config':
        await configCommand(client, { json });
        break;

      case 'projects':
        await projectsCommand(client, { json, detail });
        break;

      case 'project-delete':
        await projectDeleteCommand(client, positional[0], { project, json, yes, permanent });
        break;

      case 'project-restore':
        await projectRestoreCommand(client, positional[0], { project, json, yes });
        break;

      case 'trash-list':
        await trashListCommand(client, positional[0], { project, json });
        break;

      case 'trash-purge':
        await trashPurgeCommand(client, positional[0], { project, json, yes, olderThan });
        break;

      case 'trash-restore':
        await trashRestoreCommand(client, positional[0], positional[1], { project, json, yes });
        break;

      case 'agent-approve':
        await agentApproveCommand(client, positional[0], {
          project,
          json,
          yes,
          reject,
          list,
          agentDir,
          accessMode,
          confirmMode,
          deleteThreshold,
          path: pathFlag,
        });
        break;

      case 'preview':
        await previewCommand(positional[0], {
          project,
          json,
          yes,
          approve,
          reject,
          agentDir,
        });
        break;

      case 'agents':
        await agentsCommand(client, positional[0], { json, yes, delete: deleteFlag });
        break;

      case 'storage':
        await storageCommand(client, positional[0], {
          json,
          yes,
          provider,
          endpoint,
          bucket,
          region,
          accessKey,
          secretKey,
          encrypt,
          encryptPassword,
        });
        break;

      case 'project-create':
        await projectCreateCommand(client, {
          json,
          name,
          remotePath,
          direction,
          trigger,
          conflictStrategy,
          encrypt,
          encryptPassword,
          excludes,
          bandwidthLimit,
          watchDebounce,
        });
        break;

      case 'project-edit':
        await projectEditCommand(client, positional[0], {
          project,
          json,
          yes,
          name,
          remotePath,
          direction,
          trigger,
          conflictStrategy,
          encrypt,
          encryptPassword,
          excludes,
          bandwidthLimit,
          watchDebounce,
        });
        break;

      case 'history':
        await historyCommand(client, positional[0], { json, limit, project });
        break;

      case 'health':
        await healthCommand(client, { json });
        break;

      default:
        process.stderr.write(pc.red(`Unknown command: ${command}\n\n`));
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof ApiRequestError) {
      process.stderr.write(pc.red(`Error: ${err.message}\n`));
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.message.includes('fetch failed')) {
    process.stderr.write(
      pc.red(
        'Could not connect to sync server. Is it running?\n' +
          'Start the server or use --server to specify a different URL.\n',
      ),
    );
  } else {
    process.stderr.write(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`));
  }
  process.exit(1);
});
