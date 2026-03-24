// ============================================================================
// Test Discovery & Dependency Graph
// ============================================================================
// Discovers test files from the filesystem and verifies they are git-tracked.
// Only files matching the NN-name.sh convention that are committed to git are
// eligible for execution — this prevents injected scripts from being run.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { E2E_DIR, REPO_ROOT } from '../config.js';

/** Pattern for valid test files: two-digit prefix, hyphen, name, .sh extension. */
const TEST_FILE_PATTERN = /^(\d{2})-[a-z0-9-]+\.sh$/;

/**
 * Get the set of git-known files in a directory (tracked + staged + untracked).
 * Returns a Set of filenames (not full paths).
 * Includes untracked files so newly written tests are discoverable before commit.
 */
function getGitKnownFiles(dir) {
  try {
    const relativePath = dir.replace(REPO_ROOT + '/', '');
    // Get tracked files
    const tracked = execSync(`git ls-files "${relativePath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Get untracked (but not gitignored) files
    const untracked = execSync(`git ls-files --others --exclude-standard "${relativePath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const all = (tracked + '\n' + untracked)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => f.split('/').pop());
    return new Set(all);
  } catch {
    // If git is unavailable, fall back to empty set (all files rejected)
    return new Set();
  }
}

/**
 * Discover test files from a directory.
 * Only returns files that:
 *   1. Match the NN-name.sh naming convention
 *   2. Are tracked by git (not injected/untracked)
 * Returns a map of { number: filename }.
 */
export function discoverTests(dir) {
  const gitKnown = getGitKnownFiles(dir);
  const files = fs.readdirSync(dir).filter((f) => TEST_FILE_PATTERN.test(f));
  const map = {};

  for (const file of files) {
    if (!gitKnown.has(file)) continue; // reject gitignored files
    const num = parseInt(file.slice(0, 2), 10);
    map[num] = file;
  }

  return map;
}

/**
 * Two-VM E2E test dependency graph.
 * Key = test number, Value = array of prerequisite test numbers.
 *
 * Test 01 verifies server health on the host VM.
 * Test 02 verifies agent registration across the network.
 * Test 03 configures storage, test 04 creates projects.
 * Tests 05-11 are feature tests requiring the full server+agent stack.
 * Test 12 (plugin mode) only needs the server.
 */
export const E2E_DEPS = {
  1: [], // server-health — server running on host VM
  2: [1], // agent-registration — agent on agent VM registers with host
  3: [1], // storage-config — configure storage provider on host
  4: [1], // project-crud — create/read/update/delete projects
  5: [2, 3, 4], // push-sync — agent pushes files via rclone
  6: [5], // pull-sync — agent pulls files (needs prior push)
  7: [5], // bidirectional — bisync with conflict detection
  8: [5], // watch-trigger — file watcher triggers sync on agent
  9: [5], // archive-restore — archive files, verify stubs, restore
  10: [5], // encryption — encrypted sync via rclone crypt
  11: [5], // scheduled-sync — cron-based scheduling on agent
  12: [1], // plugin-mode — Portlama plugin manifest validation
};

/** Lazily discovered test map — cached after first call. */
let _testMap = null;

/** Get the test file map. Auto-discovered and cached. */
export function getTests() {
  if (!_testMap) _testMap = discoverTests(E2E_DIR);
  return _testMap;
}

/** Invalidate cached test map (e.g. after adding new tests). */
export function clearTestCache() {
  _testMap = null;
}

/**
 * Resolve the full dependency chain for a given test number.
 * Returns a sorted array of test numbers that must run (including the target).
 */
export function resolveDeps(testNumber, depGraph) {
  const visited = new Set();
  const order = [];

  function walk(n) {
    if (visited.has(n)) return;
    visited.add(n);
    const deps = depGraph[n] || [];
    for (const dep of deps) {
      walk(dep);
    }
    order.push(n);
  }

  walk(testNumber);
  return order.sort((a, b) => a - b);
}

/**
 * Given a target test, return the minimal set of test filenames to run.
 */
export function resolveTestChain(testNumber) {
  const testMap = getTests();
  const chain = resolveDeps(testNumber, E2E_DEPS);
  return chain.map((n) => ({ number: n, file: testMap[n] })).filter((t) => t.file);
}
