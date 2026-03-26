#!/usr/bin/env bash
# ============================================================================
# Sync E2E — Agent VM Setup
# ============================================================================
# Provisions the sync-agent VM: configures the sync-agent to connect to the
# sync-host server and starts it as a daemon.
# Called by the MCP provision_agent tool after Node.js/rclone are installed
# and the project has been built at /opt/sync.
#
# Usage: bash setup-agent.sh <host_ip> [port] [api_key]
#
# Arguments:
#   host_ip — IP address of the sync-host VM
#   port    — sync-server port (default: 9393)
#   api_key — API key for authenticating with the server
# ============================================================================

set -euo pipefail

# Guard: this script must run inside a Linux VM, not on macOS
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: setup-agent.sh must run inside a Linux VM, not on $(uname -s)."
  echo "It is invoked automatically by the MCP provision_agent tool."
  exit 1
fi

HOST_IP="${1:?Usage: setup-agent.sh <host_ip> [port] [api_key]}"
PORT="${2:-9393}"
API_KEY="${3:-e2e-test-key}"
SYNC_DIR="/opt/sync"
AGENT_HOME="/root/.sync-agent"

echo "=== Setting up sync-agent VM ==="
echo "  Host: http://${HOST_IP}:${PORT}"
echo "  Project: ${SYNC_DIR}"

# ---------------------------------------------------------------------------
# 1. Verify connectivity to host server
# ---------------------------------------------------------------------------
echo "--- Verifying connectivity to sync-host ---"

ELAPSED=0
TIMEOUT=30
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 2 \
    "http://${HOST_IP}:${PORT}/api/sync/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "  Connected to sync-host (HTTP 200)"
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "ERROR: Cannot reach sync-host at http://${HOST_IP}:${PORT}"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Create agent home directory
# ---------------------------------------------------------------------------
echo "--- Creating agent home directory ---"

mkdir -p "$AGENT_HOME"
chmod 0700 "$AGENT_HOME"

# ---------------------------------------------------------------------------
# 3. Create local rclone test remote (simulates cloud storage on agent)
# ---------------------------------------------------------------------------
echo "--- Setting up rclone test remote ---"

BUCKET_DIR="/tmp/sync-e2e-bucket"
mkdir -p "$BUCKET_DIR"

RCLONE_CONFIG="${AGENT_HOME}/rclone.conf"
cat > "$RCLONE_CONFIG" <<EOF
[test-remote]
type = local
nounc = true
EOF
chmod 0600 "$RCLONE_CONFIG"

echo "  Test bucket at ${BUCKET_DIR}"
echo "  Rclone config at ${RCLONE_CONFIG}"

# ---------------------------------------------------------------------------
# 4. Create agent settings (standalone mode with API key)
# ---------------------------------------------------------------------------
echo "--- Configuring agent settings ---"

cat > "${AGENT_HOME}/agent-settings.json" <<EOF
{
  "serverUrl": "http://${HOST_IP}:${PORT}",
  "apiKey": "${API_KEY}",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 5000
}
EOF
chmod 0600 "${AGENT_HOME}/agent-settings.json"

# ---------------------------------------------------------------------------
# 4b. Create approved-paths.json for default e2e project
# ---------------------------------------------------------------------------
echo "--- Creating approved-paths.json ---"

cat > "${AGENT_HOME}/approved-paths.json" <<EOF
{
  "version": 1,
  "entries": [
    {
      "projectId": "e2e-test-project",
      "localPath": "/tmp/sync-e2e-project",
      "approvedAt": "2026-01-01T00:00:00.000Z",
      "projectName": "e2e-test-project"
    }
  ]
}
EOF
chmod 0600 "${AGENT_HOME}/approved-paths.json"

# ---------------------------------------------------------------------------
# 5. Create test project directory with sample files
# ---------------------------------------------------------------------------
echo "--- Creating test project directory ---"

TEST_PROJECT="/tmp/sync-e2e-project"
mkdir -p "${TEST_PROJECT}/subdir"
echo "Hello, world!" > "${TEST_PROJECT}/hello.txt"
echo "Test data for sync" > "${TEST_PROJECT}/data.txt"
echo "Nested file" > "${TEST_PROJECT}/subdir/nested.txt"

echo "  Test project at ${TEST_PROJECT}"

# ---------------------------------------------------------------------------
# 6. Create systemd service for sync-agent
# ---------------------------------------------------------------------------
echo "--- Creating sync-agent systemd service ---"

cat > /etc/systemd/system/sync-agent.service <<EOF
[Unit]
Description=Sync Agent (E2E)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SYNC_DIR}
ExecStart=/usr/bin/node ${SYNC_DIR}/packages/sync-agent/bin/sync-agent.mjs
Environment=SYNC_AGENT_HOME=${AGENT_HOME}
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sync-agent
systemctl restart sync-agent

# ---------------------------------------------------------------------------
# 7. Wait for agent to register with server
# ---------------------------------------------------------------------------
echo "--- Waiting for agent to register with server ---"

ELAPSED=0
TIMEOUT=30
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  RESPONSE=$(curl -s --max-time 2 \
    -H "Authorization: Bearer ${API_KEY}" \
    "http://${HOST_IP}:${PORT}/api/sync/agents" 2>/dev/null || echo '{}')
  AGENT_COUNT=$(echo "$RESPONSE" | jq -r '.agents | length' 2>/dev/null || echo "0")
  if [ "$AGENT_COUNT" -gt 0 ]; then
    AGENT_ID=$(echo "$RESPONSE" | jq -r '.agents[0].id' 2>/dev/null || echo "unknown")
    echo "  Agent registered (id: ${AGENT_ID})"
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "WARNING: Agent did not register within ${TIMEOUT}s (may register later)"
  systemctl status sync-agent --no-pager || true
  journalctl -u sync-agent --no-pager -n 30 || true
fi

echo ""
echo "=== sync-agent setup complete ==="
echo "  Agent configured to connect to http://${HOST_IP}:${PORT}"
