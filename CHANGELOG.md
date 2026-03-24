# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Implement full Sync monorepo: server (Fastify REST API), agent daemon, CLI tool, shared utilities, npx installer
- Add rclone-based bidirectional sync engine with support for 40+ cloud storage providers
- Add archive/restore workflow (iCloud offload pattern) with metadata stub files
- Add project-scoped sync operations with independent async contexts
- Add storage provider credential encryption at rest
- Add rclone config bundle generation with one-time passphrase encryption
- Add atomic file writes (write → fsync → rename) for all state files
- Add path validation: no null bytes, no `..` after normalization, max 4096 characters
- Add sync-desktop Tauri app: project CRUD, storage configuration, agents view, polling
- Add two-VM E2E test infrastructure with MCP orchestration
- Add structured documentation in numbered sections matching Portlama style
