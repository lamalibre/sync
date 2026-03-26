#!/usr/bin/env bash
# ============================================================================
# Test 15 — Path Security (Allowlist, Access Mode, Sync Preview)
# ============================================================================
# Tests the three agent-side security features:
#
# 1. Path Allowlist: Agent refuses to sync projects without a local path
#    mapping in approved-paths.json. No local path ever crosses the network.
#
# 2. Access Mode: Agent enforces direction overrides locally.
#    push-only blocks pull, pull-only blocks push, protected uses
#    rclone copy --ignore-existing.
#
# 3. Sync Preview: When confirm mode is active, agent runs rclone --dry-run
#    and saves a pending preview. Sync proceeds only after approval.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Path Security — Allowlist, Access Mode, Sync Preview"

AGENT_HOME="/root/.sync-agent"
APPROVED_PATHS="${AGENT_HOME}/approved-paths.json"
PENDING_DIR="${AGENT_HOME}/pending-syncs"

# ============================================================================
log_section "Part 1: Path Allowlist — no mapping = no sync"
# ============================================================================

# ---------------------------------------------------------------------------
log_section "1a. Create a project with no local path mapping"
# ---------------------------------------------------------------------------

# Clean up from previous runs
api_delete "projects/allowlist-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{"name":"allowlist-test","direction":"push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Project created (no localPath in request)"

# Verify server response has no localPath field
HAS_LOCAL_PATH=$(echo "$RESPONSE" | jq 'has("localPath") or (.project | has("localPath"))' 2>/dev/null || echo "true")
assert_eq "$HAS_LOCAL_PATH" "false" "Server response does not contain localPath"

# ---------------------------------------------------------------------------
log_section "1b. Verify agent blocks sync for unmapped project"
# ---------------------------------------------------------------------------

# The agent should NOT sync this project because it has no local path mapping
SYNC_RESPONSE=$(api_post "projects/allowlist-test/sync" '{"direction":"push"}')

# Wait a few seconds — the agent should pick up the operation but refuse it
sleep 5

# Check agent logs for the "No local path configured" warning
AGENT_LOG=$(agent_exec "journalctl -u sync-agent --since '5 seconds ago' --no-pager 2>/dev/null || echo ''")
assert_contains "$AGENT_LOG" "No local path configured" "Agent logged warning about missing path mapping"

# ---------------------------------------------------------------------------
log_section "1c. Add local path mapping and verify sync works"
# ---------------------------------------------------------------------------

# Create the directory on agent
agent_exec "mkdir -p /tmp/sync-e2e-allowlist"
agent_exec "echo 'allowlist-test' > /tmp/sync-e2e-allowlist/test.txt"

