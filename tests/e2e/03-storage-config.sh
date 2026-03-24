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
log_section "Configure local storage provider"
# ---------------------------------------------------------------------------

STORAGE_CONFIG='{
  "provider": "local",
  "name": "e2e-test-storage",
  "config": {
    "type": "local",
    "basePath": "/tmp/sync-e2e-bucket"
  }
}'

RESPONSE=$(api_post "storage" "$STORAGE_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Storage provider configured"

# ---------------------------------------------------------------------------
log_section "Retrieve storage configuration"
# ---------------------------------------------------------------------------

STORAGE=$(api_get "storage")
assert_json_field_not_empty "$STORAGE" '.providers' "Storage providers list exists"

PROVIDER_COUNT=$(echo "$STORAGE" | jq -r '.providers | length' 2>/dev/null || echo "0")
assert_not_eq "$PROVIDER_COUNT" "0" "At least one storage provider configured"

assert_json_field "$STORAGE" '.providers[0].name' "e2e-test-storage" "Provider name matches"

# ---------------------------------------------------------------------------
log_section "Test storage connection"
# ---------------------------------------------------------------------------

CONN_RESPONSE=$(api_post "storage/test-connection" "$STORAGE_CONFIG")
assert_json_field "$CONN_RESPONSE" '.ok' "true" "Storage connection test passed"

# ---------------------------------------------------------------------------
log_section "Rclone available on agent VM"
# ---------------------------------------------------------------------------

RCLONE_VERSION=$(agent_exec "rclone version 2>/dev/null | head -1 || echo 'not found'")
assert_contains "$RCLONE_VERSION" "rclone" "Rclone installed on agent VM"

# ---------------------------------------------------------------------------
log_section "Test bucket directory exists on agent"
# ---------------------------------------------------------------------------

BUCKET_EXISTS=$(agent_exec "test -d /tmp/sync-e2e-bucket && echo 'yes' || echo 'no'")
assert_eq "$BUCKET_EXISTS" "yes" "Test bucket directory exists on agent VM"

# ---------------------------------------------------------------------------
log_section "Reject invalid storage configuration"
# ---------------------------------------------------------------------------

BAD_CONFIG='{"provider": "","name": ""}'
BAD_STATUS=$(api_post_status "storage" "$BAD_CONFIG")
assert_not_eq "$BAD_STATUS" "200" "Server rejects empty storage config"

end_test
