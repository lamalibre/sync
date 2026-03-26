#!/usr/bin/env bash
# ============================================================================
# Test 10 — Encryption
# ============================================================================
# Tests encrypted sync via rclone crypt overlay. Verifies that files stored
# in the remote bucket are encrypted and that they can be decrypted on pull.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Encryption"

# ---------------------------------------------------------------------------
log_section "Create an encrypted project"
# ---------------------------------------------------------------------------

ENCRYPT_CONFIG='{
  "name": "e2e-encrypted-project",
  "direction": "push",
  "encrypted": true,
  "encryptionPassword": "e2e-test-password-123456"
}'

RESPONSE=$(api_post "projects" "$ENCRYPT_CONFIG")
assert_json_field "$RESPONSE" '.ok' "true" "Encrypted project created"

ENCRYPTED_PROJECT_ID=$(echo "$RESPONSE" | jq -r '.project.id')
log_info "Encrypted project ID: $ENCRYPTED_PROJECT_ID"

# Write the local path mapping to approved-paths.json on the agent VM
agent_exec "cat > /root/.sync-agent/approved-paths.json << 'APEOF'
{
  \"version\": 1,
  \"entries\": [
    {
      \"projectId\": \"e2e-test-project\",
      \"localPath\": \"/tmp/sync-e2e-project\",
      \"approvedAt\": \"2026-01-01T00:00:00.000Z\",
      \"projectName\": \"e2e-test-project\"
    },
    {
      \"projectId\": \"e2e-encrypted-project\",
      \"localPath\": \"/tmp/sync-e2e-project-encrypted\",
      \"approvedAt\": \"2026-01-01T00:00:00.000Z\",
      \"projectName\": \"e2e-encrypted-project\"
    }
  ]
}
APEOF
chmod 0600 /root/.sync-agent/approved-paths.json"

# ---------------------------------------------------------------------------
log_section "Create test files on agent"
# ---------------------------------------------------------------------------

agent_exec "mkdir -p /tmp/sync-e2e-project-encrypted"
agent_exec "echo 'Secret data' > /tmp/sync-e2e-project-encrypted/secret.txt"
agent_exec "echo 'Confidential report' > /tmp/sync-e2e-project-encrypted/report.txt"

assert_file_on_agent "/tmp/sync-e2e-project-encrypted/secret.txt" "Secret file created"

# ---------------------------------------------------------------------------
log_section "Trigger encrypted push sync"
# ---------------------------------------------------------------------------

SYNC_RESPONSE=$(api_post "projects/${ENCRYPTED_PROJECT_ID}/sync" '{"direction": "push"}')
assert_json_field "$SYNC_RESPONSE" '.ok' "true" "Encrypted push triggered"

wait_for_sync_complete "$ENCRYPTED_PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Encrypted push completed"

# ---------------------------------------------------------------------------
log_section "Verify remote files are encrypted (not readable as plaintext)"
# ---------------------------------------------------------------------------

# The encrypted bucket should contain files but NOT readable as plaintext.
# With rclone crypt, filenames and directory paths are encrypted.
# The encrypted files will NOT be under a recognizable path — they'll have random-looking names.
# Check that new files appeared in the bucket that aren't under the plaintext project dirs.
ENCRYPTED_DIRS=$(agent_exec "ls /tmp/sync-e2e-bucket/ 2>/dev/null | grep -v projects || echo ''")
assert_not_eq "$ENCRYPTED_DIRS" "" "Encrypted remote has files (encrypted path names)"

# The plaintext filename should NOT exist anywhere in the bucket
PLAINTEXT_CHECK=$(agent_exec "find /tmp/sync-e2e-bucket -name 'secret.txt' 2>/dev/null | head -1 || echo ''")
assert_eq "$PLAINTEXT_CHECK" "" "Original filename not present in remote (encrypted)"

# ---------------------------------------------------------------------------
log_section "Delete local files and pull (decrypt)"
# ---------------------------------------------------------------------------

agent_exec "rm -f /tmp/sync-e2e-project-encrypted/secret.txt /tmp/sync-e2e-project-encrypted/report.txt"

PULL_RESPONSE=$(api_post "projects/${ENCRYPTED_PROJECT_ID}/sync" '{"direction": "pull"}')
assert_json_field "$PULL_RESPONSE" '.ok' "true" "Encrypted pull triggered"

wait_for_sync_complete "$ENCRYPTED_PROJECT_ID" 60
RESULT=$?
assert_eq "$RESULT" "0" "Encrypted pull completed"

# ---------------------------------------------------------------------------
log_section "Verify decrypted content matches original"
# ---------------------------------------------------------------------------

DECRYPTED=$(agent_exec "cat /tmp/sync-e2e-project-encrypted/secret.txt 2>/dev/null || echo ''")
assert_eq "$DECRYPTED" "Secret data" "Decrypted file matches original"

# ---------------------------------------------------------------------------
log_section "Cleanup encrypted project"
# ---------------------------------------------------------------------------

api_delete "projects/${ENCRYPTED_PROJECT_ID}" > /dev/null
log_info "Encrypted project cleaned up"

end_test
