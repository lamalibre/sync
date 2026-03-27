/**
 * File watcher using chokidar.
 *
 * Watches project directories for file changes and triggers sync
 * after a configurable debounce period. Respects exclude patterns
 * and does not follow symlinks outside the project directory.
 *
 * Key design decisions:
 * - Streaming event processing (no full file tree accumulation)
 * - Debounced change detection to batch rapid changes
 * - Exclude pattern matching before triggering sync
 * - Proper cleanup on project deletion or agent shutdown
 */

import chokidar, { type FSWatcher as ChokidarFSWatcher } from 'chokidar';
import { resolve, relative } from 'node:path';
import type { Logger } from 'pino';

/** Default debounce interval in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 5_000;

/** Callback invoked when changes are detected after debounce. */
export type OnChangesDetected = (projectId: string, changedFiles: readonly string[]) => void;

export interface FileWatcherOptions {
  /** Project ID to identify the watcher. */
  readonly projectId: string;
  /** Absolute path to the local project directory. */
  readonly localPath: string;
  /** Glob patterns to include — only matching files trigger sync. Empty means all files. */
  readonly includes: readonly string[];
  /** Glob patterns to exclude from watching. */
  readonly excludes: readonly string[];
  /**
   * Pre-resolved chokidar ignore patterns from the ignore resolver.
   * When provided, these are used instead of building patterns from `excludes`.
   */
  readonly resolvedChokidarPatterns?: readonly (string | RegExp)[];
  /** Debounce interval in milliseconds (default: 5000). */
  readonly debounceMs?: number;
  /** Callback when changes are detected after debounce. */
  readonly onChanges: OnChangesDetected;
  readonly logger: Logger;
}

/**
 * A file watcher for a single project directory.
 *
 * Uses chokidar to watch for file changes, debounces them,
 * and invokes the callback with the list of changed paths.
 */
export class FileWatcher {
  private readonly projectId: string;
  private readonly localPath: string;
  private readonly debounceMs: number;
  private readonly onChanges: OnChangesDetected;
  private readonly logger: Logger;

  private readonly includeMatchers: readonly RegExp[];
  private watcher: ChokidarFSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: Set<string> = new Set();
  private running = false;

  constructor(options: FileWatcherOptions) {
    this.projectId = options.projectId;
    this.localPath = resolve(options.localPath);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onChanges = options.onChanges;
    this.logger = options.logger.child({
      component: 'file-watcher',
      projectId: options.projectId,
    });

    // Build include matchers — when non-empty, only matching files trigger sync
    this.includeMatchers = buildIncludeMatchers(options.includes);

    // Use pre-resolved patterns from the ignore resolver when available,
    // otherwise fall back to inline pattern building from excludes.
    const ignored = options.resolvedChokidarPatterns
      ? [...options.resolvedChokidarPatterns]
      : buildIgnorePatterns(options.excludes, this.localPath);

    // Create the chokidar watcher eagerly so it is ready when start() is called.
    // stop() handles cleanup if start() is never called.
    this.watcher = chokidar.watch(this.localPath, {
      // Do not follow symlinks outside the project directory (security)
      followSymlinks: false,
      // Use native OS events, not polling
      usePolling: false,
      // Ignore patterns
      ignored,
      // Don't fire initial add events for existing files
      ignoreInitial: true,
      // Ignore permission errors
      ignorePermissionErrors: true,
      // Wait for writes to complete before firing events
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (!this.watcher) {
      this.logger.warn('Watcher was already closed, cannot start');
      return;
    }

    this.logger.info(
      { localPath: this.localPath, debounceMs: this.debounceMs },
      'Starting file watcher',
    );

    this.watcher.on('add', (filePath: string) => {
      this.handleChange('add', filePath);
    });

    this.watcher.on('change', (filePath: string) => {
      this.handleChange('change', filePath);
    });

    this.watcher.on('unlink', (filePath: string) => {
      this.handleChange('unlink', filePath);
    });

    this.watcher.on('error', (error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'File watcher error',
      );
    });
  }

  /**
   * Stop watching and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.watcher) return;
    this.running = false;

    this.logger.info('Stopping file watcher');

    // Clear pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();

    // Close the chokidar watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Whether the watcher is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle a single file change event.
   * Adds the file to the pending set and resets the debounce timer.
   */
  private handleChange(event: string, filePath: string): void {
    if (!this.running) return;

    // Compute relative path for logging (never log absolute paths with user data)
    const relativePath = relative(this.localPath, filePath);

    // When include patterns are set, skip files that don't match any pattern
    if (this.includeMatchers.length > 0) {
      const matches = this.includeMatchers.some((re) => re.test(relativePath));
      if (!matches) return;
    }

    this.logger.debug({ event, file: relativePath }, 'File change detected');

    this.pendingChanges.add(relativePath);

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, this.debounceMs);
  }

