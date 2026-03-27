/**
 * Layered ignore/exclude resolution for sync operations.
 *
 * Merges patterns from multiple sources into a single set that feeds both
 * rclone (--exclude-from file) and chokidar (file watcher ignore patterns).
 *
 * Resolution order (additive — later layers can only ADD exclusions):
 *   1. Built-in defaults (always applied)
 *   2. .gitignore (root + nested, scoped to their directories)
 *   3. .dockerignore (root only)
 *   4. .syncignore (root only, custom per-project)
 *   5. Per-project API excludes (from server config)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isNodeError } from './types.js';

/** Maximum size (bytes) for an ignore file. Files larger than this are skipped. */
const MAX_IGNORE_FILE_SIZE = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Built-in excludes — always applied, never overridable
// ---------------------------------------------------------------------------

/**
 * Patterns that are virtually never wanted in sync.
 * Uses rclone filter syntax (** for recursive directory match).
 */
export const BUILTIN_EXCLUDES: readonly string[] = [
  // Version control
  '.git/**',
  '.svn/**',
  '.hg/**',

  // Node.js / JavaScript
  'node_modules/**',
  '.pnpm-store/**',
  '.npm/**',
  '.yarn/cache/**',
  '.yarn/unplugged/**',
  'bower_components/**',

  // Python
  '__pycache__/**',
  '.venv/**',
  '*.pyc',
  '*.pyo',

  // Rust
  'target/**',

  // Java / Kotlin
  '.gradle/**',
  'build/**',

  // .NET
  'bin/**',
  'obj/**',

  // OS artifacts
  '.DS_Store',
  'Thumbs.db',
  'Desktop.ini',
  'ehthumbs.db',

  // Editor / IDE
  '.idea/**',
  '.vscode/**',
  '*.swp',
  '*.swo',
  '*~',

  // Temporary / logs
  '*.tmp',
  '*.log',

  // Sync internals
  '.sync-agent/**',
  '.rclone-*',
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedIgnorePatterns {
  /** Patterns in rclone exclude syntax, ready to write to an --exclude-from file. */
  readonly rclonePatterns: readonly string[];
  /** Patterns converted for chokidar's `ignored` option. */
  readonly chokidarPatterns: readonly (string | RegExp)[];
}

export interface IgnoreResolverOptions {
  /** Absolute path to the project's local directory. */
  readonly localPath: string;
  /** Per-project excludes from the server API. */
  readonly projectExcludes: readonly string[];
  /** Whether to parse .gitignore files (default: true). */
  readonly respectGitignore?: boolean;
  /** Whether to parse .dockerignore (default: true). */
  readonly respectDockerignore?: boolean;
  /** Whether to parse .syncignore (default: true). */
  readonly respectSyncignore?: boolean;
  /** Logger for warnings about unreadable files etc. */
  readonly logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve all ignore layers into a unified set of patterns.
 *
 * The resolution walks the local directory tree for `.gitignore` files
 * (skipping directories matched by built-in excludes to avoid descending
 * into `node_modules` etc.), parses root-level `.dockerignore` and
 * `.syncignore`, and merges everything with the API-level project excludes.
 */
export async function resolveIgnorePatterns(
  options: IgnoreResolverOptions,
): Promise<ResolvedIgnorePatterns> {
  const {
    localPath,
    projectExcludes,
    respectGitignore = true,
    respectDockerignore = true,
    respectSyncignore = true,
    logger,
  } = options;

  const allPatterns: string[] = [...BUILTIN_EXCLUDES];

  // Layer 2: .gitignore (root + nested)
  if (respectGitignore) {
    const gitignorePatterns = await collectGitignorePatterns(localPath, logger);
    allPatterns.push(...gitignorePatterns);
  }

  // Layer 3: .dockerignore (root only)
  if (respectDockerignore) {
    const dockerPatterns = await parseIgnoreFileAt(
      join(localPath, '.dockerignore'),
      '',
      logger,
    );
    allPatterns.push(...dockerPatterns);
  }

  // Layer 4: .syncignore (root only)
  if (respectSyncignore) {
    const syncPatterns = await parseIgnoreFileAt(
      join(localPath, '.syncignore'),
      '',
      logger,
    );
    allPatterns.push(...syncPatterns);
  }

  // Layer 5: per-project API excludes
  for (const pattern of projectExcludes) {
    if (pattern.length > 0) {
      allPatterns.push(pattern);
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of allPatterns) {
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(p);
    }
  }

  return {
    rclonePatterns: deduped,
    chokidarPatterns: rclonePatternsToChokidar(deduped),
  };
}

// ---------------------------------------------------------------------------
// .gitignore collection (nested)
// ---------------------------------------------------------------------------

/**
 * Walk the directory tree looking for `.gitignore` files and collect all
 * patterns, scoped to their containing directory.
 *
 * Skips directories matched by BUILTIN_EXCLUDES to avoid descending into
 * `node_modules`, `.git`, `target`, etc.
 */
async function collectGitignorePatterns(
  localPath: string,
  logger?: IgnoreResolverOptions['logger'],
): Promise<string[]> {
  const patterns: string[] = [];

  // Build a set of directory names to skip during the walk.
  // Extract bare directory names from patterns like "node_modules/**".
  const skipDirs = new Set<string>();
  for (const p of BUILTIN_EXCLUDES) {
    if (p.endsWith('/**')) {
      skipDirs.add(p.slice(0, -3));
    }
  }

  await walkForGitignore(localPath, localPath, skipDirs, patterns, logger, 0);
  return patterns;
}

/** Maximum directory depth to prevent runaway walks. */
const MAX_WALK_DEPTH = 30;

async function walkForGitignore(
  rootPath: string,
  currentPath: string,
  skipDirs: ReadonlySet<string>,
  out: string[],
  logger: IgnoreResolverOptions['logger'],
  depth: number,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;

  // Try to parse .gitignore in this directory
  const gitignorePath = join(currentPath, '.gitignore');
  const relDir = relative(rootPath, currentPath);
  // Use posix separators for rclone patterns
  const relDirPosix = relDir.split(/[\\/]/).filter(Boolean).join('/');

  const patterns = await parseIgnoreFileAt(gitignorePath, relDirPosix, logger);
  out.push(...patterns);

  // Recurse into subdirectories (skip excluded ones)
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return; // Permission errors, symlink issues, etc.
  }

  const resolvedRoot = resolve(rootPath);

  for (const entry of entries) {
    // Skip symlinks to prevent following links outside the project tree
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const name = entry.name;

    // Skip hidden directories — most are VCS/editor internals (.git, .idea, etc.).
    // This intentionally deviates from git's nested .gitignore handling: patterns
    // inside dotdirs like .config/.gitignore are not picked up.
    if (name.startsWith('.')) continue;
    if (skipDirs.has(name)) continue;

    // Defense-in-depth: ensure the child resolves inside the project root
    const childPath = join(currentPath, name);
    const resolvedChild = resolve(childPath);
    if (!resolvedChild.startsWith(resolvedRoot + '/') && resolvedChild !== resolvedRoot) {
      continue;
    }

    await walkForGitignore(
      rootPath,
      childPath,
      skipDirs,
      out,
      logger,
      depth + 1,
    );
  }
}

// ---------------------------------------------------------------------------
// Ignore file parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse a single gitignore-format file. Returns patterns in rclone
 * exclude syntax, scoped to the given relative directory.
 *
 * Returns an empty array if the file does not exist or cannot be read.
 */
async function parseIgnoreFileAt(
  filePath: string,
  relativeDir: string,
  logger?: IgnoreResolverOptions['logger'],
): Promise<string[]> {
  let content: string;
  try {
    // Check size before reading to prevent memory exhaustion from oversized files
    const info = await stat(filePath);
    if (info.size > MAX_IGNORE_FILE_SIZE) {
      logger?.warn({ filePath, size: info.size }, 'Ignore file too large, skipping');
      return [];
    }
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    // File not found is expected — only warn on unexpected errors
    if (isNodeError(err) && err.code !== 'ENOENT') {
      logger?.warn({ filePath, error: err.code }, 'Could not read ignore file');
    }
    return [];
  }

  return parseIgnoreFileContent(content, relativeDir);
}

/**
 * Parse the content of a gitignore-format file and convert each pattern
 * to rclone exclude syntax scoped to `relativeDir`.
 *
 * Handles:
 * - Comments (# lines)
 * - Blank lines
 * - Negation (! prefix) — skipped with warning (additive-only merge)
 * - Directory patterns (trailing /)
 * - Anchored patterns (leading /)
 * - Standard globs (*, **, ?)
 */
export function parseIgnoreFileContent(
  content: string,
  relativeDir: string,
): string[] {
  const patterns: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line.length === 0 || line.startsWith('#')) continue;

    // Skip negation patterns — our merge is additive-only
    if (line.startsWith('!')) continue;

    const rclonePattern = gitignoreToRclone(line, relativeDir);
    if (rclonePattern.length > 0) {
      patterns.push(rclonePattern);
    }
  }

  return patterns;
}

