# Standalone Setup

> Set up Sync as a self-contained server with its own API key, encrypted credential storage, and agent enrollment — a complete file sync solution that does not depend on Portlama.

## In Plain English

This guide installs Sync as a self-contained system on your machine. The installer creates a server (the coordinator that stores project definitions and credentials), generates an encryption key, walks you through connecting to your cloud storage, and installs a system service so everything starts automatically on boot.

## Prerequisites

**Server machine (your Mac or a VPS):**
- Node.js 22+
- A port accessible to agent machines (default: 9393)

**Agent machine (the machine with files to sync):**
- Node.js 22+
- rclone installed (`brew install rclone` on macOS, `apt install rclone` on Linux)
- Network access to server port 9393

## Server Installation

### One-Command Setup

```bash
npx @lamalibre/create-sync
```

The installer runs interactively and performs:

1. **Platform detection** — verifies macOS or Linux
2. **rclone check** — verifies rclone is installed (shows install instructions if not)
3. **Directory creation** — creates `~/.sync/` with mode `0700`
4. **Master key generation** — creates random 32-byte encryption key
5. **Server startup** — starts the server temporarily on port 9393 (logs a one-time setup token)
6. **API key generation** — prompts for the setup token, then generates a Bearer token (printed once — save it)
7. **Storage setup** — walks you through provider configuration (Spaces, S3, GCS, etc.)
8. **Connection test** — verifies the storage bucket is accessible
9. **First project** — optionally creates your first sync project
10. **Service installation** — creates a launchd plist (macOS) or systemd unit (Linux)

At the end, the installer prints:
- The server URL
- Your API key
- Instructions for enrolling agents on other machines

### What Gets Created

```
~/.sync/
├── sync-config.json        # Storage config (encrypted credentials), mode 0600
├── projects.json           # Project definitions
├── sync-history.json       # Sync operation log
├── archive-savings.json    # Archive disk savings tracker
├── agents.json             # Agent registry
└── master.key              # Encryption master key, mode 0600

~/.sync-cli/
├── config.json             # CLI config (server URL)
└── master.key              # CLI encryption key, mode 0600
```

### Service Management

**macOS (launchd):**

```bash
# Check status
launchctl list | grep sync

# Stop
launchctl unload ~/Library/LaunchAgents/com.lamalibre.sync-server.plist

# Start
launchctl load ~/Library/LaunchAgents/com.lamalibre.sync-server.plist

# Logs
tail -f ~/.sync/sync-server.log
```

**Linux (systemd):**

```bash
# Check status
systemctl --user status sync-server

# Restart
systemctl --user restart sync-server

# Logs
journalctl --user -u sync-server -f
```

## Agent Installation

If the agent runs on a different machine than the server, install it separately:

```bash
npx @lamalibre/create-sync --agent --server http://<server-ip>:9393 --api-key <your-api-key>
```

See [Agent Enrollment](agent-enrollment.md) for the complete guide.

## Reconfiguring

If `~/.sync/` already exists, the installer prompts before overwriting. To start fresh:

```bash
# Stop the service first
launchctl unload ~/Library/LaunchAgents/com.lamalibre.sync-server.plist  # macOS
# or
systemctl --user stop sync-server  # Linux

# Remove state
rm -rf ~/.sync/ ~/.sync-cli/

# Reinstall
npx @lamalibre/create-sync
```

## Uninstalling

```bash
sync uninstall
```

This removes:
1. The launchd/systemd service
2. Agent settings at `~/.sync-agent/`
3. CLI config at `~/.sync-cli/`

Server state (`~/.sync/`) is not removed automatically — delete it manually if desired.

## Related Documentation

- [Agent Enrollment](agent-enrollment.md) — enrolling agents step by step
- [Configuring Storage](configuring-storage.md) — provider setup after installation
- [CLI Usage](cli-usage.md) — using the sync CLI
- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs plugin comparison