  /**
   * Flush accumulated changes and invoke the callback.
   */
  private flushChanges(): void {
    if (this.pendingChanges.size === 0) return;

    const changedFiles = Array.from(this.pendingChanges);
    this.pendingChanges.clear();
    this.debounceTimer = null;

    this.logger.info(
      { fileCount: changedFiles.length },
      'Debounce period elapsed, triggering sync',
    );

    this.onChanges(this.projectId, changedFiles);
  }
}

/**
 * Build chokidar-compatible ignore patterns from exclude globs.
 *
 * Chokidar's `ignored` option accepts:
 * - strings (exact path matches)
 * - RegExps
 * - functions (path => boolean)
 * - arrays of the above
 *
 * We convert common glob patterns to regexps or functions.
 */
function buildIgnorePatterns(
  excludes: readonly string[],
  _localPath: string,
): Array<string | RegExp> {
  const patterns: Array<string | RegExp> = [
    // Always ignore dotfiles that are commonly not relevant
    /(^|[/\\])\../, // dotfiles/dirs like .git, .DS_Store
  ];

  for (const pattern of excludes) {
    // Skip patterns already covered by the dotfile matcher
    if (pattern === '.git' || pattern === '.DS_Store') continue;

    if (pattern.endsWith('/')) {
      // Directory pattern: e.g., "node_modules/"
      const dirName = pattern.slice(0, -1);
      patterns.push(new RegExp(`(^|[/\\\\])${escapeRegex(dirName)}([/\\\\]|$)`));
    } else if (pattern.startsWith('*.')) {
      // Extension pattern: e.g., "*.tmp"
      const ext = pattern.slice(1); // ".tmp"
      patterns.push(new RegExp(`${escapeRegex(ext)}$`));
    } else {
      // Exact filename or other pattern
      patterns.push(new RegExp(`(^|[/\\\\])${escapeRegex(pattern)}$`));
    }
  }

  return patterns;
}

/**
 * Build regex matchers for include patterns.
 *
 * When include patterns are set, only file changes matching at least one
 * pattern should trigger a sync. Empty includes means all files match.
 *
 * Supports the same pattern formats as rclone include:
 * - Extension globs: "*.md" matches any file ending in .md
 * - Directory globs: "src/**" matches anything under src/
 * - Exact: "README.md" matches that filename anywhere
 */
function buildIncludeMatchers(includes: readonly string[]): RegExp[] {
  if (includes.length === 0) return [];

  const matchers: RegExp[] = [];
  for (const pattern of includes) {
    if (pattern.startsWith('*.')) {
      // Extension pattern: "*.md" -> match files ending in .md
      const ext = pattern.slice(1); // ".md"
      matchers.push(new RegExp(`${escapeRegex(ext)}$`));
    } else if (pattern.endsWith('/**')) {
      // Directory glob: "src/**" -> match anything under src/
      const dir = pattern.slice(0, -3);
      matchers.push(new RegExp(`(^|[/\\\\])${escapeRegex(dir)}[/\\\\]`));
    } else if (pattern.endsWith('/')) {
      // Directory prefix: "src/" -> match anything under src/
      const dir = pattern.slice(0, -1);
      matchers.push(new RegExp(`(^|[/\\\\])${escapeRegex(dir)}[/\\\\]`));
    } else {
      // Exact filename match anywhere in the tree
      matchers.push(new RegExp(`(^|[/\\\\])${escapeRegex(pattern)}$`));
    }
  }
  return matchers;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
