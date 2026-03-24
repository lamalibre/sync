#!/usr/bin/env node

/**
 * Prepares the VitePress source directory:
 * 1. Copies markdown docs from docs/ into website/src/
 * 2. Generates the sidebar config from _index.json
 * 3. Writes the landing page (index.md)
 *
 * Run before `vitepress build` or `vitepress dev`.
 */

import {
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsSource = resolve(__dirname, '..', 'docs');
const srcDir = resolve(__dirname, 'src');

// 1. Clean and copy docs into src/
rmSync(srcDir, { recursive: true, force: true });
mkdirSync(srcDir, { recursive: true });
cpSync(docsSource, srcDir, { recursive: true });

// Remove _index.json from the copy (not a page)
rmSync(resolve(srcDir, '_index.json'), { force: true });
// Remove docs README (replaced by landing page)
rmSync(resolve(srcDir, 'README.md'), { force: true });

console.log('Copied docs into website/src/');

// 2. Generate sidebar from _index.json
const index = JSON.parse(readFileSync(resolve(docsSource, '_index.json'), 'utf-8'));

const sidebar = index.sections.map((section) => ({
  text: section.title,
  items: section.pages.map((page) => ({
    text: page.title,
    link: `/${page.file.replace(/\.md$/, '')}`,
  })),
}));

const sidebarPath = resolve(__dirname, '.vitepress', 'sidebar.json');
writeFileSync(sidebarPath, JSON.stringify(sidebar, null, 2) + '\n');
console.log(`Wrote ${sidebar.length} sidebar sections`);

// 3. Write landing page
const landingPage = `---
layout: home

hero:
  name: Sync
  text: File synchronization & cloud archive
  tagline: rclone-based bidirectional sync with archive/restore support. Standalone or as a Portlama plugin.
  actions:
    - theme: brand
      text: Get Started
      link: /00-introduction/what-is-sync
    - theme: alt
      text: Quick Start
      link: /00-introduction/quickstart
    - theme: alt
      text: API Reference
      link: /04-api-reference/overview

features:
  - title: rclone-Powered
    details: 40+ cloud providers out of the box. S3, Google Drive, Dropbox, OneDrive, and more — all through rclone.
  - title: Bidirectional Sync
    details: Push, pull, or bidirectional sync per project. File watching with automatic triggers or cron schedules.
  - title: Archive & Restore
    details: Offload files to cloud storage, leaving lightweight stubs behind. Restore on demand — like iCloud offloading.
  - title: Encryption at Rest
    details: Optional per-project encryption via rclone crypt. Credentials encrypted on the server, never in logs.
---
`;

writeFileSync(resolve(srcDir, 'index.md'), landingPage);
console.log('Wrote landing page');
