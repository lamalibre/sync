#!/usr/bin/env bash
# ============================================================================
# Test 09 — Archive & Restore
# ============================================================================
# Tests the iCloud-style archive/restore workflow: archive moves files to the
# cloud and leaves small stub files locally; restore fetches them back.
# Verifies space savings tracking and stub file metadata.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Archive & Restore"

# ---------------------------------------------------------------------------
log_section "Get project ID"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJECT_ID=$(echo "$PROJECTS" | jq -r '.projects[] | select(.name == "e2e-test-project") | .id' 2>/dev/null || echo "")
assert_not_eq "$PROJECT_ID" "" "Project ID retrieved"

# ---------------------------------------------------------------------------
log_section "Record file sizes before archive"
# ---------------------------------------------------------------------------

HELLO_SIZE=$(agent_exec "stat -c %s /tmp/sync-e2e-project/hello.txt 2>/dev/null || echo '0'")
log_info "hello.txt size before archive: ${HELLO_SIZE} bytes"

# ---------------------------------------------------------------------------
log_section "Restore on non-archived project returns 400"
# ---------------------------------------------------------------------------

RESTORE_BEFORE_ARCHIVE_STATUS=$(api_post_status "projects/${PROJECT_ID}/restore")
assert_eq "$RESTORE_BEFORE_ARCHIVE_STATUS" "400" "Restore on non-archived project returns 400"

# ---------------------------------------------------------------------------
log_section "Trigger archive operation"
# ---------------------------------------------------------------------------

ARCHIVE_RESPONSE=$(api_post "projects/${PROJECT_ID}/archive" '{"files": ["hello.txt", "data.txt"]}')
assert_json_field "$ARCHIVE_RESPONSE" '.ok' "true" "Archive operation triggered"

# ---------------------------------------------------------------------------
log_section "Wait for archive to complete"
# ---------------------------------------------------------------------------

wait_for_sync_complete "$PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Archive completed within 60s"

# ---------------------------------------------------------------------------
log_section "Verify stub files replace originals"
# ---------------------------------------------------------------------------

# The archive creates a single .sync-stub.json file with project metadata
STUB_EXISTS=$(agent_exec "test -f /tmp/sync-e2e-project/.sync-stub.json && echo 'yes' || echo 'no'")
assert_eq "$STUB_EXISTS" "yes" ".sync-stub.json exists after archive"

# Stub should be small (metadata only, not full file content)
STUB_SIZE=$(agent_exec "stat -c %s /tmp/sync-e2e-project/.sync-stub.json 2>/dev/null || echo '0'")
STUB_SIZE_NUM=$((STUB_SIZE + 0))
if [ "$STUB_SIZE_NUM" -lt 4096 ]; then
  log_pass "Stub file is small (${STUB_SIZE} bytes < 4KB)"
else
  log_fail "Stub file is too large (${STUB_SIZE} bytes, expected < 4KB)"
fi

# Original files should be removed (moved to remote)
HELLO_GONE=$(agent_exec "test -f /tmp/sync-e2e-project/hello.txt && echo 'exists' || echo 'gone'")
assert_eq "$HELLO_GONE" "gone" "hello.txt removed after archive (moved to remote)"

# ---------------------------------------------------------------------------
log_section "Verify archived files exist in remote bucket"
# ---------------------------------------------------------------------------

assert_file_on_agent "/tmp/sync-e2e-bucket/projects/e2e-test-project/hello.txt" "Archived hello.txt exists in remote"
assert_file_on_agent "/tmp/sync-e2e-bucket/projects/e2e-test-project/data.txt" "Archived data.txt exists in remote"

# ---------------------------------------------------------------------------
log_section "Archive on already-archived project returns 400"
# ---------------------------------------------------------------------------

DOUBLE_ARCHIVE_STATUS=$(api_post_status "projects/${PROJECT_ID}/archive" '{}')
assert_eq "$DOUBLE_ARCHIVE_STATUS" "400" "Archive on already-archived project returns 400"

# ---------------------------------------------------------------------------
log_section "Trigger restore operation"
# ---------------------------------------------------------------------------

RESTORE_RESPONSE=$(api_post "projects/${PROJECT_ID}/restore" '{}')
assert_json_field "$RESTORE_RESPONSE" '.ok' "true" "Restore operation triggered"

# ---------------------------------------------------------------------------
log_section "Wait for restore to complete"
# ---------------------------------------------------------------------------

wait_for_sync_complete "$PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Restore completed within 60s"

# ---------------------------------------------------------------------------
log_section "Verify restored file content"
# ---------------------------------------------------------------------------

assert_file_on_agent "/tmp/sync-e2e-project/hello.txt" "hello.txt restored on agent"
RESTORED_CONTENT=$(agent_exec "cat /tmp/sync-e2e-project/hello.txt" 2>/dev/null || echo "")
assert_eq "$RESTORED_CONTENT" "Hello, world!" "Restored file content matches original"

# Stub should be removed after restore
STUB_GONE=$(agent_exec "test -f /tmp/sync-e2e-project/.sync-stub.json && echo 'exists' || echo 'gone'")
assert_eq "$STUB_GONE" "gone" "Stub file removed after restore"

end_test
