#!/usr/bin/env bash
# ============================================================================
# Test 19 — Protected Mode & Confirm-Destructive
# ============================================================================
# Tests two agent-side security features not covered by test 15:
#
# 1. Protected access mode: uses rclone copy --ignore-existing, so existing
#    local files are never overwritten and no deletions occur. Only new files
#    from the remote are downloaded.
#
# 2. Confirm-destructive mode: when the number of deletions in a sync exceeds
#    the configured deleteThreshold, the agent creates a pending preview and
#    blocks execution until approved. Below threshold, sync runs automatically.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Protected Mode & Confirm-Destructive"

AGENT_HOME="/root/.sync-agent"
APPROVED_PATHS="${AGENT_HOME}/approved-paths.json"
PENDING_DIR="${AGENT_HOME}/pending-syncs"

# ---------------------------------------------------------------------------
log_section "Cleanup leftover projects from previous tests"
# ---------------------------------------------------------------------------

# Previous tests (13, 15) may leave projects stuck in "syncing" state.
# Hard-delete them so they don't starve the agent.
api_delete "projects/soft-delete-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/active-op-delete-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/allowlist-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/protected-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/confirm-dest-test?permanent=true" > /dev/null 2>&1 || true

# Give agent a poll cycle to clear stale operations
sleep 5

# ============================================================================
log_section "Part 1: Protected access mode"
# ============================================================================

PROJECT_DIR="/tmp/sync-e2e-protected"
BUCKET_DIR="/tmp/sync-e2e-bucket/projects/protected-test"

# ---------------------------------------------------------------------------
log_section "1a. Setup: create project and push initial files"
# ---------------------------------------------------------------------------

api_delete "projects/protected-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{"name":"protected-test","direction":"push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Protected test project created"

