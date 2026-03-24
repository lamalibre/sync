# Contributing to Sync

Thank you for considering contributing. This document explains how to get started,
what we care about, and how to submit changes.

## Development Setup

### Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 9+
- rclone (`brew install rclone` on macOS, or see [rclone.org/install](https://rclone.org/install/))

### Getting Started

```bash
git clone https://github.com/lamalibre/sync.git
cd sync
pnpm install
```

### Running the server in development

```bash
export NODE_ENV=development
pnpm dev:server   # Fastify on :9393
```

In development mode, `NODE_ENV=development` disables authentication checks so you
can test the API without certificates.

### Running E2E tests

```bash
pnpm build
bash tests/e2e/run-all.sh
```

## Project Structure

Read `CLAUDE.md` at the root for a full map of packages, conventions, and constraints.

## Code Standards

- **TypeScript strict** — no `any`, no implicit returns
- **ES Modules only** — `import`/`export`, no `require()`
- **Async/await** — no callback-style async
- **execa for shell commands** — never `child_process.exec` or template strings in commands
- **Zod for API validation** — all route body inputs validated with a schema
- **Atomic file writes** — write to temp → fsync → rename for any state file
- **rclone is the only sync engine** — no custom file transfer code

## Pull Request Process

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes
3. Run `pnpm build` and `pnpm lint`
4. Run E2E tests if applicable: `bash tests/e2e/run-all.sh`
5. Submit a PR with a clear description of what changed and why

## PR Checklist

- [ ] No hardcoded secrets or credentials
- [ ] Shell operations use `execa` with array args (not string interpolation)
- [ ] New API routes have Zod validation
- [ ] rclone.conf created with mode 0600
- [ ] CLAUDE.md updated if conventions changed

## Reporting Issues

Use GitHub Issues. For security vulnerabilities, please email us directly rather
than opening a public issue.

## Code of Conduct

Be respectful. We're building infrastructure software — focus on technical merit.
