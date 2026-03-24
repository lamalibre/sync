#!/usr/bin/env bash
# ============================================================================
# Sync E2E Test Helpers (Two-VM)
# ============================================================================
# Shared functions for all E2E test scripts. Tests run from macOS and interact
# with sync-host and sync-agent VMs via curl (API) and multipass exec (shell).
#
# Source this file at the top of every test:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${SCRIPT_DIR}/helpers.sh"
#
# Required environment variables (set by MCP test runner):
#   HOST_IP    — IPv4 of the sync-host VM
#   AGENT_IP   — IPv4 of the sync-agent VM
#   BASE_URL   — Full URL of the sync-server (e.g. http://10.x.x.x:9393)
#   API_KEY    — Bearer token for server authentication
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment variables before sourcing
# ---------------------------------------------------------------------------
: "${HOST_IP:?HOST_IP must be set}"
: "${AGENT_IP:?AGENT_IP must be set}"
: "${BASE_URL:?BASE_URL must be set}"
: "${API_KEY:?API_KEY must be set}"
: "${CURL_TIMEOUT:=30}"

# ---------------------------------------------------------------------------
# VM names for multipass
# ---------------------------------------------------------------------------
VM_HOST="sync-host"
VM_AGENT="sync-agent"

# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------
_PASS_COUNT=0
_FAIL_COUNT=0
_SKIP_COUNT=0

# If _LOG_FILE is set, all log functions also write to the log file

# ---------------------------------------------------------------------------
# Colours (disabled when stdout is not a terminal)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  _GREEN='\033[0;32m'
  _RED='\033[0;31m'
  _YELLOW='\033[0;33m'
  _CYAN='\033[0;36m'
  _RESET='\033[0m'
else
  _GREEN=''
  _RED=''
  _YELLOW=''
  _CYAN=''
  _RESET=''
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_pass() {
  local msg="$1"
  _PASS_COUNT=$((_PASS_COUNT + 1))
  echo -e "${_GREEN}  [PASS]${_RESET} ${msg}"
  [ -n "${_LOG_FILE:-}" ] && echo "  \`$(date -u '+%H:%M:%S')\` ${msg}  " >> "${_LOG_FILE}" 2>/dev/null || true
}

log_fail() {
  local msg="$1"
  _FAIL_COUNT=$((_FAIL_COUNT + 1))
  echo -e "${_RED}  [FAIL]${_RESET} ${msg}"
  [ -n "${_LOG_FILE:-}" ] && echo "  \`$(date -u '+%H:%M:%S')\` **${msg}**  " >> "${_LOG_FILE}" 2>/dev/null || true
}

log_skip() {
  local msg="$1"
  _SKIP_COUNT=$((_SKIP_COUNT + 1))
  echo -e "${_YELLOW}  [SKIP]${_RESET} ${msg}"
  [ -n "${_LOG_FILE:-}" ] && echo "  \`$(date -u '+%H:%M:%S')\` ${msg}  " >> "${_LOG_FILE}" 2>/dev/null || true
}

log_info() {
  local msg="$1"
  echo -e "${_CYAN}  [INFO]${_RESET} ${msg}"
  [ -n "${_LOG_FILE:-}" ] && echo "  \`$(date -u '+%H:%M:%S')\` ${msg}  " >> "${_LOG_FILE}" 2>/dev/null || true
}

log_section() {
  local msg="$1"
  echo ""
  echo -e "${_CYAN}--- ${msg} ---${_RESET}"
  if [ -n "${_LOG_FILE:-}" ]; then
    echo "" >> "${_LOG_FILE}" 2>/dev/null || true
    echo "## ${msg}" >> "${_LOG_FILE}" 2>/dev/null || true
    echo "" >> "${_LOG_FILE}" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# VM execution helpers
# ---------------------------------------------------------------------------

# host_exec command — execute a command on the host VM (as root)
host_exec() {
  multipass exec "$VM_HOST" -- sudo bash -c "$1"
}

# agent_exec command — execute a command on the agent VM (as root)
agent_exec() {
  multipass exec "$VM_AGENT" -- sudo bash -c "$1"
}

# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------

# assert_eq actual expected message
assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"

  if [ "$actual" = "$expected" ]; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (expected: '$expected', got: '$actual')"
    return 1
  fi
}

