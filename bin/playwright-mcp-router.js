#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[playwright-mcp-router] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
