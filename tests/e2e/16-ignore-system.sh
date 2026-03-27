#!/usr/bin/env bash
# ============================================================================
# Test 16 — Ignore System
# ============================================================================
# Tests the 5-layer ignore pattern resolution:
#
# 1. Built-in defaults (node_modules, .git, .DS_Store, etc.)
# 2. .gitignore (root + nested, scoped to directory)
# 3. .dockerignore (root only)
# 4. .syncignore (custom per-project)
# 5. API excludes (project.excludes from server)
#
# Verifies that files matching any layer are NOT synced to the remote bucket,
# while unmatched files sync normally.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Ignore System"

AGENT_HOME="/root/.sync-agent"
APPROVED_PATHS="${AGENT_HOME}/approved-paths.json"
PROJECT_DIR="/tmp/sync-e2e-ignore"
BUCKET_DIR="/tmp/sync-e2e-bucket/projects/ignore-test"

# ---------------------------------------------------------------------------
log_section "Setup: create project with API excludes"
# ---------------------------------------------------------------------------

api_delete "projects/ignore-test?permanent=true" > /dev/null 2>&1 || true

RESPONSE=$(api_post "projects" '{
  "name": "ignore-test",
  "direction": "push",
  "excludes": ["*.tmp", "vendor/**"]
}')
assert_json_field "$RESPONSE" '.ok' "true" "Ignore test project created"

# Add approved path mapping
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os
path = '${APPROVED_PATHS}'
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 1, 'entries': []}
data['entries'] = [e for e in data['entries'] if e['projectId'] != 'ignore-test']
data['entries'].append({
    'projectId': 'ignore-test',
    'localPath': '${PROJECT_DIR}',
    'approvedAt': '2026-01-01T00:00:00.000Z',
    'projectName': 'ignore-test'
})
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
python3 /tmp/approved-update.py"

# ---------------------------------------------------------------------------
log_section "Create project directory tree with files for each ignore layer"
# ---------------------------------------------------------------------------

agent_exec "mkdir -p '${PROJECT_DIR}'"

# Normal files that SHOULD sync
agent_exec "echo 'should-sync' > '${PROJECT_DIR}/readme.txt'"
agent_exec "mkdir -p '${PROJECT_DIR}/src'"
agent_exec "echo 'source-code' > '${PROJECT_DIR}/src/main.js'"

# Layer 1: Built-in defaults — should NOT sync
agent_exec "mkdir -p '${PROJECT_DIR}/node_modules/pkg'"
agent_exec "echo 'npm-package' > '${PROJECT_DIR}/node_modules/pkg/index.js'"
agent_exec "echo 'ds-store' > '${PROJECT_DIR}/.DS_Store'"
agent_exec "mkdir -p '${PROJECT_DIR}/.git'"
agent_exec "echo 'git-config' > '${PROJECT_DIR}/.git/config'"
agent_exec "mkdir -p '${PROJECT_DIR}/__pycache__'"
agent_exec "echo 'pyc-cache' > '${PROJECT_DIR}/__pycache__/mod.pyc'"

# Layer 2: .gitignore — should NOT sync
agent_exec "printf '*.log\nbuild/\n' > '${PROJECT_DIR}/.gitignore'"
agent_exec "echo 'app-log' > '${PROJECT_DIR}/app.log'"
agent_exec "mkdir -p '${PROJECT_DIR}/build'"
agent_exec "echo 'build-output' > '${PROJECT_DIR}/build/output.js'"

# Layer 3: .dockerignore — should NOT sync
agent_exec "printf 'docker-temp/\n' > '${PROJECT_DIR}/.dockerignore'"
agent_exec "mkdir -p '${PROJECT_DIR}/docker-temp'"
agent_exec "echo 'docker-artifact' > '${PROJECT_DIR}/docker-temp/layer.tar'"

# Layer 4: .syncignore — should NOT sync
agent_exec "printf 'secrets/\n*.key\n' > '${PROJECT_DIR}/.syncignore'"
agent_exec "mkdir -p '${PROJECT_DIR}/secrets'"
agent_exec "echo 'api-key' > '${PROJECT_DIR}/secrets/api.env'"
agent_exec "echo 'private-key' > '${PROJECT_DIR}/deploy.key'"

# Layer 5: API excludes (*.tmp, vendor/**) — should NOT sync
agent_exec "echo 'temp-data' > '${PROJECT_DIR}/cache.tmp'"
agent_exec "mkdir -p '${PROJECT_DIR}/vendor/lib'"
agent_exec "echo 'vendor-lib' > '${PROJECT_DIR}/vendor/lib/dep.js'"

# ---------------------------------------------------------------------------
log_section "Trigger push sync"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/ignore-test/sync" '{"direction":"push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Push sync triggered"

wait_for_sync_complete "ignore-test" 60
RESULT=$?
assert_eq "$RESULT" "0" "Sync completed"

# ---------------------------------------------------------------------------
log_section "Verify normal files DID sync"
# ---------------------------------------------------------------------------

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/readme.txt' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "should-sync" "readme.txt synced to remote"

CONTENT=$(agent_exec "cat '${BUCKET_DIR}/src/main.js' 2>/dev/null || echo ''")
assert_eq "$CONTENT" "source-code" "src/main.js synced to remote"

# ---------------------------------------------------------------------------
log_section "Verify built-in excludes did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/node_modules' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "node_modules/ excluded (built-in)"

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/.DS_Store' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" ".DS_Store excluded (built-in)"

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/.git' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" ".git/ excluded (built-in)"

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/__pycache__' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "__pycache__/ excluded (built-in)"

# ---------------------------------------------------------------------------
log_section "Verify .gitignore patterns did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/app.log' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "*.log excluded (.gitignore)"

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/build' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "build/ excluded (.gitignore)"

# ---------------------------------------------------------------------------
log_section "Verify .dockerignore patterns did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/docker-temp' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "docker-temp/ excluded (.dockerignore)"

# ---------------------------------------------------------------------------
log_section "Verify .syncignore patterns did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/secrets' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "secrets/ excluded (.syncignore)"

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/deploy.key' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "*.key excluded (.syncignore)"

# ---------------------------------------------------------------------------
log_section "Verify API excludes did NOT sync"
# ---------------------------------------------------------------------------

FOUND=$(agent_exec "test -f '${BUCKET_DIR}/cache.tmp' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "*.tmp excluded (API excludes)"

FOUND=$(agent_exec "test -d '${BUCKET_DIR}/vendor' && echo 'found' || echo 'absent'")
assert_eq "$FOUND" "absent" "vendor/ excluded (API excludes)"

# ---------------------------------------------------------------------------
log_section "Verify ignore files themselves are handled correctly"
# ---------------------------------------------------------------------------

# .gitignore, .dockerignore, .syncignore may or may not sync depending on
# built-in rules. The important thing is that they don't cause errors.
# Just verify the sync completed without error (already checked above).
log_pass "Ignore files did not cause sync errors"

# ---------------------------------------------------------------------------
log_section "Cleanup"
# ---------------------------------------------------------------------------

api_delete "projects/ignore-test?permanent=true" > /dev/null 2>&1 || true
agent_exec "rm -rf '${PROJECT_DIR}'" 2>/dev/null || true
agent_exec "rm -rf '${BUCKET_DIR}'" 2>/dev/null || true

# Restore approved-paths.json to only the default e2e project
agent_exec "cat > /tmp/approved-update.py << 'PYEOF'
import json, os, sys
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