# assert_not_eq actual unexpected message
assert_not_eq() {
  local actual="$1"
  local unexpected="$2"
  local message="$3"

  if [ "$actual" != "$unexpected" ]; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (got unexpected value: '$actual')"
    return 1
  fi
}

# assert_contains output substring message
assert_contains() {
  local output="$1"
  local substring="$2"
  local message="$3"

  if echo "$output" | grep -qF "$substring"; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (output does not contain: '$substring')"
    return 1
  fi
}

# assert_not_contains output substring message
assert_not_contains() {
  local output="$1"
  local substring="$2"
  local message="$3"

  if ! echo "$output" | grep -qF "$substring"; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (output unexpectedly contains: '$substring')"
    return 1
  fi
}

# assert_http_status url expected_status [extra_curl_args...]
assert_http_status() {
  local url="$1"
  local expected_status="$2"
  shift 2
  local extra_args=("$@")

  local actual_status
  actual_status=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$CURL_TIMEOUT" \
    ${extra_args[@]+"${extra_args[@]}"} \
    "$url" 2>/dev/null || echo "000")

  if [ "$actual_status" = "$expected_status" ]; then
    log_pass "HTTP $expected_status from $url"
    return 0
  else
    log_fail "Expected HTTP $expected_status from $url, got $actual_status"
    return 1
  fi
}

# assert_json_field json jq_expression expected_value message
assert_json_field() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local message="$4"

  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "__JQ_ERROR__")

  if [ "$actual" = "__JQ_ERROR__" ]; then
    log_fail "$message (jq failed to parse JSON or extract field '$field')"
    return 1
  fi

  if [ "$actual" = "$expected" ]; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (expected: '$expected', got: '$actual')"
    return 1
  fi
}

# assert_json_field_not_empty json jq_expression message
assert_json_field_not_empty() {
  local json="$1"
  local field="$2"
  local message="$3"

  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "")

  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "" ]; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (field '$field' is empty or null)"
    return 1
  fi
}

# assert_file_on_host path message — assert file exists on host VM
assert_file_on_host() {
  local file_path="$1"
  local message="$2"

  if host_exec "test -f '$file_path' && echo exists" | grep -q exists; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (file not found on host: '$file_path')"
    return 1
  fi
}

# assert_file_on_agent path message — assert file exists on agent VM
assert_file_on_agent() {
  local file_path="$1"
  local message="$2"

  if agent_exec "test -f '$file_path' && echo exists" | grep -q exists; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (file not found on agent: '$file_path')"
    return 1
  fi
}

