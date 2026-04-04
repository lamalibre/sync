import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageDir = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf-8'));

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

await build({
  entryPoints: [resolve(packageDir, 'src/index.ts')],
  outfile: resolve(packageDir, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  banner: {
    js: '// @ts-nocheck — bundled output',
  },
});

console.log(`Built ${pkg.name} → dist/index.js`);

// Sync version from package.json into portlama-plugin.json (single source of truth)
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const pluginManifestPath = resolve(packageDir, 'portlama-plugin.json');
if (existsSync(pluginManifestPath)) {
  const manifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(pluginManifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Synced portlama-plugin.json version → ${pkg.version}`);
  }
}

// Build panel microfrontend bundle if the package has a local panel.ts
const panelEntry = resolve(packageDir, 'src/panel.ts');
if (existsSync(panelEntry)) {
  await build({
    entryPoints: [panelEntry],
    outfile: resolve(packageDir, 'dist/panel.js'),
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    minify: true,
    sourcemap: false,
  });
  console.log(`Built ${pkg.name} → dist/panel.js`);
}

// Copy panel.js from @lamalibre/sync-panel if this package depends on it
// and doesn't have its own panel.ts (sync-server uses sync-panel's output)
if (!existsSync(panelEntry) && pkg.dependencies?.['@lamalibre/sync-panel']) {
  const { createRequire } = await import('node:module');
  const require = createRequire(resolve(packageDir, 'package.json'));
  try {
    const panelPkg = resolve(require.resolve('@lamalibre/sync-panel/panel.js'));
    mkdirSync(resolve(packageDir, 'dist'), { recursive: true });
    copyFileSync(panelPkg, resolve(packageDir, 'dist/panel.js'));
    console.log(`Copied panel.js from @lamalibre/sync-panel → dist/panel.js`);
  } catch {
    console.log('Note: @lamalibre/sync-panel panel.js not found — build sync-panel first');
  }
}
