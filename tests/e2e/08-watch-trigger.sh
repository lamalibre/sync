#!/usr/bin/env bash
# ============================================================================
# Test 08 — Watch Trigger
# ============================================================================
# Verifies that the agent's file watcher (chokidar) detects local file changes
# and automatically triggers a sync operation without manual intervention.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Watch Trigger"

# ---------------------------------------------------------------------------
log_section "Get project ID and enable watch mode"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"

# Enable file watching on the project
RESPONSE=$(api_patch "projects/${PROJECT_ID}" '{"watch": true, "direction": "push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Watch mode enabled"

# Give the agent time to pick up the config change and start watching
sleep 10

# ---------------------------------------------------------------------------
log_section "Record current sync history count"
# ---------------------------------------------------------------------------

HISTORY_BEFORE=$(api_get "history?projectId=${PROJECT_ID}")
COUNT_BEFORE=$(echo "$HISTORY_BEFORE" | jq -r '.operations | length' 2>/dev/null || echo "0")
log_info "History count before: $COUNT_BEFORE"

# ---------------------------------------------------------------------------
log_section "Create a new file on agent (trigger watcher)"
# ---------------------------------------------------------------------------

agent_exec "echo 'Watch trigger test' > /tmp/sync-e2e-project/watch-test.txt"
log_info "Created watch-test.txt on agent"

# ---------------------------------------------------------------------------
log_section "Wait for automatic sync to trigger and complete"
# ---------------------------------------------------------------------------

# The watcher debounces for ~5s, then the sync runs. Give it up to 30s.
ELAPSED=0
TIMEOUT=30
TRIGGERED=false
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  HISTORY_NOW=$(api_get "history?projectId=${PROJECT_ID}")
  COUNT_NOW=$(echo "$HISTORY_NOW" | jq -r '.operations | length' 2>/dev/null || echo "0")
  if [ "$COUNT_NOW" -gt "$COUNT_BEFORE" ]; then
    TRIGGERED=true
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ "$TRIGGERED" = true ]; then
  log_pass "File watcher triggered a sync (history count: $COUNT_BEFORE -> $COUNT_NOW)"
else
  log_fail "File watcher did not trigger a sync within ${TIMEOUT}s"
fi

# ---------------------------------------------------------------------------
log_section "Verify watched file was synced to remote"
# ---------------------------------------------------------------------------

CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/watch-test.txt 2>/dev/null || echo ''")
assert_eq "$CONTENT" "Watch trigger test" "Watched file synced to remote"

# ---------------------------------------------------------------------------
log_section "Verify trigger type recorded as 'watch'"
# ---------------------------------------------------------------------------

HISTORY_FINAL=$(api_get "history?projectId=${PROJECT_ID}")
LAST_TRIGGER=$(echo "$HISTORY_FINAL" | jq -r '.operations[0].trigger // empty' 2>/dev/null || echo "")
assert_eq "$LAST_TRIGGER" "watch" "Sync triggered by watcher"

end_test
