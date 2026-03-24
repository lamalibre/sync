import { defineConfig } from 'vitepress';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sidebar;
try {
  sidebar = JSON.parse(readFileSync(resolve(__dirname, 'sidebar.json'), 'utf-8'));
} catch {
  console.warn('sidebar.json not found — run "node prepare.js" first');
  sidebar = [];
}

export default defineConfig({
  title: 'Sync',
  description: 'File synchronization and cloud archive tool — rclone-based bidirectional sync with archive/restore support',

  // GitHub Pages deploys to https://<org>.github.io/sync/
  base: '/sync/',

  srcDir: resolve(__dirname, '..', 'src'),
  outDir: resolve(__dirname, 'dist'),

  themeConfig: {
    siteTitle: 'Sync',

    sidebar,

    nav: [
      { text: 'Guide', link: '/00-introduction/what-is-sync' },
      { text: 'API Reference', link: '/04-api-reference/overview' },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/lamalibre/sync' }],

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/lamalibre/sync/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the PolyForm Noncommercial License 1.0.0',
      copyright: 'Copyright 2026 Code Lama Software',
    },

    outline: {
      level: [2, 3],
    },
  },

  ignoreDeadLinks: true,
});
