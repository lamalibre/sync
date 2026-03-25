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

# ---------------------------------------------------------------------------
log_section "Agent project assignment"
# ---------------------------------------------------------------------------

AGENTS=$(api_get "agents")
AGENT_ID=$(echo "$AGENTS" | jq -r '.agents[0].id')

ASSIGN_RESPONSE=$(api_patch "agents/${AGENT_ID}/projects" '{"projectIds": ["test-project-1", "test-project-2"]}')
assert_json_field "$ASSIGN_RESPONSE" '.ok' "true" "Agent project assignment accepted"

ASSIGNED_COUNT=$(echo "$ASSIGN_RESPONSE" | jq -r '.agent.projectIds | length' 2>/dev/null || echo "0")
assert_eq "$ASSIGNED_COUNT" "2" "Agent has 2 assigned projects"

# ---------------------------------------------------------------------------
log_section "Agent token auth — invalid token rejected"
# ---------------------------------------------------------------------------

# Send heartbeat with a wrong token — should get 403
# Use -K for auth header to keep API key out of process args
BAD_TOKEN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time "$CURL_TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$API_KEY") \
  -H "X-Agent-Token: invalid-token-value" \
  -d '{"activeSyncs": []}' \
  "${BASE_URL}/api/sync/agents/${AGENT_ID}/heartbeat" 2>/dev/null || echo "000")
assert_eq "$BAD_TOKEN_STATUS" "403" "Heartbeat with invalid agent token returns 403"

# Send heartbeat without token — agent has a stored hash, should get 403
NO_TOKEN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time "$CURL_TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$API_KEY") \
  -d '{"activeSyncs": []}' \
  "${BASE_URL}/api/sync/agents/${AGENT_ID}/heartbeat" 2>/dev/null || echo "000")
assert_eq "$NO_TOKEN_STATUS" "403" "Heartbeat without agent token returns 403"

# ---------------------------------------------------------------------------
log_section "Register and remove a second agent"
# ---------------------------------------------------------------------------

SECOND_AGENT=$(api_post "agents" '{
  "name": "test-agent-2",
  "hostname": "test-host-2",
  "os": "linux",
  "osVersion": "22.04",
  "nodeVersion": "20.0.0",
  "agentVersion": "1.0.0",
  "projectIds": []
}')
assert_json_field "$SECOND_AGENT" '.ok' "true" "Second agent registered"

SECOND_ID=$(echo "$SECOND_AGENT" | jq -r '.agent.id')
assert_json_field_not_empty "$SECOND_AGENT" '.agent.id' "Second agent has an ID"

# Verify two agents exist
AGENTS_LIST=$(api_get "agents")
AGENT_COUNT=$(echo "$AGENTS_LIST" | jq -r '.agents | length' 2>/dev/null || echo "0")
assert_eq "$AGENT_COUNT" "2" "Two agents registered"

# Remove the second agent
DELETE_RESPONSE=$(api_delete "agents/${SECOND_ID}")
assert_json_field "$DELETE_RESPONSE" '.ok' "true" "Second agent removed"

# Verify only one agent remains
AGENTS_AFTER=$(api_get "agents")
AGENT_COUNT_AFTER=$(echo "$AGENTS_AFTER" | jq -r '.agents | length' 2>/dev/null || echo "0")
assert_eq "$AGENT_COUNT_AFTER" "1" "Only original agent remains after removal"

# Delete nonexistent agent returns 404
DELETE_404_STATUS=$(api_delete_status "agents/00000000-0000-0000-0000-000000000000")
assert_eq "$DELETE_404_STATUS" "404" "Delete nonexistent agent returns 404"

end_test
