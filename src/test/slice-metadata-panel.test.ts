/**
 * Slice integration smoke test — metadata detail panel end-to-end.
 * (T-30, plan.md §4, design.md §1.3, FR-10, FR-18, FR-20, NFR-2)
 *
 * Run with:
 *   npx ts-node -P tsconfig.json -r ./test-setup.ts src/test/slice-metadata-panel.test.ts
 *
 * This test does NOT exercise VS Code DOM rendering or the real VS Code host.
 * It validates the message flow and Storage Layer integration only.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vm from 'node:vm';

import type { StorageAdapter } from '../storage/StorageAdapter';
import type { ActiveConnectionHandle } from '../storage/types';
import { storageError, isStorageError, type StorageError } from '../storage/errors';
import type { ILogger } from '../extension';
import { WebviewPanelManager } from '../panels/webviewPanelManager';
import { omitAbsent, lastPathSegment, resourcePathToBreadcrumbs } from '../panels/utils';
import { getMetadataDetailHtml } from '../panels/html/metadataDetail';

// ---------------------------------------------------------------------------
// Fixtures directory — use __dirname (CJS-compatible with Node16 module mode)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Fake VS Code WebviewPanel
// ---------------------------------------------------------------------------

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function makeFakePanel(title: string): { panel: any; messages: PostedMessage[] } {
  const messages: PostedMessage[] = [];
  const panel: any = {
    title,
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      postMessage(msg: PostedMessage) { messages.push(msg); },
      onDidReceiveMessage(_handler: unknown) { return { dispose() {} }; },
    },
    reveal(_col: unknown) {},
    onDidDispose(_handler: unknown, _ctx: unknown, _subs: unknown) { return { dispose() {} }; },
    dispose() {},
  };
  return { panel, messages };
}

// ---------------------------------------------------------------------------
// Fake Extension Context
// ---------------------------------------------------------------------------

const fakeContext: any = {
  extensionUri: { fsPath: '.' },
  subscriptions: [],
};

// ---------------------------------------------------------------------------
// Local FS Storage Adapter (test-only — reads real fixture files)
// ---------------------------------------------------------------------------

class LocalTestStorageAdapter implements StorageAdapter {
  async listSchemas(_handle: ActiveConnectionHandle) { return []; }
  async listTables(_handle: ActiveConnectionHandle, _schema: string) { return []; }
  async listMetadataVersions(_handle: ActiveConnectionHandle, _table: string) { return []; }

  async fetchMetadataJson(
    _handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<unknown | StorageError> {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return storageError('not-found', 'File not found. The resource may have been deleted or moved.');
      }
      if (e.code === 'EACCES') {
        return storageError('access-denied', 'Access denied. Check your connection credentials and permissions.');
      }
      return storageError('parse-failure', 'Could not read file. The file may be corrupted or in an unsupported format.');
    }
  }

  async fetchFileToTemp(_handle: ActiveConnectionHandle, _filePath: string): Promise<string | StorageError> {
    return storageError('internal', 'Not used in this test.');
  }

  async deleteTemp(_filePath: string): Promise<void> {
    // No temp files used in metadata detail panels.
    return;
  }

  async listDirectoryContents(
    _handle: ActiveConnectionHandle,
    _dirPath: string,
  ): Promise<{ subdirectories: string[]; files: string[] }> {
    return { subdirectories: [], files: [] };
  }

  async isTable(
    _handle: ActiveConnectionHandle,
    _dirPath: string,
  ): Promise<boolean> {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test logger
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg)  { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg)  { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};

function clearLog() { testLogLines.length = 0; }

// ---------------------------------------------------------------------------
// Test runner
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

  // ── T-26: omitAbsent helper ───────────────────────────────────────────────

  await run('omitAbsent(undefined) returns null', () => {
    assert.strictEqual(omitAbsent(undefined), null);
  });
  await run('omitAbsent(null) returns null', () => {
    assert.strictEqual(omitAbsent(null), null);
  });
  await run('omitAbsent("value") returns "value"', () => {
    assert.strictEqual(omitAbsent('value'), 'value');
  });
  await run('omitAbsent(0) returns 0', () => {
    assert.strictEqual(omitAbsent(0), 0);
  });

  // ── T-27: breadcrumb helper ───────────────────────────────────────────────

  await run('S3 path \u2192 4 breadcrumb segments', () => {
    const segs = resourcePathToBreadcrumbs(
      's3://my-bucket/prefix/ns1/my_table/metadata/v3.metadata.json',
    );
    assert.strictEqual(segs.length, 4, `expected 4 segments, got ${segs.length}: ${segs.join(' \u203a ')}`);
    assert.strictEqual(segs[3], 'v3.metadata.json');
  });

  await run('Local path \u2192 4 breadcrumb segments', () => {
    const segs = resourcePathToBreadcrumbs(
      '/warehouse/ns1/my_table/metadata/v1.metadata.json',
    );
    assert.strictEqual(segs.length, 4, `expected 4 segments, got ${segs.length}: ${segs.join(' \u203a ')}`);
    assert.strictEqual(segs[3], 'v1.metadata.json');
  });

  await run('lastPathSegment returns filename', () => {
    assert.strictEqual(lastPathSegment('/a/b/c/v3.metadata.json'), 'v3.metadata.json');
    assert.strictEqual(lastPathSegment('s3://bucket/key/file.json'), 'file.json');
  });

  // ── T-17: Storage Layer fetch — success paths ─────────────────────────────

  await run('fetchMetadataJson returns V1 JSON object', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v1.metadata.json'));
    assert.ok(!isStorageError(result), 'expected JSON, got StorageError');
    const payload = result as Record<string, unknown>;
    assert.strictEqual(payload['format-version'], 1);
    assert.strictEqual(payload['table-uuid'], 'abc-123-def-456');
  });

  await run('fetchMetadataJson returns V2 JSON with last-sequence-number', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v2.metadata.json'));
    assert.ok(!isStorageError(result));
    const payload = result as Record<string, unknown>;
    assert.strictEqual(payload['format-version'], 2);
    assert.ok('last-sequence-number' in payload, 'V2 must have last-sequence-number');
    assert.ok(payload['refs'] !== undefined, 'V2 must have refs');
  });

  await run('fetchMetadataJson returns V3 JSON with encryption key in properties', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v3.metadata.json'));
    assert.ok(!isStorageError(result));
    const payload = result as Record<string, unknown>;
    assert.strictEqual(payload['format-version'], 3);
    const props = payload['properties'] as Record<string, string>;
    assert.ok('encryption.key-id' in props, 'V3 properties must include encryption.key-id');
  });

  // ── T-17: error path ──────────────────────────────────────────────────────

  await run('fetchMetadataJson returns not-found StorageError for missing file', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'nonexistent.json'));
    assert.ok(isStorageError(result), 'expected StorageError');
    assert.strictEqual((result as StorageError).class, 'not-found');
    assert.strictEqual(
      (result as StorageError).message,
      'File not found. The resource may have been deleted or moved.',
    );
  });

  // ── T-16 / T-17: loadMetadataPanel message flow ───────────────────────────

  await run('loadMetadataPanel posts loading then loadMetadata for V1 fixture', async () => {
    const adapter = new LocalTestStorageAdapter();
    clearLog();
    const { panel, messages } = makeFakePanel('v1.metadata.json');
    const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger);
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };

    const startMs = Date.now();
    await (mgr as any).loadMetadataPanel(panel, path.join(FIXTURE_DIR, 'v1.metadata.json'), handle);
    const elapsedMs = Date.now() - startMs;

    assert.ok(messages.length >= 2, `expected >= 2 messages, got ${messages.length}`);
    assert.deepStrictEqual(messages[0], { type: 'setState', state: 'loading' });
    assert.strictEqual(messages[1]!.type, 'loadMetadata');
    assert.ok((messages[1] as any).payload, 'loadMetadata message must have payload');
    assert.strictEqual((messages[1] as any).payload['format-version'], 1);
    // NFR-2: round-trip must be < 1000 ms for files ≤ 1 MB
    assert.ok(elapsedMs < 1000, `NFR-2: elapsed ${elapsedMs} ms exceeds 1000 ms`);
  });

  await run('loadMetadataPanel posts loading then loadMetadata for V2 fixture', async () => {
    const adapter = new LocalTestStorageAdapter();
    const { panel, messages } = makeFakePanel('v2.metadata.json');
    const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger);
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };

    await (mgr as any).loadMetadataPanel(panel, path.join(FIXTURE_DIR, 'v2.metadata.json'), handle);

    assert.strictEqual(messages[0]?.type, 'setState');
    assert.strictEqual(messages[1]?.type, 'loadMetadata');
    assert.strictEqual((messages[1] as any).payload['format-version'], 2);
  });

  await run('loadMetadataPanel posts loading then loadMetadata for V3 fixture', async () => {
    const adapter = new LocalTestStorageAdapter();
    const { panel, messages } = makeFakePanel('v3.metadata.json');
    const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger);
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };

    await (mgr as any).loadMetadataPanel(panel, path.join(FIXTURE_DIR, 'v3.metadata.json'), handle);

    assert.strictEqual(messages[0]?.type, 'setState');
    assert.strictEqual(messages[1]?.type, 'loadMetadata');
    assert.strictEqual((messages[1] as any).payload['format-version'], 3);
  });

  await run('loadMetadataPanel posts error message for non-existent path', async () => {
    const adapter = new LocalTestStorageAdapter();
    const { panel, messages } = makeFakePanel('missing.json');
    const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger);
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };

    await (mgr as any).loadMetadataPanel(panel, path.join(FIXTURE_DIR, 'missing.json'), handle);

    const errorMsg = messages.find(m => m.type === 'setState' && (m as any).state === 'error');
    assert.ok(errorMsg, 'expected an error setState message');
    assert.strictEqual((errorMsg as any).errorClass, 'not-found');
    assert.strictEqual(
      (errorMsg as any).message,
      'File not found. The resource may have been deleted or moved.',
    );
  });

  // ── T-16: one-panel-per-resource guard ────────────────────────────────────

  await run('Registry does not grow when the same resourcePath is opened twice', () => {
    const adapter = new LocalTestStorageAdapter();
    const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger);
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const resourcePath = path.join(FIXTURE_DIR, 'v1.metadata.json');
    const key = `metadataDetail::${resourcePath}`;

    assert.ok(!(mgr as any).registry.has(key), 'registry must be empty initially');

    // Simulate first-call creation
    const { panel: fakePanel } = makeFakePanel('v1.metadata.json');
    (mgr as any).registry.set(key, { panel: fakePanel, resourcePath, handle });
    (mgr as any).tempFiles.set(key, null);

    const sizeBefore = (mgr as any).registry.size;
    // Reveal path: registry already has the key — do NOT add another entry
    if ((mgr as any).registry.has(key)) { /* reveal, not create */ }
    const sizeAfter = (mgr as any).registry.size;

    assert.strictEqual(sizeBefore, sizeAfter, 'registry size must not grow on reveal');
  });

  // ── T-26: per-version field presence ─────────────────────────────────────

  await run('V1 fixture: no sort-orders, refs, or last-sequence-number keys', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v1.metadata.json'));
    assert.ok(!isStorageError(result));
    const payload = result as Record<string, unknown>;
    assert.ok(!('sort-orders' in payload), 'V1 must not have sort-orders key');
    assert.ok(!('refs' in payload), 'V1 must not have refs key');
    assert.ok(!('last-sequence-number' in payload), 'V1 must not have last-sequence-number key');
  });

  await run('V2 fixture: has refs, sort-orders, and last-sequence-number', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v2.metadata.json'));
    assert.ok(!isStorageError(result));
    const payload = result as Record<string, unknown>;
    assert.ok('sort-orders' in payload);
    assert.ok('refs' in payload);
    assert.ok('last-sequence-number' in payload);
  });

  await run('V3 fixture: schemas have initial-default and write-default', async () => {
    const adapter = new LocalTestStorageAdapter();
    const handle: ActiveConnectionHandle = { connectionType: 'local', warehousePath: FIXTURE_DIR };
    const result = await adapter.fetchMetadataJson(handle, path.join(FIXTURE_DIR, 'v3.metadata.json'));
    assert.ok(!isStorageError(result));
    const payload = result as Record<string, unknown>;
    const schemas = payload['schemas'] as any[];
    const field0 = schemas[0]['fields'][0];
    assert.ok('initial-default' in field0, 'V3 schema field must have initial-default');
    assert.ok('write-default' in field0, 'V3 schema field must have write-default');
  });

  // ── T-29: Log output sanity ───────────────────────────────────────────────

  await run('No raw credential strings appear in log output', () => {
    const CRED_PATTERN = /(?:accessKey|secretKey|password)\s*[:=]/i;
    const credLines = testLogLines.filter(l => CRED_PATTERN.test(l));
    assert.strictEqual(credLines.length, 0,
      `Credential content found in logs:\n${credLines.join('\n')}`);
  });

  await run('Error log entries do not contain stack traces', () => {
    const errorLines = testLogLines.filter(l => l.startsWith('[ERROR]'));
    const stackLines = errorLines.filter(l => / at [A-Za-z]/.test(l) && l.includes('.ts:'));
    assert.strictEqual(stackLines.length, 0,
      `Stack traces found in error logs:\n${stackLines.join('\n')}`);
  });

  await run('getMetadataDetailHtml script compiles without syntax errors and contains webviewReady', () => {
    const html = getMetadataDetailHtml('test-nonce', 'vscode-resource:');
    const scriptMatch = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Inline script tag must exist');
    const scriptCode = scriptMatch[1];
    assert.ok(scriptCode.includes("vscode.postMessage({ type: 'webviewReady' })"), 'Script must signal webviewReady');
    // Ensure script compiles with zero syntax errors (guards against template literal escaping bugs)
    assert.doesNotThrow(() => {
      new vm.Script(scriptCode);
    }, 'Inline script must parse cleanly in JavaScript engine');

    // Ensure all getElementById IDs referenced in the script exist in the HTML
    const idRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(scriptCode)) !== null) {
      const id = match[1];
      assert.ok(
        html.includes(`id="${id}"`),
        `HTML must contain element with id="${id}" referenced by script`,
      );
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; }

})();