# assert_file_content_on_agent path expected_content message
assert_file_content_on_agent() {
  local file_path="$1"
  local expected="$2"
  local message="$3"

  local actual
  actual=$(agent_exec "cat '$file_path'" 2>/dev/null || echo "")

  if [ "$actual" = "$expected" ]; then
    log_pass "$message"
    return 0
  else
    log_fail "$message (expected: '$expected', got: '$actual')"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# API request helpers (curl to host VM from macOS)
# ---------------------------------------------------------------------------

# api_get path
api_get() {
  local api_path="$1"
  curl -s \
    --max-time "$CURL_TIMEOUT" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${BASE_URL}/api/sync/${api_path}"
}

# api_post path [json_body]
api_post() {
  local api_path="$1"
  local _default='{}'; local body="${2:-$_default}"
  curl -s \
    --max-time "$CURL_TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$body" \
    "${BASE_URL}/api/sync/${api_path}"
}

# api_put path json_body
api_put() {
  local api_path="$1"
  local body="$2"
  curl -s \
    --max-time "$CURL_TIMEOUT" \
    -X PUT \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$body" \
    "${BASE_URL}/api/sync/${api_path}"
}

# api_patch path json_body
api_patch() {
  local api_path="$1"
  local body="$2"
  curl -s \
    --max-time "$CURL_TIMEOUT" \
    -X PATCH \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$body" \
    "${BASE_URL}/api/sync/${api_path}"
}

# api_delete path
api_delete() {
  local api_path="$1"
  curl -s \
    --max-time "$CURL_TIMEOUT" \
    -X DELETE \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${BASE_URL}/api/sync/${api_path}"
}

# api_get_status path
api_get_status() {
  local api_path="$1"
  curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$CURL_TIMEOUT" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${BASE_URL}/api/sync/${api_path}" 2>/dev/null || echo "000"
}

# api_post_status path [json_body]
api_post_status() {
  local api_path="$1"
  local _default='{}'; local body="${2:-$_default}"
  curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$CURL_TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$body" \
    "${BASE_URL}/api/sync/${api_path}" 2>/dev/null || echo "000"
}

# api_delete_status path
api_delete_status() {
  local api_path="$1"
  curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$CURL_TIMEOUT" \
    -X DELETE \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${BASE_URL}/api/sync/${api_path}" 2>/dev/null || echo "000"
}

# ---------------------------------------------------------------------------
# Sync-specific helpers
# ---------------------------------------------------------------------------

# wait_for_http url [timeout_seconds]
wait_for_http() {
  local url="$1"
  local timeout="${2:-30}"
  local elapsed=0

  while [ "$elapsed" -lt "$timeout" ]; do
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      --max-time 5 \
      "$url" 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

# wait_for_sync_complete project_id [timeout_seconds]
# Poll the sync status endpoint until the operation completes or times out.
wait_for_sync_complete() {
  local project_id="$1"
  local timeout="${2:-120}"
  local elapsed=0

  while [ "$elapsed" -lt "$timeout" ]; do
    local response
    response=$(api_get "projects/${project_id}/status")
    local state
    state=$(echo "$response" | jq -r '.status' 2>/dev/null || echo "unknown")

    if [ "$state" = "synced" ] || [ "$state" = "archived" ]; then
      return 0
    elif [ "$state" = "error" ]; then
      log_fail "Sync operation failed for project $project_id"
      return 1
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_fail "Sync operation timed out for project $project_id after ${timeout}s"
  return 1
}

# wait_for_agent_count expected_count [timeout_seconds]
# Poll the agents endpoint until the expected agent count is reached.
wait_for_agent_count() {
  local expected="$1"
  local timeout="${2:-30}"
  local elapsed=0

  while [ "$elapsed" -lt "$timeout" ]; do
    local response
    response=$(api_get "agents")
    local count
    count=$(echo "$response" | jq -r '.agents | length' 2>/dev/null || echo "0")

    if [ "$count" = "$expected" ]; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

# ---------------------------------------------------------------------------
# Test lifecycle
# ---------------------------------------------------------------------------

# begin_test test_name
begin_test() {
  local name="$1"
  echo ""
  echo "============================================================================"
  echo -e "${_CYAN} Sync E2E: ${name}${_RESET}"
  echo "============================================================================"
  echo -e "  Host:  ${HOST_IP} (${VM_HOST})"
  echo -e "  Agent: ${AGENT_IP} (${VM_AGENT})"
  echo ""
  if [ -n "${_LOG_FILE:-}" ]; then
    {
      echo "# Sync E2E: ${name}"
      echo ""
      echo "> Started at \`$(date -u '+%Y-%m-%d %H:%M:%S UTC')\`"
      echo "> Host: ${HOST_IP}, Agent: ${AGENT_IP}"
      echo ""
    } >> "${_LOG_FILE}" 2>/dev/null || true
  fi
  _PASS_COUNT=0
  _FAIL_COUNT=0
  _SKIP_COUNT=0
}

# end_test
end_test() {
  local total=$((_PASS_COUNT + _FAIL_COUNT + _SKIP_COUNT))
  echo ""
  echo "============================================================================"
  echo -e "  Results: ${_GREEN}${_PASS_COUNT} passed${_RESET}, ${_RED}${_FAIL_COUNT} failed${_RESET}, ${_YELLOW}${_SKIP_COUNT} skipped${_RESET} (${total} total)"
  echo "============================================================================"
  echo ""
  if [ -n "${_LOG_FILE:-}" ]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "## Results"
      echo ""
      echo "| Metric | Count |"
      echo "|--------|-------|"
      echo "| **Passed** | \`${_PASS_COUNT}\` |"
      echo "| **Failed** | \`${_FAIL_COUNT}\` |"
      echo "| **Skipped** | \`${_SKIP_COUNT}\` |"
      echo "| **Total** | \`${total}\` |"
      echo ""
    } >> "${_LOG_FILE}" 2>/dev/null || true
  fi

  if [ "$_FAIL_COUNT" -gt 0 ]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

require_commands() {
  local missing=()
  for cmd in "$@"; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Error: required commands not found: ${missing[*]}"
    echo "Install them before running this test."
    exit 2
  fi
}
