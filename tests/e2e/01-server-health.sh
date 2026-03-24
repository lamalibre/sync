#!/usr/bin/env bash
# ============================================================================
# Test 01 — Server Health
# ============================================================================
# Verifies the sync-server on the host VM is running and responding to health
# checks from macOS across the network. This is the foundation test — if this
# fails, no other test can proceed.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Server Health"

# ---------------------------------------------------------------------------
log_section "Health endpoint reachable from macOS"
# ---------------------------------------------------------------------------

assert_http_status "${BASE_URL}/api/sync/health" "200"

HEALTH=$(api_get "health")
assert_json_field "$HEALTH" '.ok' "true" "Health status is ok"

# ---------------------------------------------------------------------------
log_section "Server process running on host VM"
# ---------------------------------------------------------------------------

SERVER_PID=$(host_exec "pgrep -f sync-server || echo ''")
assert_not_eq "$SERVER_PID" "" "sync-server process is running on host"

# ---------------------------------------------------------------------------
log_section "Server listening on configured port"
# ---------------------------------------------------------------------------

LISTENING=$(host_exec "ss -tlnp | grep :9393 || echo ''")
assert_contains "$LISTENING" "9393" "Server listening on port 9393"

# ---------------------------------------------------------------------------
log_section "API base path responds"
# ---------------------------------------------------------------------------

# Verify a known API endpoint returns proper JSON
STATUS=$(api_get_status "health")
assert_eq "$STATUS" "200" "API health endpoint returns 200"

# Verify unknown paths return 404
STATUS=$(api_get_status "nonexistent-endpoint")
assert_eq "$STATUS" "404" "Unknown API path returns 404"

# ---------------------------------------------------------------------------
log_section "Server accessible from agent VM"
# ---------------------------------------------------------------------------

AGENT_STATUS=$(agent_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://${HOST_IP}:9393/api/sync/health' 2>/dev/null || echo '000'")
assert_eq "$AGENT_STATUS" "200" "Server reachable from agent VM"

end_test
