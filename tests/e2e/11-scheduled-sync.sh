#!/usr/bin/env bash
# ============================================================================
# Test 11 — Scheduled Sync
# ============================================================================
# Verifies that cron-based scheduling works: the agent picks up a schedule
# configuration from the server and executes syncs at the scheduled interval.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Scheduled Sync"

# ---------------------------------------------------------------------------
log_section "Get project ID"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"

# ---------------------------------------------------------------------------
log_section "Configure sync schedule"
# ---------------------------------------------------------------------------

# Set a tight schedule (every minute) for testing purposes
SCHEDULE_CONFIG='{"schedule": "* * * * *", "direction": "push", "trigger": "schedule"}'
RESPONSE=$(api_patch "projects/${PROJECT_ID}" "$SCHEDULE_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Schedule configured"

# Verify schedule is stored
PROJECT=$(api_get "projects/${PROJECT_ID}")
assert_json_field "$PROJECT" '.project.schedule' "* * * * *" "Schedule stored correctly"

# ---------------------------------------------------------------------------
log_section "Wait for agent to pick up schedule config"
# ---------------------------------------------------------------------------

# Agent polls every 5s in test mode, so wait for config propagation
sleep 10

# ---------------------------------------------------------------------------
log_section "Create a new file and wait for scheduled sync"
# ---------------------------------------------------------------------------

agent_exec "echo 'Scheduled sync data' > /tmp/sync-e2e-project/scheduled-test.txt"

HISTORY_BEFORE=$(api_get "history?projectId=${PROJECT_ID}")
COUNT_BEFORE=$(echo "$HISTORY_BEFORE" | jq -r '.operations | length' 2>/dev/null || echo "0")

# Wait up to 120s for the cron job to fire (should fire within 60-90s accounting for poll delay)
ELAPSED=0
TIMEOUT=120
SCHEDULED_FIRED=false
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  HISTORY_NOW=$(api_get "history?projectId=${PROJECT_ID}")
  COUNT_NOW=$(echo "$HISTORY_NOW" | jq -r '.operations | length' 2>/dev/null || echo "0")
  if [ "$COUNT_NOW" -gt "$COUNT_BEFORE" ]; then
    LAST_TRIGGER=$(echo "$HISTORY_NOW" | jq -r '.operations[0].trigger // empty' 2>/dev/null || echo "")
    if [ "$LAST_TRIGGER" = "schedule" ]; then
      SCHEDULED_FIRED=true
      break
    fi
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [ "$SCHEDULED_FIRED" = true ]; then
  log_pass "Scheduled sync fired (trigger: schedule)"
else
  log_fail "Scheduled sync did not fire within ${TIMEOUT}s"
fi

# ---------------------------------------------------------------------------
log_section "Verify scheduled sync transferred files"
# ---------------------------------------------------------------------------

CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/scheduled-test.txt 2>/dev/null || echo ''")
assert_eq "$CONTENT" "Scheduled sync data" "Scheduled sync transferred new file"

# ---------------------------------------------------------------------------
log_section "Remove schedule"
# ---------------------------------------------------------------------------

RESPONSE=$(api_patch "projects/${PROJECT_ID}" '{"schedule": null}')
assert_json_field "$RESPONSE" '.ok' "true" "Schedule removed"

end_test
