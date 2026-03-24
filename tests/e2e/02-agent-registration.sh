#!/usr/bin/env bash
# ============================================================================
# Test 02 — Agent Registration
# ============================================================================
# Verifies the sync-agent on the agent VM has successfully registered with the
# sync-server on the host VM. Tests the cross-VM registration handshake,
# heartbeat mechanism, and agent listing via the server API.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Agent Registration"

# ---------------------------------------------------------------------------
log_section "Agent process running on agent VM"
# ---------------------------------------------------------------------------

AGENT_PID=$(agent_exec "pgrep -f sync-agent || echo ''")
assert_not_eq "$AGENT_PID" "" "sync-agent process is running on agent VM"

# ---------------------------------------------------------------------------
log_section "Agent registered with server"
# ---------------------------------------------------------------------------

# Wait for agent to appear in server's agent list
wait_for_agent_count "1" 30
RESULT=$?
assert_eq "$RESULT" "0" "Agent registered with server within 30s"

AGENTS=$(api_get "agents")
AGENT_COUNT=$(echo "$AGENTS" | jq -r '.agents | length' 2>/dev/null || echo "0")
assert_eq "$AGENT_COUNT" "1" "Exactly one agent registered"

# ---------------------------------------------------------------------------
log_section "Agent metadata is correct"
# ---------------------------------------------------------------------------

AGENT_ID=$(echo "$AGENTS" | jq -r '.agents[0].id')
assert_json_field_not_empty "$AGENTS" '.agents[0].id' "Agent has an ID"
assert_json_field_not_empty "$AGENTS" '.agents[0].name' "Agent has a name"
assert_json_field "$AGENTS" '.agents[0].status' "online" "Agent status is 'online'"

log_info "Agent ID: $AGENT_ID"

# ---------------------------------------------------------------------------
log_section "Agent heartbeat working"
# ---------------------------------------------------------------------------

# Wait a few seconds for a heartbeat to occur
sleep 6

# Check that the agent's lastHeartbeat is recent
AGENTS_UPDATED=$(api_get "agents")
LAST_HEARTBEAT=$(echo "$AGENTS_UPDATED" | jq -r '.agents[0].lastHeartbeat // empty' 2>/dev/null || echo "")
assert_not_eq "$LAST_HEARTBEAT" "" "Agent has sent a heartbeat"

# ---------------------------------------------------------------------------
log_section "Agent settings persisted on agent VM"
# ---------------------------------------------------------------------------

assert_file_on_agent "/root/.sync-agent/agent-settings.json" "Agent settings file exists"

SETTINGS=$(agent_exec "cat /root/.sync-agent/agent-settings.json" 2>/dev/null || echo "{}")
assert_contains "$SETTINGS" "$HOST_IP" "Agent settings contain host IP"

end_test