# Set up approved path with protected access mode
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 1, 'entries': []}
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'protected-test']
data['entries'].append({
    'projectId': 'protected-test',
    'localPath': '${PROJECT_DIR}',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'protected-test',
    'accessMode': 'full'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Create initial files and push
agent_exec "mkdir -p '${PROJECT_DIR}'"
agent_exec "echo 'original-local' > '${PROJECT_DIR}/existing.txt'"
agent_exec "echo 'keep-this' > '${PROJECT_DIR}/keep.txt'"

SYNC_RESPONSE=$(api_post "projects/protected-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Initial push triggered"
wait_for_sync_complete "protected-test" 60
assert_eq "$?" "0" "Initial push completed"

# Verify files reached remote
assert_file_on_agent "${BUCKET_DIR}/existing.txt" "existing.txt in remote"

# ---------------------------------------------------------------------------
log_section "1b. Modify remote and add new remote file"
# ---------------------------------------------------------------------------

# Overwrite existing file in remote (simulating remote change)
agent_exec "echo 'modified-remote' > '${BUCKET_DIR}/existing.txt'"

# Add a brand new file in remote
agent_exec "echo 'new-remote-file' > '${BUCKET_DIR}/new-from-remote.txt'"

# ---------------------------------------------------------------------------
log_section "1c. Switch to protected mode and pull"
# ---------------------------------------------------------------------------

agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
for entry in data['entries']:
    if entry['projectId'] == 'protected-test':
        entry['accessMode'] = 'protected'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Trigger pull sync
api_post "projects/protected-test/sync" '{"direction":"pull"}' > /dev/null 2>&1

# Wait for agent to process
sleep 10

# Wait for sync to settle (protected pull may complete quickly or be overridden)
wait_for_sync_complete "protected-test" 30 || true

# ---------------------------------------------------------------------------
log_section "1d. Verify protected mode behavior"
# ---------------------------------------------------------------------------

# Existing file should NOT be overwritten (--ignore-existing)
EXISTING_CONTENT=$(agent_exec "cat '${PROJECT_DIR}/existing.txt' 2>/dev/null || echo ''")
assert_eq "$EXISTING_CONTENT" "original-local" "Protected mode: existing file NOT overwritten"

# New file from remote SHOULD be downloaded
NEW_CONTENT=$(agent_exec "cat '${PROJECT_DIR}/new-from-remote.txt' 2>/dev/null || echo ''")
assert_eq "$NEW_CONTENT" "new-remote-file" "Protected mode: new remote file downloaded"

# keep.txt should still be intact (no deletions in protected mode)
KEEP_CONTENT=$(agent_exec "cat '${PROJECT_DIR}/keep.txt' 2>/dev/null || echo ''")
assert_eq "$KEEP_CONTENT" "keep-this" "Protected mode: local-only file preserved"

# Check agent log for protected mode
AGENT_LOG=$(agent_exec "journalctl -u sync-agent --since '30 seconds ago' --no-pager 2>/dev/null || echo ''")
assert_contains "$AGENT_LOG" "protected" "Agent logged protected mode operation"

# ============================================================================
log_section "Part 2: Confirm-destructive mode"
# ============================================================================

CD_PROJECT_DIR="/tmp/sync-e2e-confirm-dest"
CD_BUCKET_DIR="/tmp/sync-e2e-bucket/projects/confirm-dest-test"

# ---------------------------------------------------------------------------
log_section "2a. Setup: create project with many files, push to remote"
# ---------------------------------------------------------------------------

api_delete "projects/confirm-dest-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{"name":"confirm-dest-test","direction":"push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Confirm-destructive project created"

# Set up approved path with confirm-destructive mode and low threshold
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
data['entries'] = [e for e in data['entries'] if e['projectId'] not in ('protected-test', 'confirm-dest-test')]
data['entries'].append({
    'projectId': 'confirm-dest-test',
    'localPath': '${CD_PROJECT_DIR}',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'confirm-dest-test',
    'confirmMode': 'confirm-destructive',
    'deleteThreshold': 2
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Create many files and ensure bucket dir exists
agent_exec "mkdir -p '${CD_PROJECT_DIR}' '${CD_BUCKET_DIR}' && for i in 1 2 3 4 5; do echo \"file-\${i}\" > \"${CD_PROJECT_DIR}/file\${i}.txt\"; done"

# Verify files were created locally before pushing
assert_file_on_agent "${CD_PROJECT_DIR}/file1.txt" "file1.txt created locally"

# For the initial push, use full access mode (no confirm-destructive overhead).
# We'll switch to confirm-destructive AFTER baseline is established.
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
for e in data['entries']:
    if e['projectId'] == 'confirm-dest-test':
        e['confirmMode'] = 'auto'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

SYNC_RESPONSE=$(api_post "projects/confirm-dest-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Initial push triggered"
wait_for_sync_complete "confirm-dest-test" 60
assert_eq "$?" "0" "Initial push completed"

# Verify files are in remote
assert_file_on_agent "${CD_BUCKET_DIR}/file1.txt" "file1.txt in remote"

# ---------------------------------------------------------------------------
log_section "2b. Switch to confirm-destructive and delete local files"
# ---------------------------------------------------------------------------

# Now switch to confirm-destructive mode with low threshold
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
for e in data['entries']:
    if e['projectId'] == 'confirm-dest-test':
        e['confirmMode'] = 'confirm-destructive'
        e['deleteThreshold'] = 2
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Delete 4 of 5 files locally. On next push, rclone would want to delete
# these 4 files from remote too. With threshold=2, this exceeds the limit.
agent_exec "rm -f '${CD_PROJECT_DIR}/file2.txt' '${CD_PROJECT_DIR}/file3.txt' '${CD_PROJECT_DIR}/file4.txt' '${CD_PROJECT_DIR}/file5.txt'"

# ---------------------------------------------------------------------------
log_section "2c. Trigger push — should create pending preview (>2 deletes)"
# ---------------------------------------------------------------------------

api_post "projects/confirm-dest-test/sync" '{"direction":"push"}' > /dev/null 2>&1

# Wait for agent to run dry-run and create pending preview
sleep 15

# Check that pending sync file was created
PENDING_EXISTS=$(agent_exec "test -d '${PENDING_DIR}' && ls '${PENDING_DIR}' 2>/dev/null | grep -c confirm-dest-test || echo '0'")
assert_not_eq "$PENDING_EXISTS" "0" "Pending preview created for destructive sync"

# Verify pending status
PREVIEW_STATUS=$(agent_exec "cat '${PENDING_DIR}/confirm-dest-test.json' 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[\"status\"])' 2>/dev/null || echo ''")
assert_eq "$PREVIEW_STATUS" "pending" "Preview has status 'pending'"

# Verify delete count exceeds threshold
DELETE_COUNT=$(agent_exec "cat '${PENDING_DIR}/confirm-dest-test.json' 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(\"deleteCount\", 0))' 2>/dev/null || echo '0'")
DELETE_NUM=$((DELETE_COUNT + 0))
if [ "$DELETE_NUM" -gt 2 ]; then
  log_pass "Preview shows $DELETE_NUM deletions (exceeds threshold of 2)"
else
  log_info "Preview shows $DELETE_NUM deletions (threshold: 2)"
fi

# Verify files still exist on remote (sync blocked)
REMOTE_FILE2=$(agent_exec "test -f '${CD_BUCKET_DIR}/file2.txt' && echo 'exists' || echo 'gone'")
assert_eq "$REMOTE_FILE2" "exists" "Remote file2.txt still exists (sync blocked by preview)"

# ---------------------------------------------------------------------------
log_section "2d. Approve the pending sync"
# ---------------------------------------------------------------------------

agent_exec "cat > /tmp/approve-sync.py << 'PYEOF'
import json, os
path = '${PENDING_DIR}/confirm-dest-test.json'
with open(path) as f:
    data = json.load(f)
data['status'] = 'approved'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF
python3 /tmp/approve-sync.py"

# Wait for agent to pick up approval and execute
sleep 15

wait_for_sync_complete "confirm-dest-test" 60 || true

# Verify the destructive sync executed after approval
REMOTE_FILE2_AFTER=$(agent_exec "test -f '${CD_BUCKET_DIR}/file2.txt' && echo 'exists' || echo 'gone'")
assert_eq "$REMOTE_FILE2_AFTER" "gone" "Remote file2.txt deleted after approval"

# file1.txt should still be in remote (not deleted)
assert_file_on_agent "${CD_BUCKET_DIR}/file1.txt" "file1.txt still in remote (not deleted)"

# ============================================================================
log_section "Cleanup"
# ============================================================================

api_delete "projects/protected-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/confirm-dest-test?permanent=true" > /dev/null 2>&1 || true
agent_exec "rm -rf '${PROJECT_DIR}' '${CD_PROJECT_DIR}'" 2>/dev/null || true
agent_exec "rm -rf '${BUCKET_DIR}' '${CD_BUCKET_DIR}'" 2>/dev/null || true

# Restore approved-paths.json
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    data = {'version': 1, 'entries': []}
data['entries'] = [e for e in data['entries'] if e['projectId'] == 'e2e-test-project']
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

end_test