# Write approved-paths.json with the new mapping
# Read current approved paths and add new entry
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 1, 'entries': []}
# Remove existing entry if any
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'allowlist-test']
data['entries'].append({
    'projectId': 'allowlist-test',
    'localPath': '/tmp/sync-e2e-allowlist',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'allowlist-test'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Trigger sync — should now succeed
SYNC_RESPONSE=$(api_post "projects/allowlist-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Push sync triggered for mapped project"

wait_for_sync_complete "allowlist-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Sync completed for project with approved path"

# Verify file reached remote bucket
CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/allowlist-test/test.txt 2>/dev/null || echo ''")
assert_eq "$CONTENT" "allowlist-test" "File synced to remote after path approval"

# ============================================================================
log_section "Part 2: Access Mode — direction enforcement"
# ============================================================================

# ---------------------------------------------------------------------------
log_section "2a. Set push-only access mode"
# ---------------------------------------------------------------------------

# Update approved-paths.json to set accessMode: push-only
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
for entry in data['entries']:
    if entry['projectId'] == 'allowlist-test':
        entry['accessMode'] = 'push-only'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Create a new file on agent to push
agent_exec "echo 'push-only-test' > /tmp/sync-e2e-allowlist/push-only.txt"

# Trigger push — should succeed
PUSH_RESPONSE=$(api_post "projects/allowlist-test/sync" '{"direction":"push"}')
assert_json_field "$PUSH_RESPONSE" '.ok' "true" "Push sync triggered in push-only mode"

wait_for_sync_complete "allowlist-test" 60
PUSH_RESULT=$?
assert_eq "$PUSH_RESULT" "0" "Push sync completed in push-only mode"

# Verify push-only file arrived
PUSH_CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/allowlist-test/push-only.txt 2>/dev/null || echo ''")
assert_eq "$PUSH_CONTENT" "push-only-test" "Push-only: file synced to remote"

# ---------------------------------------------------------------------------
log_section "2b. Push-only mode blocks pull direction"
# ---------------------------------------------------------------------------

# Create a file in the remote bucket (simulating remote change)
agent_exec "echo 'remote-only' > /tmp/sync-e2e-bucket/projects/allowlist-test/remote-file.txt"

# Trigger pull — agent should override to push (or skip)
api_post "projects/allowlist-test/sync" '{"direction":"pull"}' > /dev/null 2>&1

sleep 5

# The file should NOT have been pulled to the local directory
PULLED=$(agent_exec "test -f /tmp/sync-e2e-allowlist/remote-file.txt && echo 'exists' || echo 'missing'")
assert_eq "$PULLED" "missing" "Push-only mode blocked pull — remote file NOT downloaded"

# Check agent log for access mode message
AGENT_LOG=$(agent_exec "journalctl -u sync-agent --since '10 seconds ago' --no-pager 2>/dev/null || echo ''")
assert_contains "$AGENT_LOG" "push-only" "Agent logged access mode enforcement"

# ---------------------------------------------------------------------------
log_section "2c. Reset access mode to full"
# ---------------------------------------------------------------------------

agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
for entry in data['entries']:
    if entry['projectId'] == 'allowlist-test':
        entry['accessMode'] = 'full'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# ============================================================================
log_section "Part 3: Sync Preview — dry-run before execution"
# ============================================================================

# ---------------------------------------------------------------------------
log_section "3a. Enable confirm-always mode"
# ---------------------------------------------------------------------------

# Create a fresh project for preview testing
api_delete "projects/preview-test?permanent=true" > /dev/null 2>&1 || true
RESPONSE=$(api_post "projects" '{"name":"preview-test","direction":"push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Preview test project created"

# Set up local path with confirm-always mode
agent_exec "mkdir -p /tmp/sync-e2e-preview"
agent_exec "echo 'preview-content' > /tmp/sync-e2e-preview/preview-file.txt"

agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'preview-test']
data['entries'].append({
    'projectId': 'preview-test',
    'localPath': '/tmp/sync-e2e-preview',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'preview-test',
    'confirmMode': 'confirm-always'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# ---------------------------------------------------------------------------
log_section "3b. Trigger sync — should create pending preview, not sync"
# ---------------------------------------------------------------------------

api_post "projects/preview-test/sync" '{"direction":"push"}' > /dev/null 2>&1

# Wait for the agent to pick up the operation and run dry-run
sleep 10

# Check that a pending-syncs file was created
PENDING_EXISTS=$(agent_exec "test -d '${PENDING_DIR}' && ls '${PENDING_DIR}' 2>/dev/null | grep -c preview-test || echo '0'")
assert_not_eq "$PENDING_EXISTS" "0" "Pending sync preview file created"

# Verify it has status=pending
PREVIEW_STATUS=$(agent_exec "cat '${PENDING_DIR}/preview-test.json' 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[\"status\"])' 2>/dev/null || echo ''")
assert_eq "$PREVIEW_STATUS" "pending" "Pending sync has status 'pending'"

# Verify the file was NOT synced yet (preview blocks execution)
SYNCED=$(agent_exec "test -f /tmp/sync-e2e-bucket/projects/preview-test/preview-file.txt && echo 'exists' || echo 'missing'")
assert_eq "$SYNCED" "missing" "File NOT synced while preview is pending"

# ---------------------------------------------------------------------------
log_section "3c. Approve the pending sync"
# ---------------------------------------------------------------------------

# Update the pending sync status to approved
agent_exec "cat > /tmp/approve-sync.py << 'PYEOF'
import json, os
path = '${PENDING_DIR}/preview-test.json'
with open(path) as f:
    data = json.load(f)
data['status'] = 'approved'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF
python3 /tmp/approve-sync.py"

# Wait for agent to pick up the approval and execute the sync
sleep 15

# Wait for sync to complete
wait_for_sync_complete "preview-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Sync completed after preview approval"

# Verify file arrived at remote
PREVIEW_CONTENT=$(agent_exec "cat /tmp/sync-e2e-bucket/projects/preview-test/preview-file.txt 2>/dev/null || echo ''")
assert_eq "$PREVIEW_CONTENT" "preview-content" "File synced after approval"

# ============================================================================
log_section "Part 4: Server never exposes local paths"
# ============================================================================

# ---------------------------------------------------------------------------
log_section "4a. Verify project API responses have no localPath"
# ---------------------------------------------------------------------------

# Check that GET /projects does not contain localPath
PROJECTS_RESPONSE=$(api_get "projects")
HAS_LOCAL=$(echo "$PROJECTS_RESPONSE" | jq '[.projects[]] | any(has("localPath"))' 2>/dev/null || echo "true")
assert_eq "$HAS_LOCAL" "false" "GET /projects response contains no localPath"

# Check that GET /projects/:id does not contain localPath
PROJECT_DETAIL=$(api_get "projects/allowlist-test")
HAS_LOCAL_DETAIL=$(echo "$PROJECT_DETAIL" | jq '.project | has("localPath")' 2>/dev/null || echo "true")
assert_eq "$HAS_LOCAL_DETAIL" "false" "GET /projects/:id response contains no localPath"

# ---------------------------------------------------------------------------
log_section "4b. Verify agent-config has no localPath"
# ---------------------------------------------------------------------------

AGENT_CONFIG=$(api_get "agent-config")
HAS_LOCAL_CONFIG=$(echo "$AGENT_CONFIG" | jq '[.projects[]] | any(has("localPath"))' 2>/dev/null || echo "true")
assert_eq "$HAS_LOCAL_CONFIG" "false" "GET /agent-config response contains no localPath"

# ============================================================================
log_section "Cleanup"
# ============================================================================

api_delete "projects/allowlist-test?permanent=true" > /dev/null 2>&1 || true
api_delete "projects/preview-test?permanent=true" > /dev/null 2>&1 || true

# Clean up agent directories
agent_exec "rm -rf /tmp/sync-e2e-allowlist /tmp/sync-e2e-preview" 2>/dev/null || true

# Restore approved-paths.json to only the default e2e project
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
with open(path) as f:
    data = json.load(f)
data['entries'] = [e for e in data['entries'] if e['projectId'] == 'e2e-test-project']
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

end_test
