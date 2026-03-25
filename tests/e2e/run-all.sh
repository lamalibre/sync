#!/usr/bin/env bash
# ============================================================================
# Sync E2E — Master Test Runner (Two-VM)
# ============================================================================
# Runs all E2E test scripts in sequence against provisioned VMs and reports
# a summary. Tests execute from macOS and interact with sync-host and
# sync-agent VMs via curl (API) and multipass exec (shell).
#
# Usage:
#   bash tests/e2e/run-all.sh
#
# Required environment variables (set by MCP test runner):
#   HOST_IP    — IPv4 of the sync-host VM
#   AGENT_IP   — IPv4 of the sync-agent VM
#   BASE_URL   — Full URL of the sync-server (e.g. http://10.x.x.x:9393)
#
# Optional:
#   CURL_TIMEOUT   — request timeout in seconds (default: 30)
#   LOG_DIR        — directory for per-test Markdown logs (default: /tmp)
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validate required environment variables
: "${HOST_IP:?HOST_IP must be set}"
: "${AGENT_IP:?AGENT_IP must be set}"
: "${BASE_URL:?BASE_URL must be set}"
: "${API_KEY:?API_KEY must be set}"

# Log directory for per-test Markdown logs (use unique temp dir to prevent symlink attacks)
if [ -z "${LOG_DIR:-}" ]; then
  LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sync-e2e-logs.XXXXXXXX")
fi

# Colours
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  CYAN=''
  BOLD=''
  RESET=''
fi

echo ""
echo -e "${BOLD}============================================================================${RESET}"
echo -e "${BOLD}  Sync End-to-End Test Suite (Two-VM)${RESET}"
echo -e "${BOLD}============================================================================${RESET}"
echo ""
echo -e "  Host:    ${HOST_IP}"
echo -e "  Agent:   ${AGENT_IP}"
echo -e "  Server:  ${BASE_URL}"
echo -e "  Date:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# Collect test scripts in order
TEST_SCRIPTS=(
  "01-server-health.sh"
  "02-agent-registration.sh"
  "03-storage-config.sh"
  "04-project-crud.sh"
  "05-push-sync.sh"
  "06-pull-sync.sh"
  "07-bidirectional.sh"
  "08-watch-trigger.sh"
  "09-archive-restore.sh"
  "10-encryption.sh"
  "11-scheduled-sync.sh"
  "12-plugin-mode.sh"
  "13-soft-delete.sh"
  "14-error-paths.sh"
)

PASSED=0
FAILED=0
RESULTS=()

for script in "${TEST_SCRIPTS[@]}"; do
  SCRIPT_PATH="${SCRIPT_DIR}/${script}"

  if [ ! -f "$SCRIPT_PATH" ]; then
    echo -e "${YELLOW}  [SKIP]${RESET} ${script} — file not found"
    RESULTS+=("SKIP:${script}")
    continue
  fi

  echo -e "${CYAN}  Running: ${script}${RESET}"

  # Set per-test Markdown log file so helpers.sh writes clean Markdown there
  export _LOG_FILE="${LOG_DIR}/test-${script%.sh}.md"
  : > "${_LOG_FILE}"

  if bash "$SCRIPT_PATH"; then
    RESULTS+=("PASS:${script}")
    PASSED=$((PASSED + 1))
  else
    RESULTS+=("FAIL:${script}")
    FAILED=$((FAILED + 1))
  fi
done

_LOG_FILE=""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

TOTAL=$((PASSED + FAILED))

echo ""
echo -e "${BOLD}============================================================================${RESET}"
echo -e "${BOLD}  Test Suite Summary${RESET}"
echo -e "${BOLD}============================================================================${RESET}"
echo ""

for result in "${RESULTS[@]}"; do
  STATUS="${result%%:*}"
  NAME="${result#*:}"

  case "$STATUS" in
    PASS)
      echo -e "  ${GREEN}[PASS]${RESET} ${NAME}"
      ;;
    FAIL)
      echo -e "  ${RED}[FAIL]${RESET} ${NAME}"
      ;;
    SKIP)
      echo -e "  ${YELLOW}[SKIP]${RESET} ${NAME}"
      ;;
  esac
done

echo ""
echo -e "  Total: ${TOTAL} tests — ${GREEN}${PASSED} passed${RESET}, ${RED}${FAILED} failed${RESET}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}${BOLD}SUITE FAILED${RESET}"
  exit 1
else
  echo -e "  ${GREEN}${BOLD}SUITE PASSED${RESET}"
  exit 0
fi
