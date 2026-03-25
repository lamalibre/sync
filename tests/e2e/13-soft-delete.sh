#!/usr/bin/env bash
# ============================================================================
# Test 13 — Soft Delete
# ============================================================================
# Tests soft delete for projects, project restore, sync rejection on deleted
# projects, hard delete, and trash purge endpoint.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Soft Delete"

# ---------------------------------------------------------------------------
log_section "Create test project for soft delete"
# ---------------------------------------------------------------------------

SD_PROJECT_CONFIG='{
  "name": "soft-delete-test",
  "localPath": "/tmp/sync-e2e-sd",
  "excludes": ["*.tmp", ".DS_Store"]
}'

RESPONSE=$(api_post "projects" "$SD_PROJECT_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Soft-delete test project created"

SD_PROJECT_ID=$(echo "$RESPONSE" | jq -r '.project.id')
log_info "Project ID: $SD_PROJECT_ID"

# Verify deletedAt is null on creation
assert_json_field "$RESPONSE" '.project.deletedAt' "null" "Project deletedAt is null on creation"

# ---------------------------------------------------------------------------
log_section "Soft delete the project"
# ---------------------------------------------------------------------------

DELETE_RESPONSE=$(api_delete "projects/${SD_PROJECT_ID}")
assert_json_field "$DELETE_RESPONSE" '.ok' "true" "Project soft-deleted"

# Verify it returns 404 on normal GET
GET_STATUS=$(api_get_status "projects/${SD_PROJECT_ID}")
assert_eq "$GET_STATUS" "404" "Soft-deleted project returns 404 on GET"

# ---------------------------------------------------------------------------
log_section "Verify project appears with includeDeleted=true"
# ---------------------------------------------------------------------------

ALL_PROJECTS=$(api_get "projects?includeDeleted=true")
SD_FOUND=$(echo "$ALL_PROJECTS" | jq -r ".projects[] | select(.id == \"${SD_PROJECT_ID}\") | .id")
assert_eq "$SD_FOUND" "$SD_PROJECT_ID" "Soft-deleted project visible with includeDeleted=true"

# Verify deletedAt is set
SD_DELETED_AT=$(echo "$ALL_PROJECTS" | jq -r ".projects[] | select(.id == \"${SD_PROJECT_ID}\") | .deletedAt")
assert_not_eq "$SD_DELETED_AT" "null" "deletedAt is set after soft delete"

# ---------------------------------------------------------------------------
log_section "Sync on deleted project returns 400"
# ---------------------------------------------------------------------------

SYNC_STATUS=$(api_post_status "projects/${SD_PROJECT_ID}/sync")
assert_eq "$SYNC_STATUS" "400" "Sync on soft-deleted project returns 400"

# ---------------------------------------------------------------------------
log_section "Archive on deleted project returns 400"
# ---------------------------------------------------------------------------

ARCHIVE_STATUS=$(api_post_status "projects/${SD_PROJECT_ID}/archive")
assert_eq "$ARCHIVE_STATUS" "400" "Archive on soft-deleted project returns 400"

# ---------------------------------------------------------------------------
log_section "Restore the project"
# ---------------------------------------------------------------------------

RESTORE_RESPONSE=$(api_post "projects/${SD_PROJECT_ID}/undelete")
assert_json_field "$RESTORE_RESPONSE" '.ok' "true" "Project restored"
assert_json_field "$RESTORE_RESPONSE" '.project.status' "local-only" "Restored project status is local-only"
assert_json_field "$RESTORE_RESPONSE" '.project.deletedAt' "null" "Restored project deletedAt is null"

# Verify it's accessible via normal GET again
GET_AFTER_RESTORE=$(api_get "projects/${SD_PROJECT_ID}")
assert_json_field "$GET_AFTER_RESTORE" '.project.id' "$SD_PROJECT_ID" "Project accessible after restore"

# ---------------------------------------------------------------------------
log_section "Restore a non-deleted project returns 409"
# ---------------------------------------------------------------------------

RESTORE_AGAIN_STATUS=$(api_post_status "projects/${SD_PROJECT_ID}/undelete")
assert_eq "$RESTORE_AGAIN_STATUS" "409" "Restore on active project returns 409"

# ---------------------------------------------------------------------------
log_section "Hard delete"
# ---------------------------------------------------------------------------

HARD_DELETE_RESPONSE=$(api_delete "projects/${SD_PROJECT_ID}?permanent=true")
assert_json_field "$HARD_DELETE_RESPONSE" '.ok' "true" "Project hard-deleted"

# Verify it's gone from includeDeleted=true as well
ALL_AFTER_HARD=$(api_get "projects?includeDeleted=true")
SD_GONE=$(echo "$ALL_AFTER_HARD" | jq -r ".projects[] | select(.id == \"${SD_PROJECT_ID}\") | .id // empty")
assert_eq "$SD_GONE" "" "Hard-deleted project gone from includeDeleted list"

# ---------------------------------------------------------------------------
log_section "Trash purge endpoint"
# ---------------------------------------------------------------------------

# Recreate a project to test trash purge
RESPONSE=$(api_post "projects" "$SD_PROJECT_CONFIG")
SD_PROJECT_ID2=$(echo "$RESPONSE" | jq -r '.project.id')

PURGE_RESPONSE=$(api_post "projects/${SD_PROJECT_ID2}/purge-trash" '{"olderThanDays": 1}')
assert_json_field "$PURGE_RESPONSE" '.ok' "true" "Trash purge request accepted"
assert_json_field_not_empty "$PURGE_RESPONSE" '.operationId' "Trash purge returns operation ID"

# ---------------------------------------------------------------------------
log_section "Trash list endpoint"
# ---------------------------------------------------------------------------

TRASH_RESPONSE=$(api_get "projects/${SD_PROJECT_ID2}/trash")
assert_json_field "$TRASH_RESPONSE" '.projectId' "$SD_PROJECT_ID2" "Trash list returns correct project ID"

# ---------------------------------------------------------------------------
log_section "Soft delete config in agent config"
# ---------------------------------------------------------------------------

AGENT_CONFIG=$(api_get "agent-config")
SOFT_DELETE_ENABLED=$(echo "$AGENT_CONFIG" | jq -r '.softDelete.enabled')
assert_eq "$SOFT_DELETE_ENABLED" "true" "Global softDelete.enabled defaults to true"

RETENTION=$(echo "$AGENT_CONFIG" | jq -r '.softDelete.retentionDays')
assert_eq "$RETENTION" "90" "Global softDelete.retentionDays defaults to 90"

# Check per-project softDelete in agent config
PROJ_SD=$(echo "$AGENT_CONFIG" | jq -r ".projects[] | select(.id == \"${SD_PROJECT_ID2}\") | .softDelete.enabled")
assert_eq "$PROJ_SD" "true" "Per-project softDelete.enabled defaults to true"

# ---------------------------------------------------------------------------
log_section "Trash restore endpoint"
# ---------------------------------------------------------------------------

TRASH_RESTORE_RESPONSE=$(api_post "projects/${SD_PROJECT_ID2}/restore-trash" '{}')
assert_json_field "$TRASH_RESTORE_RESPONSE" '.ok' "true" "Trash restore request accepted"
assert_json_field_not_empty "$TRASH_RESTORE_RESPONSE" '.operationId' "Trash restore returns operation ID"

# Wait for agent to process (may complete as error since there's no actual trash)
sleep 10

# Duplicate call — may succeed (200) or conflict (409) depending on timing
TRASH_RESTORE_DUP_STATUS=$(api_post_status "projects/${SD_PROJECT_ID2}/restore-trash" '{}')
if [ "$TRASH_RESTORE_DUP_STATUS" = "200" ] || [ "$TRASH_RESTORE_DUP_STATUS" = "409" ]; then
  log_pass "Duplicate trash-restore returns acceptable status ($TRASH_RESTORE_DUP_STATUS)"
else
  log_fail "Duplicate trash-restore returned unexpected status: $TRASH_RESTORE_DUP_STATUS (expected 200 or 409)"
fi

# Trash restore on nonexistent project returns 404
TRASH_RESTORE_404_STATUS=$(api_post_status "projects/nonexistent-id-12345/restore-trash" '{}')
assert_eq "$TRASH_RESTORE_404_STATUS" "404" "Trash restore on nonexistent project returns 404"

# Wait for any pending operations to clear before timestamp test
sleep 10

# Trash restore with timestamp parameter
TRASH_RESTORE_TS_STATUS=$(api_post_status "projects/${SD_PROJECT_ID2}/restore-trash" '{"timestamp": "2026-03-25T00-00-00-000Z"}')
if [ "$TRASH_RESTORE_TS_STATUS" = "200" ]; then
  log_pass "Trash restore with timestamp accepted"
elif [ "$TRASH_RESTORE_TS_STATUS" = "409" ]; then
  log_pass "Trash restore with timestamp returned 409 (operation still active)"
else
  log_fail "Trash restore with timestamp returned unexpected status: $TRASH_RESTORE_TS_STATUS"
fi

# ---------------------------------------------------------------------------
log_section "Cron expression validation"
# ---------------------------------------------------------------------------

# Invalid cron expression in schedule should be rejected
INVALID_CRON_PROJECT='{
  "name": "bad-cron-test",
  "localPath": "/tmp/sync-e2e-bad-cron",
  "schedule": "not-a-cron",
  "trigger": "schedule"
}'
CRON_STATUS=$(api_post_status "projects" "$INVALID_CRON_PROJECT")
assert_eq "$CRON_STATUS" "400" "Invalid cron expression in schedule rejected"

