#!/usr/bin/env bash
# ============================================================================
# Test 06 — Pull Sync
# ============================================================================
# Modifies files in the remote bucket, then triggers a pull sync to the agent.
# Verifies that updated files arrive on the agent's local filesystem and that
# the pull operation is recorded in sync history.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Pull Sync"

# ---------------------------------------------------------------------------
log_section "Modify files in remote bucket"
# ---------------------------------------------------------------------------

# Add a new file to the remote bucket directly
agent_exec "echo 'New remote file' > /tmp/sync-e2e-bucket/e2e-test-project/remote-new.txt"
assert_file_on_agent "/tmp/sync-e2e-bucket/e2e-test-project/remote-new.txt" "New file created in remote bucket"

# Modify an existing file in the bucket
agent_exec "echo 'Updated data from remote' > /tmp/sync-e2e-bucket/e2e-test-project/data.txt"

# ---------------------------------------------------------------------------
log_section "Get project ID"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[0].id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"

# ---------------------------------------------------------------------------
log_section "Trigger pull sync"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/${PROJECT_ID}/sync" '{"direction": "pull"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Pull sync triggered"

# ---------------------------------------------------------------------------
log_section "Wait for sync to complete"
# ---------------------------------------------------------------------------

wait_for_sync_complete "$PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Pull sync completed within 60s"

# ---------------------------------------------------------------------------
log_section "Verify pulled files on agent local filesystem"
# ---------------------------------------------------------------------------

# New file should appear in local project dir
assert_file_on_agent "/tmp/sync-e2e-project/remote-new.txt" "New file pulled to local"
CONTENT=$(agent_exec "cat /tmp/sync-e2e-project/remote-new.txt" 2>/dev/null || echo "")
assert_eq "$CONTENT" "New remote file" "Pulled file content matches"

# Modified file should be updated
UPDATED=$(agent_exec "cat /tmp/sync-e2e-project/data.txt" 2>/dev/null || echo "")
assert_eq "$UPDATED" "Updated data from remote" "Modified file content pulled"

# ---------------------------------------------------------------------------
log_section "Verify pull recorded in history"
# ---------------------------------------------------------------------------

HISTORY=$(api_get "projects/${PROJECT_ID}/history")
LAST_OP=$(echo "$HISTORY" | jq -r '.history[0].direction' 2>/dev/null || echo "")
assert_eq "$LAST_OP" "pull" "Last operation was a pull"

end_test
