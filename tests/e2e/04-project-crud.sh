#!/usr/bin/env bash
# ============================================================================
# Test 04 — Project CRUD
# ============================================================================
# Tests create, read, update, and delete operations on projects via the
# server API. Validates input sanitisation and path security constraints.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Project CRUD"

# ---------------------------------------------------------------------------
log_section "Create a project"
# ---------------------------------------------------------------------------

PROJECT_CONFIG='{
  "name": "e2e-test-project",
  "localPath": "/tmp/sync-e2e-project",
  "remotePath": "test-remote:/tmp/sync-e2e-bucket/e2e-test-project",
  "syncDirection": "push",
  "excludes": ["*.tmp", ".DS_Store"]
}'

RESPONSE=$(api_post "projects" "$PROJECT_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Project created"
assert_json_field_not_empty "$RESPONSE" '.project.id' "Project has an ID"

PROJECT_ID=$(echo "$RESPONSE" | jq -r '.project.id')
log_info "Project ID: $PROJECT_ID"

# ---------------------------------------------------------------------------
log_section "Read the project"
# ---------------------------------------------------------------------------

PROJECT=$(api_get "projects/${PROJECT_ID}")
assert_json_field "$PROJECT" '.project.name' "e2e-test-project" "Project name matches"
assert_json_field "$PROJECT" '.project.localPath' "/tmp/sync-e2e-project" "Local path matches"
assert_json_field "$PROJECT" '.project.syncDirection' "push" "Sync direction matches"

# ---------------------------------------------------------------------------
log_section "List all projects"
# ---------------------------------------------------------------------------

PROJECTS=$(api_get "projects")
PROJ_COUNT=$(echo "$PROJECTS" | jq -r '.projects | length' 2>/dev/null || echo "0")
assert_not_eq "$PROJ_COUNT" "0" "At least one project exists"

# ---------------------------------------------------------------------------
log_section "Update the project"
# ---------------------------------------------------------------------------

UPDATE_CONFIG='{"syncDirection": "bidirectional"}'
UPDATED=$(api_patch "projects/${PROJECT_ID}" "$UPDATE_CONFIG")
assert_json_field "$UPDATED" '.ok' "true" "Project updated"

# Verify the update
PROJECT_AFTER=$(api_get "projects/${PROJECT_ID}")
assert_json_field "$PROJECT_AFTER" '.project.syncDirection' "bidirectional" "Sync direction updated"

# ---------------------------------------------------------------------------
log_section "Path security — reject traversal attacks"
# ---------------------------------------------------------------------------

TRAVERSAL_CONFIG='{
  "name": "bad-project",
  "localPath": "/tmp/../../../etc/passwd",
  "remotePath": "test-remote:/tmp/bucket",
  "syncDirection": "push"
}'
TRAVERSAL_STATUS=$(api_post_status "projects" "$TRAVERSAL_CONFIG")
assert_not_eq "$TRAVERSAL_STATUS" "200" "Server rejects path traversal"

# ---------------------------------------------------------------------------
log_section "Path security — reject null bytes"
# ---------------------------------------------------------------------------

NULLBYTE_CONFIG='{"name":"bad","localPath":"/tmp/sync\u0000evil","remotePath":"r:/b","syncDirection":"push"}'
NULLBYTE_STATUS=$(api_post_status "projects" "$NULLBYTE_CONFIG")
assert_not_eq "$NULLBYTE_STATUS" "200" "Server rejects null bytes in path"

# ---------------------------------------------------------------------------
log_section "Delete the project"
# ---------------------------------------------------------------------------

DELETE_RESPONSE=$(api_delete "projects/${PROJECT_ID}")
assert_json_field "$DELETE_RESPONSE" '.ok' "true" "Project deleted"

# Verify deletion
DELETED_STATUS=$(api_get_status "projects/${PROJECT_ID}")
assert_eq "$DELETED_STATUS" "404" "Deleted project returns 404"

# ---------------------------------------------------------------------------
log_section "Recreate project for subsequent tests"
# ---------------------------------------------------------------------------

# Subsequent tests (05+) depend on a project existing
RESPONSE=$(api_post "projects" "$PROJECT_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Project recreated for subsequent tests"

end_test
