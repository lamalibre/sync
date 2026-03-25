#!/usr/bin/env bash
# ============================================================================
# Test 14 — Error Paths & Edge Cases
# ============================================================================
# Tests authentication rejection, history filtering, and API error responses
# that are not covered by happy-path tests.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Error Paths & Edge Cases"

# ---------------------------------------------------------------------------
log_section "Authentication — missing Bearer token returns 401"
# ---------------------------------------------------------------------------

NO_AUTH_STATUS=$(api_raw_status GET "status")
assert_eq "$NO_AUTH_STATUS" "401" "Request without Authorization header returns 401"

# ---------------------------------------------------------------------------
log_section "Authentication — invalid Bearer token returns 403"
# ---------------------------------------------------------------------------

BAD_AUTH_STATUS=$(api_raw_status GET "status" -H "Authorization: Bearer invalid-token-12345")
assert_eq "$BAD_AUTH_STATUS" "403" "Request with invalid Bearer token returns 403"

# ---------------------------------------------------------------------------
log_section "Authentication — health endpoint skips auth"
# ---------------------------------------------------------------------------

HEALTH_NO_AUTH_STATUS=$(api_raw_status GET "health")
assert_eq "$HEALTH_NO_AUTH_STATUS" "200" "Health endpoint works without auth"

# ---------------------------------------------------------------------------
log_section "History endpoint — filter by projectId"
# ---------------------------------------------------------------------------

# Get a project that has history from previous tests
PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")

if [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ]; then
  # Get full history
  ALL_HISTORY=$(api_get "history")
  ALL_COUNT=$(echo "$ALL_HISTORY" | jq -r '.operations | length' 2>/dev/null || echo "0")
  log_info "Total history entries: $ALL_COUNT"

  # Filter by projectId
  FILTERED_HISTORY=$(api_get "history?projectId=${PROJECT_ID}")
  FILTERED_COUNT=$(echo "$FILTERED_HISTORY" | jq -r '.operations | length' 2>/dev/null || echo "0")

  # All filtered entries should belong to the requested project
  if [ "$FILTERED_COUNT" -gt 0 ]; then
    WRONG_PROJECT=$(echo "$FILTERED_HISTORY" | jq -r "[.operations[] | select(.projectId != \"${PROJECT_ID}\")] | length" 2>/dev/null || echo "0")
    assert_eq "$WRONG_PROJECT" "0" "Filtered history contains only matching projectId entries"
  else
    log_info "No history entries for project $PROJECT_ID (may not have synced yet)"
  fi

  # Filter by limit
  LIMITED_HISTORY=$(api_get "history?limit=1")
  LIMITED_COUNT=$(echo "$LIMITED_HISTORY" | jq -r '.operations | length' 2>/dev/null || echo "0")
  if [ "$ALL_COUNT" -gt 1 ]; then
    assert_eq "$LIMITED_COUNT" "1" "History limit=1 returns exactly 1 entry"
  else
    log_info "Not enough history entries to test limit (have $ALL_COUNT)"
  fi

  # Combined filter
  COMBINED_HISTORY=$(api_get "history?projectId=${PROJECT_ID}&limit=1")
  COMBINED_COUNT=$(echo "$COMBINED_HISTORY" | jq -r '.operations | length' 2>/dev/null || echo "0")
  if [ "$COMBINED_COUNT" -gt 0 ]; then
    COMBINED_PID=$(echo "$COMBINED_HISTORY" | jq -r '.operations[0].projectId' 2>/dev/null || echo "")
    assert_eq "$COMBINED_PID" "$PROJECT_ID" "Combined history filter returns correct project"
  fi
  log_pass "History filtering with projectId and limit works"
else
  log_skip "No projects available for history filter test"
fi

# ---------------------------------------------------------------------------
log_section "Per-project status — nonexistent project returns 404"
# ---------------------------------------------------------------------------

STATUS_404=$(api_get_status "projects/nonexistent-id-xyz/status")
assert_eq "$STATUS_404" "404" "Status for nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Sync on nonexistent project returns 404"
# ---------------------------------------------------------------------------

SYNC_404_STATUS=$(api_post_status "projects/nonexistent-id-xyz/sync")
assert_eq "$SYNC_404_STATUS" "404" "Sync on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Archive on nonexistent project returns 404"
# ---------------------------------------------------------------------------

ARCHIVE_404_STATUS=$(api_post_status "projects/nonexistent-id-xyz/archive")
assert_eq "$ARCHIVE_404_STATUS" "404" "Archive on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Restore on nonexistent project returns 404"
# ---------------------------------------------------------------------------

RESTORE_404_STATUS=$(api_post_status "projects/nonexistent-id-xyz/restore")
assert_eq "$RESTORE_404_STATUS" "404" "Restore on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Purge trash on nonexistent project returns 404"
# ---------------------------------------------------------------------------

PURGE_404_STATUS=$(api_post_status "projects/nonexistent-id-xyz/purge-trash")
assert_eq "$PURGE_404_STATUS" "404" "Purge trash on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "List trash on nonexistent project returns 404"
# ---------------------------------------------------------------------------

TRASH_404_STATUS=$(api_get_status "projects/nonexistent-id-xyz/trash")
assert_eq "$TRASH_404_STATUS" "404" "List trash on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Restore trash on nonexistent project returns 404"
# ---------------------------------------------------------------------------

RESTORE_TRASH_404_STATUS=$(api_post_status "projects/nonexistent-id-xyz/restore-trash")
assert_eq "$RESTORE_TRASH_404_STATUS" "404" "Restore trash on nonexistent project returns 404"

# ---------------------------------------------------------------------------
log_section "Cron step-of-zero rejected"
# ---------------------------------------------------------------------------

CRON_ZERO_CONFIG='{
  "name": "bad-cron-zero",
  "localPath": "/tmp/sync-e2e-bad-cron-zero",
  "schedule": "*/0 * * * *"
}'
CRON_ZERO_STATUS=$(api_post_status "projects" "$CRON_ZERO_CONFIG")
assert_not_eq "$CRON_ZERO_STATUS" "200" "Server rejects cron expression with step of zero"

end_test
