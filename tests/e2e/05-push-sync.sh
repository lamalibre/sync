#!/usr/bin/env bash
# ============================================================================
# Test 05 — Push Sync
# ============================================================================
# Triggers a push sync from the agent VM to the remote storage. Verifies that
# the agent executes rclone, files arrive at the remote bucket, and the server
# records the sync operation in history.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Push Sync"

# ---------------------------------------------------------------------------
log_section "Create test project files on agent"
# ---------------------------------------------------------------------------

agent_exec "mkdir -p /tmp/sync-e2e-project/subdir"
agent_exec "echo 'Hello, world!' > /tmp/sync-e2e-project/hello.txt"
agent_exec "echo 'Test data for sync' > /tmp/sync-e2e-project/data.txt"
agent_exec "echo 'Nested file' > /tmp/sync-e2e-project/subdir/nested.txt"

# Also create the remote bucket directory
agent_exec "mkdir -p /tmp/sync-e2e-bucket"

assert_file_on_agent "/tmp/sync-e2e-project/hello.txt" "hello.txt exists on agent"
assert_file_on_agent "/tmp/sync-e2e-project/data.txt" "data.txt exists on agent"
assert_file_on_agent "/tmp/sync-e2e-project/subdir/nested.txt" "nested.txt exists on agent"

# ---------------------------------------------------------------------------
log_section "Get project ID"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"
log_info "Project ID: $PROJECT_ID"

# ---------------------------------------------------------------------------
log_section "Trigger push sync via API"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/${PROJECT_ID}/sync" '{"direction": "push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Push sync triggered"

# ---------------------------------------------------------------------------
log_section "Wait for sync to complete"
# ---------------------------------------------------------------------------

wait_for_sync_complete "$PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Push sync completed within 60s"

# ---------------------------------------------------------------------------
log_section "Verify files arrived at remote bucket on agent"
# ---------------------------------------------------------------------------

# The remote bucket is a local filesystem path on the agent VM
HELLO_CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/hello.txt 2>/dev/null || echo ''")
assert_eq "$HELLO_CONTENT" "Hello, world!" "hello.txt synced to remote bucket"

DATA_CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/data.txt 2>/dev/null || echo ''")
assert_eq "$DATA_CONTENT" "Test data for sync" "data.txt synced to remote bucket"

NESTED_CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/e2e-test-project/subdir/nested.txt 2>/dev/null || echo ''")
assert_eq "$NESTED_CONTENT" "Nested file" "nested.txt synced to remote bucket"

# ---------------------------------------------------------------------------
log_section "Verify sync recorded in project history"
# ---------------------------------------------------------------------------

# Wait briefly for agent report to update history entry status
sleep 2

HISTORY=$(api_get "history?projectId=${PROJECT_ID}")
HISTORY_COUNT=$(echo "$HISTORY" | jq -r '.operations | length' 2>/dev/null || echo "0")
assert_not_eq "$HISTORY_COUNT" "0" "Sync operation recorded in history"

LAST_OP=$(echo "$HISTORY" | jq -r '.operations[0].direction' 2>/dev/null || echo "")
assert_eq "$LAST_OP" "push" "Last operation was a push"

LAST_STATUS=$(echo "$HISTORY" | jq -r '.operations[0].status' 2>/dev/null || echo "")
assert_eq "$LAST_STATUS" "completed" "Last operation status is 'completed'"

end_test
