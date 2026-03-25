#!/usr/bin/env bash
# ============================================================================
# Test 12 — Plugin Mode
# ============================================================================
# Validates the Portlama plugin infrastructure: module exports, plugin mode
# detection via environment variable, and that standalone mode is unaffected.
#
# Plugin mode is an integration pattern, not an HTTP API surface. Portlama
# reads the manifest from the package and calls buildPlugin() programmatically.
# There are no /api/sync/plugin/* HTTP endpoints.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

require_commands curl jq multipass

begin_test "Plugin Mode"

# ---------------------------------------------------------------------------
log_section "Server exports plugin infrastructure"
# ---------------------------------------------------------------------------

# Verify the sync-server package exports buildPlugin, isPluginMode, parsePluginManifest
EXPORTS_CHECK=$(host_exec "cd /opt/sync/packages/sync-server && node --input-type=module -e \"
  const m = await import('./dist/index.js');
  const exports = ['buildPlugin', 'isPluginMode', 'parsePluginManifest'];
  const found = exports.filter(e => typeof m[e] === 'function');
  console.log(JSON.stringify({ found: found.length, expected: exports.length, missing: exports.filter(e => typeof m[e] !== 'function') }));
\"" 2>/dev/null || echo '{"found":0,"expected":3}')

FOUND=$(echo "$EXPORTS_CHECK" | jq -r '.found' 2>/dev/null || echo "0")
EXPECTED=$(echo "$EXPORTS_CHECK" | jq -r '.expected' 2>/dev/null || echo "3")
assert_eq "$FOUND" "$EXPECTED" "sync-server exports buildPlugin, isPluginMode, parsePluginManifest"

# ---------------------------------------------------------------------------
log_section "isPluginMode returns false in standalone"
# ---------------------------------------------------------------------------

STANDALONE_CHECK=$(host_exec "cd /opt/sync/packages/sync-server && node --input-type=module -e \"
  const { isPluginMode } = await import('./dist/index.js');
  console.log(isPluginMode() ? 'plugin' : 'standalone');
\"" 2>/dev/null || echo "error")
assert_eq "$STANDALONE_CHECK" "standalone" "isPluginMode() returns false in standalone mode"

# ---------------------------------------------------------------------------
log_section "isPluginMode returns true with PORTLAMA_PLUGIN=1"
# ---------------------------------------------------------------------------

PLUGIN_CHECK=$(host_exec "cd /opt/sync/packages/sync-server && PORTLAMA_PLUGIN=1 node --input-type=module -e \"
  const { isPluginMode } = await import('./dist/index.js');
  console.log(isPluginMode() ? 'plugin' : 'standalone');
\"" 2>/dev/null || echo "error")
assert_eq "$PLUGIN_CHECK" "plugin" "isPluginMode() returns true when PORTLAMA_PLUGIN=1"

# ---------------------------------------------------------------------------
log_section "parsePluginManifest validates structure"
# ---------------------------------------------------------------------------

MANIFEST_CHECK=$(host_exec "cd /opt/sync/packages/sync-server && node --input-type=module -e \"
  const { parsePluginManifest } = await import('./dist/index.js');
  try {
    parsePluginManifest({ name: 'sync', version: '1.0.0', roles: { host: {}, agent: {} } });
    console.log('valid');
  } catch (e) {
    console.log('invalid: ' + e.message);
  }
\"" 2>/dev/null || echo "error")
assert_eq "$MANIFEST_CHECK" "valid" "parsePluginManifest accepts valid manifest"

MANIFEST_REJECT=$(host_exec "cd /opt/sync/packages/sync-server && node --input-type=module -e \"
  const { parsePluginManifest } = await import('./dist/index.js');
  try {
    parsePluginManifest(null);
    console.log('valid');
  } catch (e) {
    console.log('rejected');
  }
\"" 2>/dev/null || echo "error")
assert_eq "$MANIFEST_REJECT" "rejected" "parsePluginManifest rejects null input"

# ---------------------------------------------------------------------------
log_section "Server health still works (standalone unaffected)"
# ---------------------------------------------------------------------------

HEALTH_STATUS=$(api_get_status "health")
assert_eq "$HEALTH_STATUS" "200" "Health endpoint returns 200 in standalone mode"

end_test
