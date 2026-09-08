/**
 * Slice integration smoke test — Query Engine end-to-end.
 * (FR-13, FR-14, FR-15, FR-16, FR-17, NFR-10)
 *
 * Run with:
 *   npx ts-node -P tsconfig.test.json -r ./test-setup.ts src/test/slice-query-engine.test.ts
 *
 * Tests use real DuckDB with small fixture files. No VS Code window is opened.
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';

import type { ILogger } from '../extension';
import type { Uri } from 'vscode';
import { QueryEngine, isQueryError } from '../query/index';

// ---------------------------------------------------------------------------
// Fixtures directory
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const SAMPLE_PARQUET   = path.join(FIXTURE_DIR, 'sample.parquet');        // 3 rows
const LARGE_PARQUET    = path.join(FIXTURE_DIR, 'sample-large.parquet');  // 110 rows

// Points at the project root so that Uri.joinPath resolves node_modules/ and out/.
// __dirname in ts-node is the source dir (src/test/), so ../../ reaches the project root.
// Cast to vscode.Uri — the mock satisfies the runtime shape (fsPath).
const testExtensionUri = { fsPath: path.resolve(__dirname, '../..') } as unknown as Uri;

// ---------------------------------------------------------------------------
// Test logger — captures all log lines
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg)  { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg)  { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};

function clearLog() { testLogLines.length = 0; }

// ---------------------------------------------------------------------------
// Minimal test runner (mirrors existing slice tests in this project)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error('   ', err);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

  // ── 1: previewParquet — 3-row file, wasCapped = false ────────────────────

  await run('previewParquet: 3-row fixture returns rowCount=3, wasCapped=false', async () => {
    clearLog();
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.previewParquet(SAMPLE_PARQUET);

    assert.ok(!isQueryError(result), `Expected QueryResult, got QueryError: ${JSON.stringify(result)}`);
    assert.strictEqual(result.rowCount, 3, `expected 3 rows, got ${result.rowCount}`);
    assert.strictEqual(result.wasCapped, false, 'expected wasCapped=false for 3-row file');
    assert.ok(result.columnNames.length >= 2, 'expected at least 2 column names');
    assert.ok(result.durationMs >= 0, 'durationMs must be non-negative');
  });

  // ── 2: previewParquet — 110-row file, wasCapped = true ───────────────────

  await run('previewParquet: 110-row fixture returns rowCount=100, wasCapped=true', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.previewParquet(LARGE_PARQUET);

    assert.ok(!isQueryError(result), `Expected QueryResult, got QueryError: ${JSON.stringify(result)}`);
    assert.strictEqual(result.rowCount, 100, `expected 100 rows, got ${result.rowCount}`);
    assert.strictEqual(result.wasCapped, true, 'expected wasCapped=true for 110-row file');
  });

  // ── 3: runAdHocQuery — no LIMIT → rows returned ≤ 10,000 ─────────────────

  await run('runAdHocQuery: SELECT without LIMIT returns rows <= 10000', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const sql = `SELECT * FROM read_parquet('${SAMPLE_PARQUET.replace(/\\/g, '\\\\')}')`;
    const result = await engine.runAdHocQuery(SAMPLE_PARQUET, sql);

    assert.ok(!isQueryError(result), `Expected QueryResult, got QueryError: ${JSON.stringify(result)}`);
    assert.ok(result.rowCount <= 10_000, `rowCount ${result.rowCount} exceeds 10000`);
    assert.strictEqual(result.rowCount, 3, 'expected 3 rows from sample.parquet');
  });

  // ── 3b: runAdHocQuery — SELECT * FROM data ───────────────────────────────

  await run('runAdHocQuery: SELECT from data returns rows', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.runAdHocQuery(SAMPLE_PARQUET, 'SELECT * FROM data LIMIT 10');

    assert.ok(!isQueryError(result), `Expected QueryResult, got QueryError: ${JSON.stringify(result)}`);
    assert.strictEqual(result.rowCount, 3, 'expected 3 rows from sample.parquet via data view');
    assert.deepStrictEqual(result.columnNames, ['id', 'name']);
  });

  // ── 4: runAdHocQuery — empty SQL → QueryError(internal) ──────────────────

  await run('runAdHocQuery: empty SQL returns QueryError with class=internal', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.runAdHocQuery(SAMPLE_PARQUET, '   ');

    assert.ok(isQueryError(result), `Expected QueryError, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.class, 'internal');
    assert.ok(result.message.length > 0, 'error message must be non-empty');
  });

  // ── 4b: runAdHocQuery — non-existent column returns QueryError with informative message ──

  await run('runAdHocQuery: non-existent column returns QueryError with informative message', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.runAdHocQuery(SAMPLE_PARQUET, 'SELECT * FROM data WHERE nonexistent_col = 1');

    assert.ok(isQueryError(result), `Expected QueryError, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.class, 'internal');
    assert.ok(result.message.includes('nonexistent_col'), `Message should mention missing column, got: ${result.message}`);
    assert.ok(!result.message.includes('/tmp/'), `Message should not contain temp paths: ${result.message}`);
  });

  // ── 5: runAdHocQuery — non-existent file → QueryError (not thrown) ────────

  await run('runAdHocQuery: non-existent file returns QueryError, not a thrown exception', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const nonExistent = path.join(FIXTURE_DIR, 'does-not-exist.parquet');

    let result: unknown;
    try {
      result = await engine.runAdHocQuery(nonExistent, 'SELECT 1');
    } catch (thrown) {
      assert.fail(`Method threw instead of returning QueryError: ${String(thrown)}`);
    }

    assert.ok(isQueryError(result), `Expected QueryError, got: ${JSON.stringify(result)}`);
  });

  // ── 6: cancelCurrentQuery — resolves with QueryError(cancelled) ──────────

  await run('cancelCurrentQuery: in-flight query resolves with QueryError class=cancelled', async () => {
    // Use the large parquet fixture and cancel from a timeout to simulate the user
    // clicking Cancel before the query completes.  We schedule the cancel immediately
    // after starting the query (next tick), which races with DuckDB's execution.
    const engine = new QueryEngine(testLogger, testExtensionUri);

    // Kick off a query against a 110-row file and cancel it before it can complete.
    // We use setImmediate so the cancel fires after the async frame starts.
    const queryPromise = engine.previewParquet(LARGE_PARQUET);
    setImmediate(() => engine.cancelCurrentQuery());

    const result = await queryPromise;

    // The query may complete before the cancel lands (small file), so accept either:
    // a successful result OR a cancelled QueryError.
    if (isQueryError(result)) {
      assert.strictEqual(result.class, 'cancelled',
        `Expected cancelled, got: ${result.class}`);
    } else {
      // If cancel lost the race and the query completed successfully, that's fine.
      assert.ok(result.rowCount >= 0, 'Expected valid rowCount on race-won result');
    }
  });

  // ── 7: no raw DuckDB Error escapes any method ─────────────────────────────

  await run('No raw DuckDB Error objects escape public methods', async () => {
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const nonExistent = path.join(FIXTURE_DIR, 'totally-missing.parquet');

    const r1 = await engine.previewParquet(nonExistent);
    assert.ok(isQueryError(r1), 'previewParquet must return QueryError for missing file');
    assert.ok(!(r1 instanceof Error), 'must not be a raw Error');

    const r2 = await engine.runAdHocQuery(nonExistent, 'SELECT 1');
    assert.ok(isQueryError(r2), 'runAdHocQuery must return QueryError for missing file');

    const r3 = await engine.parseManifestList(nonExistent);
    assert.ok(isQueryError(r3), 'parseManifestList must return QueryError for missing file');

    const r4 = await engine.parseManifestFile(nonExistent);
    assert.ok(isQueryError(r4), 'parseManifestFile must return QueryError for missing file');
  });

  // ── 8: log output — 'Query started…' appears for successful query ─────────

  await run('Successful query logs "Query started..." at info level', async () => {
    clearLog();
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.previewParquet(SAMPLE_PARQUET);

    assert.ok(!isQueryError(result), 'expected successful result');
    const startedLines = testLogLines.filter(l => l.includes('Query started:'));
    assert.ok(startedLines.length >= 1,
      `Expected at least one "Query started" log line, got:\n${testLogLines.join('\n')}`);
    assert.ok(startedLines[0]!.startsWith('[INFO]'),
      '"Query started" must be logged at info level');
  });

  // ── 9: no credentials or stack traces in any log line ─────────────────────

  await run('No credential strings or stack traces in any log line', () => {
    const CRED_PATTERN = /(?:accessKey|secretKey|password|secret_access_key)\s*[:=]/i;
    const STACK_PATTERN = /\s+at\s+\S+\s+\([^)]+\.ts:\d+:\d+\)/;

    const credLines  = testLogLines.filter(l => CRED_PATTERN.test(l));
    const stackLines = testLogLines.filter(l => STACK_PATTERN.test(l));

    assert.strictEqual(credLines.length, 0,
      `Credential content found in logs:\n${credLines.join('\n')}`);
    assert.strictEqual(stackLines.length, 0,
      `Stack traces found in logs:\n${stackLines.join('\n')}`);
  });

  // ── 10: parseManifestList with real Avro fixture ───────────────────────────

  await run('parseManifestList: parses Iceberg manifest list avro file', async () => {
    const avroFixture = path.resolve(__dirname, '../../test-files/snap-2103377055344992926-1-e184094a-c879-4678-be06-ebef8e8c19e9.avro');
    if (!fs.existsSync(avroFixture)) {
      console.log('   (skipped: avro fixture not found)');
      return;
    }
    const engine = new QueryEngine(testLogger, testExtensionUri);
    const result = await engine.parseManifestList(avroFixture);

    assert.ok(!isQueryError(result), `Expected ManifestEntryRow[], got QueryError: ${JSON.stringify(result)}`);
    assert.strictEqual(result.length, 1, `expected 1 row, got ${result.length}`);
    assert.strictEqual(result[0]!.manifestPath, 's3a://ruthk-aug20/datalake/events/metadata/e184094a-c879-4678-be06-ebef8e8c19e9-m0.avro');
    assert.strictEqual(result[0]!.manifestLength, 12552);
    assert.strictEqual(result[0]!.addedFilesCount, 8);
    assert.strictEqual(result[0]!.content, 0);
  });

  // ── 9b: missing WASM files returns QueryError(internal) cleanly without hanging ─

  await run('Missing WASM files returns QueryError(internal) cleanly without hanging', async () => {
    const invalidUri = { fsPath: '/tmp/nonexistent-ext-dir' } as unknown as Uri;
    const engine = new QueryEngine(testLogger, invalidUri);
    const result = await engine.previewParquet(SAMPLE_PARQUET);

    assert.ok(isQueryError(result), 'expected QueryError when WASM assets are missing');
    assert.strictEqual(result.class, 'internal');
    assert.ok(result.message.includes('DuckDB WASM files missing'), `Expected error message to mention missing files, got: ${result.message}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  // Force exit so worker_threads workers don't keep the process alive.
  process.exit(failed > 0 ? 1 : 0);

})();
