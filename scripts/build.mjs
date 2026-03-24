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
