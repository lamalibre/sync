import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        // Compile in DOM mode for the browser bundle
        css: 'injected',
      },
    }),
    tailwindcss(),
  ],
  build: {
    outDir: 'dist',
    lib: {
      entry: 'src/panel.ts',
      formats: ['iife'],
      name: '_syncPanel',
      fileName: () => 'panel.js',
    },
    cssCodeSplit: false,
    minify: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