/**
 * Convert a single gitignore pattern to rclone exclude syntax.
 *
 * Conversion rules:
 * - `foo` (unanchored) → `foo` (matches anywhere, same semantics in rclone)
 * - `/foo` (anchored to gitignore dir) → `/{relDir}/foo` (anchored to root)
 * - `foo/` (directory) → `foo/**` (rclone uses ** for recursive dir match)
 * - `/foo/` (anchored dir) → `/{relDir}/foo/**`
 * - `*.log` → `*.log` (already compatible)
 * - Patterns with `**` pass through (both gitignore and rclone support **)
 */
export function gitignoreToRclone(pattern: string, relativeDir: string): string {
  let p = pattern;

  const isAnchored = p.startsWith('/');
  const isDir = p.endsWith('/');

  // Strip leading/trailing markers for processing
  if (isAnchored) p = p.slice(1);
  if (isDir) p = p.slice(0, -1);

  // If it's a directory pattern, add recursive match
  if (isDir) {
    p = `${p}/**`;
  }

  // If anchored, scope to the directory containing the ignore file
  if (isAnchored) {
    if (relativeDir.length > 0) {
      p = `/${relativeDir}/${p}`;
    } else {
      p = `/${p}`;
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// Chokidar pattern conversion
// ---------------------------------------------------------------------------

/**
 * Convert rclone exclude patterns to chokidar-compatible ignore patterns.
 *
 * Chokidar accepts strings, RegExps, or functions. We produce RegExps
 * for reliable matching.
 */
function rclonePatternsToChokidar(patterns: readonly string[]): (string | RegExp)[] {
  const result: (string | RegExp)[] = [];

  for (const pattern of patterns) {
    const re = rclonePatternToRegex(pattern);
    if (re) {
      result.push(re);
    }
  }

  return result;
}

/**
 * Convert a single rclone exclude pattern to a RegExp for chokidar.
 *
 * Handles common patterns:
 * - `*.ext` → matches files ending in .ext
 * - `dirname/**` → matches anything under dirname/
 * - `/anchored/path/**` → matches only at that specific path
 * - `exactname` → matches that name anywhere in the tree
 * - Patterns with `**` → recursive match
 */
function rclonePatternToRegex(pattern: string): RegExp | null {
  if (pattern.length === 0) return null;

  const isAnchored = pattern.startsWith('/');
  const p = isAnchored ? pattern.slice(1) : pattern;

  // Handle directory recursive patterns: "foo/**"
  if (p.endsWith('/**')) {
    const dir = p.slice(0, -3);
    const escapedDir = escapeRegex(dir);
    if (isAnchored) {
      // Anchored: match only at the specific relative path from root
      return new RegExp(`^${escapedDir}([/\\\\]|$)`);
    }
    // Unanchored: match directory name anywhere
    return new RegExp(`(^|[/\\\\])${escapedDir}([/\\\\]|$)`);
  }

  // Handle extension globs: "*.ext"
  if (p.startsWith('*.')) {
    const ext = p.slice(1); // ".ext"
    return new RegExp(`${escapeRegex(ext)}$`);
  }

  // Handle exact names (no glob chars, no path separators)
  if (!/[*?[\]{}]/.test(p) && !p.includes('/')) {
    return new RegExp(`(^|[/\\\\])${escapeRegex(p)}$`);
  }

  // Handle anchored exact paths
  if (isAnchored && !/[*?[\]{}]/.test(p)) {
    return new RegExp(`^${escapeRegex(p)}$`);
  }

  // For complex glob patterns, build a basic regex
  return globToRegex(p, isAnchored);
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports: *, **, ?
 * Does NOT support character classes [abc] — these pass through escaped.
 */
function globToRegex(glob: string, anchored: boolean): RegExp {
  let regex = '';
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i]!;

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** matches everything including path separators
        if (glob[i + 2] === '/') {
          regex += '(?:.*[/\\\\])?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        // * matches everything except path separators
        regex += '[^/\\\\]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/\\\\]';
      i += 1;
    } else {
      regex += escapeRegex(ch);
      i += 1;
    }
  }

  if (anchored) {
    // Anchored: match only from the start of the relative path
    return new RegExp(`^${regex}$`);
  }
  return new RegExp(`(^|[/\\\\])${regex}$`);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
