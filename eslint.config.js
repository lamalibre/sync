import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // 1. Global ignores
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.vite/',
      '.claude/worktrees/',
      '**/src-tauri/target/',
      '**/src-tauri/gen/',
      'packages/sync-desktop/',
    ],
  },

  // 2. Base config for all JS/TS files
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // 3. Node.js config for server-side packages
  {
    files: [
      'packages/sync-server/**/*.{ts,mjs}',
      'packages/sync-agent/**/*.{ts,mjs}',
      'packages/sync-cli/**/*.{ts,mjs}',
      'packages/sync-shared/**/*.{ts,mjs}',
      'packages/create-sync/**/*.{ts,mjs}',
      'packages/sync-e2e-mcp/**/*.js',
      'scripts/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // 4. TypeScript unused-vars config (overrides base no-unused-vars for .ts files)
  {
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // 5. JavaScript unused-vars config
  {
    files: ['**/*.{js,mjs}'],
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // 6. Prettier compat — must be last to disable formatting rules
  prettierConfig,
);
