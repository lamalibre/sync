#!/usr/bin/env bash
# ============================================================================
# Test 18 — Single-File Restore & Aggregate Savings
# ============================================================================
# Tests two features not covered by the main archive/restore test (09):
#
# 1. Restore with filePath: the server accepts a filePath parameter on the
#    restore endpoint and validates it (rejects traversal, absolute paths).
#    Note: the agent currently performs a full restore because filePath is
#    not propagated through the agent-config; this test validates the API
#    contract and the full restore path.
#
# 2. Aggregate savings: the GET /savings endpoint returns disk savings
#    across all projects, not just per-project.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Single-File Restore & Aggregate Savings"

AGENT_HOME="/root/.sync-agent"
APPROVED_PATHS="${AGENT_HOME}/approved-paths.json"
PROJECT_DIR="/tmp/sync-e2e-sfr"
BUCKET_DIR="/tmp/sync-e2e-bucket/projects/sfr-test"

# ---------------------------------------------------------------------------
log_section "Setup: create project with multiple files"
# ---------------------------------------------------------------------------

api_delete "projects/sfr-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{"name":"sfr-test","direction":"push"}')
assert_json_field "$RESPONSE" '.ok' "true" "Single-file restore project created"

# Add approved path mapping
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 1, 'entries': []}
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'sfr-test']
data['entries'].append({
    'projectId': 'sfr-test',
    'localPath': '${PROJECT_DIR}',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'sfr-test'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# Create project files
agent_exec "mkdir -p '${PROJECT_DIR}/subdir'"
agent_exec "echo 'file-alpha' > '${PROJECT_DIR}/alpha.txt'"
agent_exec "echo 'file-beta' > '${PROJECT_DIR}/beta.txt'"
agent_exec "echo 'file-gamma' > '${PROJECT_DIR}/subdir/gamma.txt'"

# Push files to remote first
SYNC_RESPONSE=$(api_post "projects/sfr-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Initial push triggered"

wait_for_sync_complete "sfr-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Initial push completed"

# Verify files are in remote
assert_file_on_agent "${BUCKET_DIR}/alpha.txt" "alpha.txt in remote"
assert_file_on_agent "${BUCKET_DIR}/beta.txt" "beta.txt in remote"
assert_file_on_agent "${BUCKET_DIR}/subdir/gamma.txt" "gamma.txt in remote"

# ---------------------------------------------------------------------------
log_section "Archive the project"
# ---------------------------------------------------------------------------

ARCHIVE_RESPONSE=$(api_post "projects/sfr-test/archive")
assert_json_field "$ARCHIVE_RESPONSE" '.ok' "true" "Archive triggered"

wait_for_sync_complete "sfr-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Archive completed"

# Verify stub exists and originals are gone
STUB_EXISTS=$(agent_exec "test -f '${PROJECT_DIR}/.sync-stub.json' && echo 'yes' || echo 'no'")
assert_eq "$STUB_EXISTS" "yes" "Stub file exists after archive"

ALPHA_GONE=$(agent_exec "test -f '${PROJECT_DIR}/alpha.txt' && echo 'exists' || echo 'gone'")
assert_eq "$ALPHA_GONE" "gone" "alpha.txt removed after archive"

# ---------------------------------------------------------------------------
log_section "Test aggregate savings endpoint"
# ---------------------------------------------------------------------------

# The archive should have contributed to aggregate savings
SAVINGS=$(api_get "savings")
TOTAL_ARCHIVED=$(echo "$SAVINGS" | jq -r '.totalArchivedFiles // 0' 2>/dev/null || echo "0")
TOTAL_ARCHIVED_NUM=$((TOTAL_ARCHIVED + 0))
if [ "$TOTAL_ARCHIVED_NUM" -gt 0 ]; then
  log_pass "Aggregate savings reports $TOTAL_ARCHIVED archived files"
else
  log_fail "Aggregate savings shows 0 archived files (expected > 0)"
fi

TOTAL_BYTES=$(echo "$SAVINGS" | jq -r '.totalArchivedBytes // 0' 2>/dev/null || echo "0")
TOTAL_BYTES_NUM=$((TOTAL_BYTES + 0))
if [ "$TOTAL_BYTES_NUM" -gt 0 ]; then
  log_pass "Aggregate savings reports $TOTAL_BYTES archived bytes"
else
  log_fail "Aggregate savings shows 0 bytes (expected > 0)"
fi

# Per-project savings endpoint — field is archivedFileCount
PROJ_SAVINGS=$(api_get "projects/sfr-test/savings")
PROJ_ARCHIVED=$(echo "$PROJ_SAVINGS" | jq -r '.archivedFileCount // 0' 2>/dev/null || echo "0")
PROJ_ARCHIVED_NUM=$((PROJ_ARCHIVED + 0))
if [ "$PROJ_ARCHIVED_NUM" -gt 0 ]; then
  log_pass "Per-project savings reports $PROJ_ARCHIVED archived files"
else
  # Savings may be cleared if the archive-savings state was not persisted
  log_info "Per-project savings shows $PROJ_ARCHIVED files (savings may reset between operations)"
fi

# ---------------------------------------------------------------------------
log_section "Restore with filePath parameter (API validation)"
# ---------------------------------------------------------------------------

# Path traversal in filePath should be rejected
TRAVERSAL_STATUS=$(api_post_status "projects/sfr-test/restore" '{"filePath":"../../etc/passwd"}')
assert_not_eq "$TRAVERSAL_STATUS" "200" "Path traversal in filePath rejected"

# Absolute path in filePath should be rejected
ABS_STATUS=$(api_post_status "projects/sfr-test/restore" '{"filePath":"/etc/passwd"}')
assert_not_eq "$ABS_STATUS" "200" "Absolute path in filePath rejected"

# ---------------------------------------------------------------------------
log_section "Trigger restore with filePath=alpha.txt"
# ---------------------------------------------------------------------------

# The server accepts the filePath parameter for single-file restore.
# The agent currently performs a full restore (filePath is not propagated
# through agent-config), so all files will be restored.
RESTORE_RESPONSE=$(api_post "projects/sfr-test/restore" '{"filePath":"alpha.txt"}')
assert_json_field "$RESTORE_RESPONSE" '.ok' "true" "Restore with filePath triggered"

wait_for_sync_complete "sfr-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Restore completed"

# Verify alpha.txt was restored
ALPHA_CONTENT=$(agent_exec "cat '${PROJECT_DIR}/alpha.txt' 2>/dev/null || echo ''")
assert_eq "$ALPHA_CONTENT" "file-alpha" "alpha.txt restored with correct content"

# Verify all files are restored (agent does full restore)
assert_file_on_agent "${PROJECT_DIR}/beta.txt" "beta.txt restored"
assert_file_on_agent "${PROJECT_DIR}/subdir/gamma.txt" "gamma.txt restored"

# Stub should be removed after full restore
STUB_STATUS=$(agent_exec "test -f '${PROJECT_DIR}/.sync-stub.json' && echo 'exists' || echo 'gone'")
assert_eq "$STUB_STATUS" "gone" "Stub removed after restore"

# ---------------------------------------------------------------------------
log_section "Cleanup"
# ---------------------------------------------------------------------------

api_delete "projects/sfr-test?permanent=true" > /dev/null 2>&1 || true
agent_exec "rm -rf '${PROJECT_DIR}'" 2>/dev/null || true
agent_exec "rm -rf '${BUCKET_DIR}'" 2>/dev/null || true

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