# 6-field (seconds) cron expression should be rejected
SECONDS_CRON_PROJECT='{
  "name": "seconds-cron-test",
  "localPath": "/tmp/sync-e2e-sec-cron",
  "schedule": "*/5 * * * * *",
  "trigger": "schedule"
}'
SECONDS_STATUS=$(api_post_status "projects" "$SECONDS_CRON_PROJECT")
assert_eq "$SECONDS_STATUS" "400" "6-field (seconds) cron expression rejected"

# Valid cron expression should be accepted
VALID_CRON_PROJECT='{
  "name": "valid-cron-test",
  "localPath": "/tmp/sync-e2e-valid-cron",
  "schedule": "0 */6 * * *",
  "trigger": "schedule"
}'
VALID_CRON_RESPONSE=$(api_post "projects" "$VALID_CRON_PROJECT")
assert_json_field "$VALID_CRON_RESPONSE" '.ok' "true" "Valid cron expression accepted"
VALID_CRON_ID=$(echo "$VALID_CRON_RESPONSE" | jq -r '.project.id')

# Cleanup cron test project
api_delete "projects/${VALID_CRON_ID}?permanent=true" > /dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log_section "Encryption password minimum length"
# ---------------------------------------------------------------------------

SHORT_PW_PROJECT='{
  "name": "short-pw-test",
  "localPath": "/tmp/sync-e2e-short-pw",
  "encrypted": true,
  "encryptionPassword": "short"
}'
SHORT_PW_STATUS=$(api_post_status "projects" "$SHORT_PW_PROJECT")
assert_eq "$SHORT_PW_STATUS" "400" "Encryption password shorter than 12 chars rejected"

