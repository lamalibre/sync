#!/usr/bin/env bash
# ============================================================================
# Sync E2E — Host VM Setup
# ============================================================================
# Provisions the sync-host VM: configures and starts the sync-server,
# completes the initial setup (API key generation), and writes credentials
# to /tmp/sync-e2e-credentials.json for the agent to use.
#
# Usage: bash setup-host.sh [port]
#
# Arguments:
#   port — sync-server port (default: 9393)
# ============================================================================

set -euo pipefail

# Guard: this script must run inside a Linux VM, not on macOS
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: setup-host.sh must run inside a Linux VM, not on $(uname -s)."
  echo "It is invoked automatically by the MCP provision_host tool."
  exit 1
fi

PORT="${1:-9393}"
SYNC_DIR="/opt/sync"
CREDS_FILE="/tmp/sync-e2e-credentials.json"

echo "=== Setting up sync-host VM ==="
echo "  Port: ${PORT}"
echo "  Project: ${SYNC_DIR}"

# ---------------------------------------------------------------------------
# 1. Create systemd service for sync-server
# ---------------------------------------------------------------------------
echo "--- Creating sync-server systemd service ---"

cat > /etc/systemd/system/sync-server.service <<EOF
[Unit]
Description=Sync Server (E2E)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SYNC_DIR}
ExecStart=/usr/bin/node ${SYNC_DIR}/packages/sync-server/bin/sync-server.mjs
Environment=SYNC_PORT=${PORT}
Environment=SYNC_HOST=0.0.0.0
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sync-server
systemctl restart sync-server

# ---------------------------------------------------------------------------
# 2. Wait for server to become healthy
# ---------------------------------------------------------------------------
echo "--- Waiting for sync-server to become healthy ---"

ELAPSED=0
TIMEOUT=30
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 2 \
    "http://127.0.0.1:${PORT}/api/sync/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "  Server healthy (HTTP 200)"
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "ERROR: sync-server did not become healthy within ${TIMEOUT}s"
  systemctl status sync-server --no-pager || true
  journalctl -u sync-server --no-pager -n 50 || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Complete initial setup — generate API key
# ---------------------------------------------------------------------------
echo "--- Completing initial setup (API key generation) ---"

# Extract the one-time setup token from server logs
SETUP_TOKEN=""
ELAPSED=0
while [ "$ELAPSED" -lt 10 ]; do
  SETUP_TOKEN=$(journalctl -u sync-server --no-pager -o cat 2>/dev/null \
    | grep -oP 'Setup token: \K[a-f0-9]+' | tail -1 || echo "")
  if [ -n "$SETUP_TOKEN" ]; then
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ -z "$SETUP_TOKEN" ]; then
  echo "WARNING: Could not extract setup token from logs, trying without token..."
fi

# Generate the API key
SETUP_RESPONSE=$(curl -s \
  --max-time 10 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Setup-Token: ${SETUP_TOKEN}" \
  -d '{}' \
  "http://127.0.0.1:${PORT}/api/sync/setup/api-key" 2>/dev/null || echo '{}')

API_KEY=$(echo "$SETUP_RESPONSE" | jq -r '.apiKey // empty' 2>/dev/null || echo "")

if [ -z "$API_KEY" ]; then
  echo "ERROR: Failed to generate API key"
  echo "  Response: $SETUP_RESPONSE"
  exit 1
fi

echo "  API key generated"

# ---------------------------------------------------------------------------
# 4. Write credentials file for the agent
# ---------------------------------------------------------------------------
echo "--- Writing credentials file ---"

cat > "$CREDS_FILE" <<EOF
{
  "apiKey": "${API_KEY}",
  "port": ${PORT}
}
EOF
chmod 0600 "$CREDS_FILE"

echo "  Credentials at ${CREDS_FILE}"

# ---------------------------------------------------------------------------
# 5. Create local rclone test remote for storage testing
# ---------------------------------------------------------------------------
echo "--- Setting up rclone test remote ---"

BUCKET_DIR="/tmp/sync-e2e-bucket"
mkdir -p "$BUCKET_DIR"

RCLONE_CONFIG="/tmp/sync-e2e-rclone.conf"
cat > "$RCLONE_CONFIG" <<EOF
[test-remote]
type = local
nounc = true
EOF
chmod 0600 "$RCLONE_CONFIG"

echo "  Test bucket at ${BUCKET_DIR}"
echo "  Rclone config at ${RCLONE_CONFIG}"

echo ""
echo "=== sync-host setup complete ==="
echo "  Server running at http://0.0.0.0:${PORT}"
echo "  API key stored in ${CREDS_FILE}"
