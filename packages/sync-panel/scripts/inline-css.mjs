/**
 * Post-build script: inlines the extracted CSS file into panel.js
 * so the microfrontend is a single self-contained IIFE bundle.
 *
 * The CSS is injected via a <style> element when the plugin mounts
 * and removed when it unmounts.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const distDir = resolve(import.meta.dirname, '..', 'dist');

// Find the CSS file (Vite may name it style.css or similar)
const cssFile = readdirSync(distDir).find((f) => f.endsWith('.css'));
if (!cssFile) {
  console.log('No CSS file found in dist/ — skipping inline');
  process.exit(0);
}

const cssPath = join(distDir, cssFile);
const jsPath = join(distDir, 'panel.js');

const css = readFileSync(cssPath, 'utf-8');
const js = readFileSync(jsPath, 'utf-8');

// Escape CSS for embedding in a JS string
const escapedCss = css
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$');

// Wrap: inject CSS on load, expose removal for unmount
const wrapped = `(function(){
var __syncPanelCss = \`${escapedCss}\`;
var __styleEl;
window.__syncPanelInjectStyles = function() {
  if (__styleEl) return;
  __styleEl = document.createElement('style');
  __styleEl.setAttribute('data-sync-panel', '');
  __styleEl.textContent = __syncPanelCss;
  document.head.appendChild(__styleEl);
};
window.__syncPanelRemoveStyles = function() {
  if (__styleEl) { __styleEl.remove(); __styleEl = null; }
};
})();
${js}`;

writeFileSync(jsPath, wrapped);
unlinkSync(cssPath);

console.log(`Inlined ${cssFile} into panel.js (${Math.round(wrapped.length / 1024)}KB)`);
