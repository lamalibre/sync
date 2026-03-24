#!/usr/bin/env bash
# ============================================================================
# Test 12 — Plugin Mode
# ============================================================================
# Validates the Portlama plugin manifest, registration endpoint, and that
# the server can operate in plugin mode. This test only needs the server
# and validates the plugin integration surface.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Plugin Mode"

# ---------------------------------------------------------------------------
log_section "Plugin manifest endpoint exists"
# ---------------------------------------------------------------------------

MANIFEST_STATUS=$(api_get_status "plugin/manifest")
assert_eq "$MANIFEST_STATUS" "200" "Plugin manifest endpoint returns 200"

# ---------------------------------------------------------------------------
log_section "Plugin manifest structure is valid"
# ---------------------------------------------------------------------------

MANIFEST=$(api_get "plugin/manifest")

assert_json_field_not_empty "$MANIFEST" '.name' "Manifest has a name"
assert_json_field_not_empty "$MANIFEST" '.version' "Manifest has a version"
assert_json_field_not_empty "$MANIFEST" '.description' "Manifest has a description"

# Verify required manifest fields
assert_json_field "$MANIFEST" '.name' "sync" "Plugin name is 'sync'"
assert_json_field_not_empty "$MANIFEST" '.capabilities' "Manifest declares capabilities"

# ---------------------------------------------------------------------------
log_section "Plugin capabilities include expected features"
# ---------------------------------------------------------------------------

CAPS=$(echo "$MANIFEST" | jq -r '.capabilities // []' 2>/dev/null)
assert_contains "$CAPS" "sync" "Plugin declares 'sync' capability"

# ---------------------------------------------------------------------------
log_section "Plugin registration endpoint"
# ---------------------------------------------------------------------------

# The plugin registration endpoint should accept a Portlama panel connection
REGISTER_STATUS=$(api_post_status "plugin/register" '{"panelUrl": "https://test.portlama.local", "token": "test-token"}')
# In development mode, this should be accepted (or return a sensible status)
# We just verify the endpoint exists and doesn't 404
assert_not_eq "$REGISTER_STATUS" "404" "Plugin registration endpoint exists"

# ---------------------------------------------------------------------------
log_section "Plugin status endpoint"
# ---------------------------------------------------------------------------

PLUGIN_STATUS=$(api_get "plugin/status")
assert_json_field_not_empty "$PLUGIN_STATUS" '.mode' "Plugin status has mode field"

MODE=$(echo "$PLUGIN_STATUS" | jq -r '.mode' 2>/dev/null || echo "")
log_info "Server mode: $MODE"

# In development mode without Portlama connection, mode should be "standalone"
assert_eq "$MODE" "standalone" "Server running in standalone mode"

end_test
