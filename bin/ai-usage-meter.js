#!/usr/bin/env node
if (!process.argv.includes('--no-open')) process.argv.push('--open');
await import('../server.js');