# ---------------------------------------------------------------------------
log_section "Delete during active operation returns 409"
# ---------------------------------------------------------------------------

# Create a project, trigger a sync (which creates an active operation),
# then immediately try to delete — should get 409
ACTIVE_OP_PROJECT='{
  "name": "active-op-delete-test",
  "localPath": "/tmp/sync-e2e-active-op",
  "direction": "push"
}'
ACTIVE_OP_RESPONSE=$(api_post "projects" "$ACTIVE_OP_PROJECT")
ACTIVE_OP_ID=$(echo "$ACTIVE_OP_RESPONSE" | jq -r '.project.id')

# Create the directory on agent so sync has something to work with
agent_exec "mkdir -p /tmp/sync-e2e-active-op && echo test > /tmp/sync-e2e-active-op/file.txt" > /dev/null 2>&1 || true

# Trigger sync
api_post "projects/${ACTIVE_OP_ID}/sync" > /dev/null 2>&1 || true

# Immediately try to delete while operation may be active
DELETE_ACTIVE_STATUS=$(api_delete_status "projects/${ACTIVE_OP_ID}")
if [ "$DELETE_ACTIVE_STATUS" = "409" ]; then
  log_pass "Delete during active operation returns 409"
else
  # Operation may have completed already — 200 is acceptable in that case
  log_info "Delete returned $DELETE_ACTIVE_STATUS (operation may have already completed)"
  if [ "$DELETE_ACTIVE_STATUS" = "200" ]; then
    log_pass "Delete returned 200 (operation already completed)"
  else
    log_fail "Delete during active operation returned unexpected status: $DELETE_ACTIVE_STATUS"
  fi
fi

# Cleanup
api_delete "projects/${ACTIVE_OP_ID}?permanent=true" > /dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log_section "Cleanup — hard delete test project"
# ---------------------------------------------------------------------------

api_delete "projects/${SD_PROJECT_ID2}?permanent=true" > /dev/null 2>&1 || true

end_test
