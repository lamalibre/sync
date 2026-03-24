#!/usr/bin/env node
import { main } from '../dist/index.js';

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
