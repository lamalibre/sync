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
  status              Show all projects and their sync status
  trigger [project]   Trigger sync for a project
  archive [project]   Archive project files to cloud storage
  restore [project]   Restore archived files from cloud storage
  config              Show current configuration
  projects            List projects (interactive detail selection)
  uninstall           Remove agent, config, and service
  help                Show this help message

${pc.bold('Global Flags:')}
  --server <url>      Server URL (default: http://localhost:9393)
  --api-key <key>     API key for authentication
  --json              Output in JSON format (non-interactive)
  --yes               Skip confirmation prompts
  --project <id>      Specify project ID (non-interactive)
  --detail <id>       Show details for a specific project (projects command)

${pc.bold('Examples:')}
  sync status
  sync trigger my-project --yes
  sync archive my-project --json
  sync projects --detail my-project
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
  const apiKey = typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined;
  const project = typeof flags['project'] === 'string' ? flags['project'] : undefined;
  const detail = typeof flags['detail'] === 'string' ? flags['detail'] : undefined;

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
