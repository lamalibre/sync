import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { atomicWriteFile } from '@lamalibre/sync-shared';
import { encrypt, decrypt, setCryptoDataDir } from './crypto.js';
import type {
  ServerConfig,
  EncryptedStorageConfig,
  StorageConfig,
  Project,
  ProjectCreate,
  ProjectUpdate,
  SyncOperation,
  ActiveOperation,
  ArchiveSavings,
  RegisteredAgent,
  AgentRegister,
  AgentHeartbeat,
} from './schemas.js';
import { AGENT_HEARTBEAT_TIMEOUT_MS } from './schemas.js';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  return join(homedir(), '.sync');
}

let dataDir: string = process.env['SYNC_DATA_DIR'] ?? defaultDataDir();

// Wire up the crypto module's data directory resolver so it can find the
// master key file without creating a circular import (state → crypto → state).
setCryptoDataDir(() => dataDir);

export function getDataDir(): string {
  return dataDir;
}

export function setDataDir(dir: string): void {
  dataDir = dir;
  dataDirEnsured = false;
}

let dataDirEnsured = false;

async function ensureDataDir(): Promise<void> {
  if (dataDirEnsured) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDirEnsured = true;
}

// ---------------------------------------------------------------------------
// Atomic JSON file I/O
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Basic structural check: state files must be objects, not primitives/arrays
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      process.stderr.write(
        `Warning: ${filePath} contains unexpected JSON type (${typeof parsed}), using default.\n`,
      );
      return fallback;
    }
    return parsed as T;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    // File exists but is corrupt or unreadable — log warning and return fallback
    process.stderr.write(
      `Warning: Failed to read ${filePath}, using default. Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return fallback;
  }
}

/**
 * Atomic write: delegates to the shared atomicWriteFile utility.
 * This ensures readers never see a partially-written file.
 */
async function writeJsonAtomic<T>(filePath: string, data: T): Promise<void> {
  await ensureDataDir();
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json, 0o600);
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

function configPath(): string {
  return process.env['SYNC_CONFIG'] ?? join(dataDir, 'sync-config.json');
}

function projectsPath(): string {
  return join(dataDir, 'projects.json');
}

function historyPath(): string {
  return join(dataDir, 'sync-history.json');
}

function savingsPath(): string {
  return join(dataDir, 'archive-savings.json');
}

function agentsPath(): string {
  return join(dataDir, 'agents.json');
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ServerConfig = {
  port: 9393,
  dataDir: defaultDataDir(),
  storage: null,
  lastTested: null,
  testResult: null,
};

export async function loadConfig(): Promise<ServerConfig> {
  return readJson<ServerConfig>(configPath(), DEFAULT_CONFIG);
}

export async function saveConfig(config: ServerConfig): Promise<void> {
  await writeJsonAtomic(configPath(), config);
}

// ---------------------------------------------------------------------------
// Storage encryption helpers
// ---------------------------------------------------------------------------

export async function encryptStorageConfig(plain: StorageConfig): Promise<EncryptedStorageConfig> {
  return {
    provider: plain.provider,
    endpoint: plain.endpoint,
    bucket: plain.bucket,
    ...(plain.region != null ? { region: plain.region } : {}),
    accessKeyEncrypted: await encrypt(plain.accessKey),
    secretKeyEncrypted: await encrypt(plain.secretKey),
    encryption: plain.encryption ?? false,
    ...(plain.encryptionPassword
      ? { encryptionPasswordEncrypted: await encrypt(plain.encryptionPassword) }
      : {}),
  };
}

export async function decryptStorageConfig(enc: EncryptedStorageConfig): Promise<StorageConfig> {
  return {
    provider: enc.provider,
    endpoint: enc.endpoint,
    bucket: enc.bucket,
    region: enc.region ?? undefined,
    accessKey: await decrypt(enc.accessKeyEncrypted),
    secretKey: await decrypt(enc.secretKeyEncrypted),
    encryption: enc.encryption,
    encryptionPassword: enc.encryptionPasswordEncrypted
      ? await decrypt(enc.encryptionPasswordEncrypted)
      : undefined,
  };
}

/** Return storage config with credentials stripped (for public API responses). */
export function redactStorageConfig(enc: EncryptedStorageConfig): Record<string, unknown> {
  return {
    configured: true,
    provider: enc.provider,
    endpoint: enc.endpoint,
    bucket: enc.bucket,
    region: enc.region ?? null,
    encryption: enc.encryption,
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectsFile {
  projects: Project[];
}

export async function loadProjects(): Promise<Project[]> {
  const data = await readJson<ProjectsFile>(projectsPath(), { projects: [] });
  return data.projects;
}

async function saveProjects(projects: Project[]): Promise<void> {
  await writeJsonAtomic(projectsPath(), { projects });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MAX_PROJECTS = 100;
const MAX_AGENTS = 50;

export async function createProject(input: ProjectCreate): Promise<Project> {
  const projects = await loadProjects();
  const id = slugify(input.name);

  if (!id) {
    throw new Error('Project name must contain at least one alphanumeric character');
  }

  if (projects.length >= MAX_PROJECTS) {
    throw new ConflictError(`Maximum number of projects (${MAX_PROJECTS}) reached`);
  }

  if (projects.some((p) => p.id === id)) {
    throw new ConflictError(`Project with id "${id}" already exists`);
  }

  const now = new Date().toISOString();
  const project: Project = {
    id,
    name: input.name,
    remotePath: input.remotePath ?? `projects/${id}`,
    direction: input.direction,
    includes: input.includes,
    excludes: input.excludes,
    schedule: input.schedule,
    encrypted: input.encrypted,
    // Encrypt the per-project encryption password at rest if provided
    ...(input.encryptionPassword
      ? { encryptionPasswordEncrypted: await encrypt(input.encryptionPassword) }
      : {}),
    conflictStrategy: input.conflictStrategy,
    watch: input.watch,
    trigger: input.trigger,
    watchDebounceMs: input.watchDebounceMs,
    ...(input.bandwidthLimit ? { bandwidthLimit: input.bandwidthLimit } : {}),
    ...(input.softDelete ? { softDelete: input.softDelete } : {}),
    status: 'local-only',
    lastSync: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  projects.push(project);
  await saveProjects(projects);
  return project;
}

export async function loadActiveProjects(): Promise<Project[]> {
  const projects = await loadProjects();
  return projects.filter((p) => !p.deletedAt);
}

export async function getProject(projectId: string, includeDeleted = false): Promise<Project> {
  const projects = await loadProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  if (!includeDeleted && project.deletedAt) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  return project;
}

export async function updateProject(projectId: string, update: ProjectUpdate): Promise<Project> {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }

  const existing = projects[idx]!;

  // Reject updates on soft-deleted projects
  if (existing.deletedAt) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }

  // Handle encryption password separately: encrypt at rest, then remove
  // the plaintext field from the update object before spreading.
  const { encryptionPassword, ...restUpdate } = update;

  const updated: Project = {
    ...existing,
    ...stripUndefined(restUpdate),
    // If a new encryption password is provided, encrypt it at rest
    ...(encryptionPassword !== undefined
      ? { encryptionPasswordEncrypted: await encrypt(encryptionPassword) }
      : {}),
    // If encryption is being disabled, clear the stored password
    ...(update.encrypted === false ? { encryptionPasswordEncrypted: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };

  projects[idx] = updated;
  await saveProjects(projects);
  return updated;
}

/**
 * Update a project's runtime status and lastSync timestamp.
 * This is separate from updateProject which handles user-editable fields.
 */
export async function updateProjectStatus(
  projectId: string,
  status: Project['status'],
  lastSync?: string,
): Promise<void> {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) return; // best-effort, don't throw

  const existing = projects[idx]!;
  projects[idx] = {
    ...existing,
    status,
    lastSync: lastSync ?? existing.lastSync,
    updatedAt: new Date().toISOString(),
  };
  await saveProjects(projects);
}

export async function softDeleteProject(projectId: string): Promise<void> {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  const existing = projects[idx]!;
  if (existing.deletedAt) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  const now = new Date().toISOString();
  projects[idx] = {
    ...existing,
    deletedAt: now,
    updatedAt: now,
  };
  await saveProjects(projects);
}

export async function hardDeleteProject(projectId: string): Promise<void> {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  projects.splice(idx, 1);
  await saveProjects(projects);
}

export async function restoreProject(projectId: string): Promise<Project> {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new NotFoundError(`Project "${projectId}" not found`);
  }
  const existing = projects[idx]!;
  if (!existing.deletedAt) {
    throw new ConflictError(`Project "${projectId}" is not deleted`);
  }
  const restored: Project = {
    ...existing,
    deletedAt: null,
    status: 'local-only',
    updatedAt: new Date().toISOString(),
  };
  projects[idx] = restored;
  await saveProjects(projects);
  return restored;
}

export async function purgeExpiredProjects(retentionDays: number): Promise<number> {
  const projects = await loadProjects();
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const toKeep: Project[] = [];
  let purged = 0;

  for (const p of projects) {
    if (p.deletedAt && new Date(p.deletedAt).getTime() < cutoff) {
      purged++;
    } else {
      toKeep.push(p);
    }
  }

  if (purged > 0) {
    await saveProjects(toKeep);
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Sync history
// ---------------------------------------------------------------------------

const MAX_HISTORY_PER_PROJECT = 100;

interface HistoryFile {
  operations: SyncOperation[];
}

export async function loadHistory(): Promise<SyncOperation[]> {
  const data = await readJson<HistoryFile>(historyPath(), { operations: [] });
  return data.operations;
}

async function saveHistory(operations: SyncOperation[]): Promise<void> {
  await writeJsonAtomic(historyPath(), { operations });
}

export async function addHistoryEntry(entry: SyncOperation): Promise<void> {
  const operations = await loadHistory();
  operations.unshift(entry);

  // Cap per-project
  const perProject = new Map<string, number>();
  const capped = operations.filter((op) => {
    const count = perProject.get(op.projectId) ?? 0;
    if (count >= MAX_HISTORY_PER_PROJECT) return false;
    perProject.set(op.projectId, count + 1);
    return true;
  });

  await saveHistory(capped);
}

export async function updateHistoryEntry(
  operationId: string,
  update: Partial<SyncOperation>,
): Promise<boolean> {
  const operations = await loadHistory();
  const idx = operations.findIndex((op) => op.id === operationId);
  if (idx !== -1 && operations[idx]) {
    operations[idx] = { ...operations[idx], ...update } as SyncOperation;
    await saveHistory(operations);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Active operations (in-memory only)
// ---------------------------------------------------------------------------

const activeOperations = new Map<string, ActiveOperation>();

export function getActiveOperation(projectId: string): ActiveOperation | undefined {
  return activeOperations.get(projectId);
}

export function setActiveOperation(op: ActiveOperation): void {
  activeOperations.set(op.projectId, op);
}

export function clearActiveOperation(projectId: string): void {
  activeOperations.delete(projectId);
}

export function getAllActiveOperations(): ActiveOperation[] {
  return Array.from(activeOperations.values());
}

// ---------------------------------------------------------------------------
// Archive savings tracking
// ---------------------------------------------------------------------------

interface SavingsFile {
  savings: ArchiveSavings[];
}

export async function loadSavings(): Promise<ArchiveSavings[]> {
  const data = await readJson<SavingsFile>(savingsPath(), { savings: [] });
  return data.savings;
}

async function saveSavings(savings: ArchiveSavings[]): Promise<void> {
  await writeJsonAtomic(savingsPath(), { savings });
}

/**
 * Record savings from an archive operation.
 * If the project already has savings tracked, the values are replaced
 * (an archive fully replaces local files, so cumulative addition isn't appropriate).
 */
export async function upsertSavings(entry: ArchiveSavings): Promise<void> {
  const savings = await loadSavings();
  const idx = savings.findIndex((s) => s.projectId === entry.projectId);
  if (idx !== -1) {
    savings[idx] = entry;
  } else {
    savings.push(entry);
  }
  await saveSavings(savings);
}

/**
 * Remove savings tracking for a project (e.g., after restore).
 */
export async function clearSavings(projectId: string): Promise<void> {
  const savings = await loadSavings();
  const filtered = savings.filter((s) => s.projectId !== projectId);
  if (filtered.length !== savings.length) {
    await saveSavings(filtered);
  }
}

/**
 * Get savings for a specific project.
 */
export async function getProjectSavings(projectId: string): Promise<ArchiveSavings | null> {
  const savings = await loadSavings();
  return savings.find((s) => s.projectId === projectId) ?? null;
}

/**
 * Get aggregate savings across all projects.
 */
export async function getAggregateSavings(): Promise<{
  totalArchivedFiles: number;
  totalArchivedBytes: number;
  totalBytesSaved: number;
  projects: number;
}> {
  const savings = await loadSavings();
  let totalArchivedFiles = 0;
  let totalArchivedBytes = 0;
  let totalBytesSaved = 0;
  for (const s of savings) {
    totalArchivedFiles += s.archivedFileCount;
    totalArchivedBytes += s.archivedTotalBytes;
    totalBytesSaved += s.bytesSaved;
  }
  return {
    totalArchivedFiles,
    totalArchivedBytes,
    totalBytesSaved,
    projects: savings.length,
  };
}

// ---------------------------------------------------------------------------
// Agent registry (multi-agent support)
// ---------------------------------------------------------------------------

interface AgentsFile {
  agents: RegisteredAgent[];
}

export async function loadAgents(): Promise<RegisteredAgent[]> {
  const data = await readJson<AgentsFile>(agentsPath(), { agents: [] });
  return data.agents;
}

async function saveAgents(agents: RegisteredAgent[]): Promise<void> {
  await writeJsonAtomic(agentsPath(), { agents });
}

/** Result of agent registration, including the raw token (shown once). */
export interface AgentRegistrationResult {
  agent: RegisteredAgent;
  /** Raw agent token — returned only on registration. Must be saved by the agent. */
  agentToken: string;
}

/**
 * Register a new agent or re-register an existing one.
 *
 * If an agent with the same hostname and name already exists, it is
 * updated (re-registration) and a new token is generated.
 * Otherwise, a new agent record is created.
 *
 * Returns the registered agent and a unique authentication token.
 * The raw token is only returned once — only the hash is persisted.
 */
export async function registerAgent(input: AgentRegister): Promise<AgentRegistrationResult> {
  const agents = await loadAgents();
  const now = new Date().toISOString();

  // Generate a unique agent token
  const agentToken = `agent_${randomBytes(16).toString('hex')}`;
  const agentTokenHash = createHash('sha256').update(agentToken).digest('hex');

  // Check for existing agent with same name + hostname (re-registration)
  const existingIdx = agents.findIndex(
    (a) => a.name === input.name && a.hostname === input.hostname,
  );

  if (existingIdx !== -1) {
    const existing = agents[existingIdx]!;
    const updated: RegisteredAgent = {
      ...existing,
      os: input.os,
      osVersion: input.osVersion,
      nodeVersion: input.nodeVersion,
      agentVersion: input.agentVersion,
      projectIds: input.projectIds,
      lastHeartbeat: now,
      agentTokenHash,
      activeSyncs: [],
    };
    agents[existingIdx] = updated;
    await saveAgents(agents);
    return { agent: updated, agentToken };
  }

  // New agent registration — check capacity
  if (agents.length >= MAX_AGENTS) {
    throw new ConflictError(`Maximum number of agents (${MAX_AGENTS}) reached`);
  }

  const agent: RegisteredAgent = {
    id: randomUUID(),
    name: input.name,
    hostname: input.hostname,
    os: input.os,
    osVersion: input.osVersion,
    nodeVersion: input.nodeVersion,
    agentVersion: input.agentVersion,
    projectIds: input.projectIds,
    lastHeartbeat: now,
    registeredAt: now,
    agentTokenHash,
    activeSyncs: [],
  };

  agents.push(agent);
  await saveAgents(agents);
  return { agent, agentToken };
}

/**
 * Get a registered agent by ID.
 */
export async function getAgent(agentId: string): Promise<RegisteredAgent> {
  const agents = await loadAgents();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }
  return agent;
}

/**
 * Verify an agent token against the stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyAgentToken(agentId: string, token: string): Promise<boolean> {
  const agents = await loadAgents();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent || !agent.agentTokenHash) {
    return false;
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const tokenBuf = Buffer.from(tokenHash, 'hex');
  const storedBuf = Buffer.from(agent.agentTokenHash, 'hex');
  if (tokenBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(tokenBuf, storedBuf);
}

/**
 * Update agent heartbeat and optional status information.
 */
export async function updateAgentHeartbeat(
  agentId: string,
  heartbeat: AgentHeartbeat,
): Promise<RegisteredAgent> {
  const agents = await loadAgents();
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx === -1) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }

  const existing = agents[idx]!;
  const updated: RegisteredAgent = {
    ...existing,
    lastHeartbeat: new Date().toISOString(),
    activeSyncs: heartbeat.activeSyncs,
    ...(heartbeat.diskUsage ? { diskUsage: heartbeat.diskUsage } : {}),
  };

  agents[idx] = updated;
  await saveAgents(agents);
  return updated;
}

/**
 * Remove a registered agent.
 */
export async function removeAgent(agentId: string): Promise<void> {
  const agents = await loadAgents();
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx === -1) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }
  agents.splice(idx, 1);
  await saveAgents(agents);
}

/**
 * Determine agent status based on heartbeat freshness.
 */
export function getAgentStatus(agent: RegisteredAgent): 'online' | 'offline' {
  const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
  const elapsed = Date.now() - lastHeartbeat;
  return elapsed <= AGENT_HEARTBEAT_TIMEOUT_MS ? 'online' : 'offline';
}

/**
 * Update the project assignments for an agent.
 */
export async function updateAgentProjects(
  agentId: string,
  projectIds: string[],
): Promise<RegisteredAgent> {
  const agents = await loadAgents();
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx === -1) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }

  const existing = agents[idx]!;
  const updated: RegisteredAgent = {
    ...existing,
    projectIds,
  };

  agents[idx] = updated;
  await saveAgents(agents);
  return updated;
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
