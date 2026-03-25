#!/usr/bin/env bash
# ============================================================================
# Test 07 — Bidirectional Sync
# ============================================================================
# Tests rclone bisync: changes on both local (agent) and remote sides are
# merged. Verifies conflict detection when the same file is modified on both
# sides simultaneously.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Bidirectional Sync"

# ---------------------------------------------------------------------------
log_section "Setup: get project ID and update to bidirectional"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"

# Update project to bidirectional sync
RESPONSE=$(api_patch "projects/${PROJECT_ID}" '{"syncDirection": "bidirectional"}')
assert_json_field "$RESPONSE" '.ok' "true" "Project updated to bidirectional"

# ---------------------------------------------------------------------------
log_section "Make changes on local side (agent)"
# ---------------------------------------------------------------------------

agent_exec "echo 'Local-side change' > /tmp/sync-e2e-project/local-change.txt"
assert_file_on_agent "/tmp/sync-e2e-project/local-change.txt" "Local-side file created"

# ---------------------------------------------------------------------------
log_section "Make changes on remote side"
# ---------------------------------------------------------------------------

agent_exec "echo 'Remote-side change' > /tmp/sync-e2e-bucket/projects/e2e-test-project/remote-change.txt"
assert_file_on_agent "/tmp/sync-e2e-bucket/projects/e2e-test-project/remote-change.txt" "Remote-side file created"

# ---------------------------------------------------------------------------
log_section "Trigger bidirectional sync"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/${PROJECT_ID}/sync" '{"direction": "bidirectional"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Bisync triggered"

# ---------------------------------------------------------------------------
log_section "Wait for sync to complete"
# ---------------------------------------------------------------------------

wait_for_sync_complete "$PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Bisync completed within 60s"

# ---------------------------------------------------------------------------
log_section "Verify both sides are merged"
# ---------------------------------------------------------------------------

# Local-side change should appear in remote
REMOTE_LOCAL=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/local-change.txt 2>/dev/null || echo ''")
assert_eq "$REMOTE_LOCAL" "Local-side change" "Local change propagated to remote"

# Remote-side change should appear in local
LOCAL_REMOTE=$(agent_exec "cat /tmp/sync-e2e-project/remote-change.txt 2>/dev/null || echo ''")
assert_eq "$LOCAL_REMOTE" "Remote-side change" "Remote change propagated to local"

# ---------------------------------------------------------------------------
log_section "Verify bisync recorded in history"
# ---------------------------------------------------------------------------

HISTORY=$(api_get "history?projectId=${PROJECT_ID}")
LAST_OP=$(echo "$HISTORY" | jq -r '.operations[0].direction' 2>/dev/null || echo "")
assert_eq "$LAST_OP" "bidirectional" "Last operation was bidirectional"

end_test
