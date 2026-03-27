#!/usr/bin/env bash
# ============================================================================
# Test 17 — Include Patterns
# ============================================================================
# Tests that when a project has include patterns set, only files matching those
# patterns are synced to the remote bucket. Non-matching files are excluded.
#
# Also verifies that bandwidth limit configuration is accepted by the API and
# appears in the agent config (functional bandwidth testing is not feasible in
# e2e since transfer speeds on local filesystem are not meaningful).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Include Patterns"

AGENT_HOME="/root/.sync-agent"
APPROVED_PATHS="${AGENT_HOME}/approved-paths.json"
PROJECT_DIR="/tmp/sync-e2e-includes"
BUCKET_DIR="/tmp/sync-e2e-bucket/projects/include-test"

# ---------------------------------------------------------------------------
log_section "Create project with include patterns and bandwidth limit"
# ---------------------------------------------------------------------------

api_delete "projects/include-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{
  "name": "include-test",
  "direction": "push",
  "includes": ["*.md", "*.txt", "docs/**"],
  "bandwidthLimit": "10M"
}')
assert_json_field "$RESPONSE" '.ok' "true" "Include-test project created"

# Verify bandwidth limit was accepted
PROJECT=$(api_get "projects/include-test")
BW=$(echo "$PROJECT" | jq -r '.project.bandwidthLimit // empty' 2>/dev/null || echo "")
assert_eq "$BW" "10M" "Bandwidth limit stored in project config"

# ---------------------------------------------------------------------------
log_section "Verify bandwidth limit appears in agent config"
# ---------------------------------------------------------------------------

# Wait for agent to pick up config
sleep 5

AGENT_CONFIG=$(api_get "agent-config")
PROJ_BW=$(echo "$AGENT_CONFIG" | jq -r '.projects[] | select(.id == "include-test") | .bandwidthLimit // empty' 2>/dev/null || echo "")
assert_eq "$PROJ_BW" "10M" "Bandwidth limit propagated to agent config"

# ---------------------------------------------------------------------------
log_section "Add approved path mapping"
# ---------------------------------------------------------------------------

agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 1, 'entries': []}
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'include-test']
data['entries'].append({
    'projectId': 'include-test',
    'localPath': '${PROJECT_DIR}',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'include-test'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# ---------------------------------------------------------------------------
log_section "Create files — some matching includes, some not"
# ---------------------------------------------------------------------------

agent_exec "mkdir -p '${PROJECT_DIR}/docs/api'"

# Files that SHOULD sync (match *.md, *.txt, docs/**)
agent_exec "echo 'readme-content' > '${PROJECT_DIR}/README.md'"
agent_exec "echo 'notes-content' > '${PROJECT_DIR}/notes.txt'"
agent_exec "echo 'api-doc' > '${PROJECT_DIR}/docs/api/endpoints.md'"
agent_exec "echo 'guide-content' > '${PROJECT_DIR}/docs/guide.txt'"

# Files that should NOT sync (no matching include pattern)
agent_exec "echo 'image-data' > '${PROJECT_DIR}/logo.png'"
agent_exec "echo 'script-code' > '${PROJECT_DIR}/app.js'"
agent_exec "echo 'stylesheet' > '${PROJECT_DIR}/style.css'"
agent_exec "mkdir -p '${PROJECT_DIR}/src'"
agent_exec "echo 'source-code' > '${PROJECT_DIR}/src/index.ts'"

# ---------------------------------------------------------------------------
log_section "Trigger push sync"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/include-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Push sync triggered"

wait_for_sync_complete "include-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Sync completed"

# ---------------------------------------------------------------------------
log_section "Verify included files DID sync"
# ---------------------------------------------------------------------------

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/README.md' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "readme-content" "README.md synced (matches *.md)"

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/notes.txt' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "notes-content" "notes.txt synced (matches *.txt)"

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/docs/api/endpoints.md' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "api-doc" "docs/api/endpoints.md synced (matches docs/**)"

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/docs/guide.txt' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "guide-content" "docs/guide.txt synced (matches docs/**)"

# ---------------------------------------------------------------------------
log_section "Verify non-included files did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/logo.png' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "logo.png excluded (no matching include)"

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/app.js' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "app.js excluded (no matching include)"

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/style.css' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "style.css excluded (no matching include)"

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/src/index.ts' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "src/index.ts excluded (no matching include)"

# ---------------------------------------------------------------------------
log_section "Verify bandwidth limit validation"
# ---------------------------------------------------------------------------

# Invalid bandwidth limit format should be rejected
BAD_BW_STATUS=$(api_patch_status "projects/include-test" '{"bandwidthLimit": "fast"}')
assert_not_eq "$BAD_BW_STATUS" "200" "Invalid bandwidth format rejected"

# Valid bandwidth limit formats accepted
GOOD_BW=$(api_patch "projects/include-test" '{"bandwidthLimit": "500k"}')
assert_json_field "$GOOD_BW" '.ok' "true" "Bandwidth limit 500k accepted"

# ---------------------------------------------------------------------------
log_section "Cleanup"
# ---------------------------------------------------------------------------

api_delete "projects/include-test?permanent=true" > /dev/null 2>&1 || true
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
