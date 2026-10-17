#!/usr/bin/env node

/**
 * Script to prepare DuckDB WASM binaries and worker scripts in out/
 *
 * 1. Copies WASM binaries (duckdb-eh.wasm, duckdb-mvp.wasm).
 * 2. Bundles duckdb-node.cjs and worker scripts using esbuild so that
 *    runtime dependencies like `apache-arrow` are inlined and self-contained.
 *    Without this, installing the extension via .vsix fails with:
 *    "Cannot find module 'apache-arrow'" because node_modules is excluded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');

const require = createRequire(import.meta.url);
const duckdbDist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node.cjs'));

fs.mkdirSync(OUT_DIR, { recursive: true });

// 1. Copy WASM binaries if missing or size differs
const wasmFiles = ['duckdb-eh.wasm', 'duckdb-mvp.wasm'];
for (const file of wasmFiles) {
  const src = path.join(duckdbDist, file);
  const dest = path.join(OUT_DIR, file);
  if (!fs.existsSync(dest) || fs.statSync(src).size !== fs.statSync(dest).size) {
    fs.copyFileSync(src, dest);
  }
}

// 2. Bundle duckdb-node.cjs and worker scripts
const isMinify = process.argv.includes('--minify') || process.argv.includes('--prod');

await esbuild.build({
  entryPoints: {
    'duckdb-node': path.join(duckdbDist, 'duckdb-node.cjs'),
    'duckdb-node-eh.worker': path.join(duckdbDist, 'duckdb-node-eh.worker.cjs'),
    'duckdb-node-mvp.worker': path.join(duckdbDist, 'duckdb-node-mvp.worker.cjs'),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: OUT_DIR,
  outExtension: { '.js': '.cjs' },
  minify: isMinify,
  logOverride: {
    'direct-eval': 'silent',
  },
});
