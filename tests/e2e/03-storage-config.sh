#!/usr/bin/env bash
# ============================================================================
# Test 03 — Storage Configuration
# ============================================================================
# Configures a storage provider via the server API and verifies the server
# accepts and stores the configuration. Uses a local filesystem rclone remote
# for testing (no cloud provider needed).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Storage Configuration"

# ---------------------------------------------------------------------------
log_section "Ensure bucket directory exists on host VM"
# ---------------------------------------------------------------------------

host_exec "mkdir -p /tmp/sync-e2e-bucket" > /dev/null 2>&1

# ---------------------------------------------------------------------------
log_section "Configure local storage provider"
# ---------------------------------------------------------------------------

# The storage API uses PATCH with the storageConfigSchema fields.
# For a local provider, endpoint/accessKey/secretKey are stored but not used
# by rclone — the bucket path is what matters.
STORAGE_CONFIG='{
  "provider": "local",
  "endpoint": "http://localhost",
  "bucket": "/tmp/sync-e2e-bucket",
  "accessKey": "unused",
  "secretKey": "unused"
}'

RESPONSE=$(api_patch "storage" "$STORAGE_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Storage provider configured"
assert_json_field "$RESPONSE" '.provider' "local" "Provider type is local"

# ---------------------------------------------------------------------------
log_section "Retrieve storage configuration"
# ---------------------------------------------------------------------------

STORAGE=$(api_get "storage")
assert_json_field "$STORAGE" '.configured' "true" "Storage shows as configured"
assert_json_field "$STORAGE" '.provider' "local" "Provider type matches"
assert_json_field "$STORAGE" '.bucket' "/tmp/sync-e2e-bucket" "Bucket path matches"

# Credentials must be redacted in the response
assert_not_contains "$STORAGE" "accessKey" "Credentials redacted from GET response"

# ---------------------------------------------------------------------------
log_section "Test storage connection"
# ---------------------------------------------------------------------------

CONN_RESPONSE=$(api_post "storage/test")
assert_json_field "$CONN_RESPONSE" '.ok' "true" "Storage connection test passed"

# ---------------------------------------------------------------------------
log_section "Rclone available on agent VM"
# ---------------------------------------------------------------------------

RCLONE_VERSION=$(agent_exec "rclone version 2>/dev/null | head -1 || echo 'not found'")
assert_contains "$RCLONE_VERSION" "rclone" "Rclone installed on agent VM"

# ---------------------------------------------------------------------------
log_section "Test bucket directory exists on host VM"
# ---------------------------------------------------------------------------

BUCKET_EXISTS=$(host_exec "test -d /tmp/sync-e2e-bucket && echo 'yes' || echo 'no'")
assert_eq "$BUCKET_EXISTS" "yes" "Test bucket directory exists on host VM"

# ---------------------------------------------------------------------------
log_section "Reject invalid storage configuration"
# ---------------------------------------------------------------------------

BAD_CONFIG='{"provider": "", "endpoint": "", "bucket": "", "accessKey": "", "secretKey": ""}'
BAD_STATUS=$(api_patch_status "storage" "$BAD_CONFIG")
assert_not_eq "$BAD_STATUS" "200" "Server rejects empty storage config"

# ---------------------------------------------------------------------------
log_section "Create bucket via API"
# ---------------------------------------------------------------------------

BUCKET_RESPONSE=$(api_post "storage/create-bucket" '{"bucket": "/tmp/sync-e2e-bucket-new"}')
assert_json_field "$BUCKET_RESPONSE" '.ok' "true" "Bucket creation accepted"

end_test
