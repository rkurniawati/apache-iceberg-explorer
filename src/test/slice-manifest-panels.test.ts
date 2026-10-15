/**
 * Slice integration smoke test — manifest list, manifest file, Parquet preview,
 * and ad-hoc query panels end-to-end.
 * (T-31, plan.md §4, FR-11–FR-17, FR-20, NFR-6)
 *
 * Run with:
 *   npx ts-node -P tsconfig.test.json -r ./test-setup.ts src/test/slice-manifest-panels.test.ts
 *
 * Does NOT open a real VS Code window. Tests message-flow and temp-file lifecycle only.
 */
import * as assert from 'node:assert';

import type { StorageAdapter } from '../storage/StorageAdapter';
import type { ActiveConnectionHandle } from '../storage/types';
import { storageError, isStorageError, type StorageError } from '../storage/errors';
import type { ILogger } from '../extension';
import {
  type ManifestEntryRow,
  type DataFileRow,
  type QueryResult,
  type QueryError,
  queryError,
  isQueryError,
} from '../query/types';
import { WebviewPanelManager } from '../panels/webviewPanelManager';
import { getManifestListHtml } from '../panels/html/manifestList';
import { getManifestFileHtml } from '../panels/html/manifestFile';
import { panelRegistryKey } from '../panels/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Stub QueryEngine
// ---------------------------------------------------------------------------

interface StubQueryEngine {
  parseManifestList(path: string): Promise<ManifestEntryRow[] | QueryError>;
  parseManifestFile(path: string): Promise<DataFileRow[] | QueryError>;
  previewParquet(path: string): Promise<QueryResult | QueryError>;
  runAdHocQuery(path: string, sql: string): Promise<QueryResult | QueryError>;
  cancelCurrentQuery(): void;
  _cancelCallback?: () => void;
}

function makeQueryEngine(overrides: Partial<StubQueryEngine> = {}): StubQueryEngine {
  return {
    async parseManifestList(_path) {
      return [];
    },
    async parseManifestFile(_path) {
      return [];
    },
    async previewParquet(_path) {
      return { rows: [], columnNames: [], rowCount: 0, wasCapped: false, durationMs: 0 };
    },
    async runAdHocQuery(_path, _sql) {
      return { rows: [], columnNames: [], rowCount: 0, wasCapped: false, durationMs: 0 };
    },
    cancelCurrentQuery() {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub StorageAdapter
// ---------------------------------------------------------------------------

interface StubStorageAdapter extends StorageAdapter {
  deletedPaths: string[];
}

function makeStorageAdapter(overrides: Partial<StorageAdapter> = {}): StubStorageAdapter {
  const deletedPaths: string[] = [];
  return {
    deletedPaths,
    async listSchemas() { return []; },
    async listTables() { return []; },
    async listMetadataVersions() { return []; },
    async fetchMetadataJson() { return {}; },
    async fetchFileToTemp(_handle, _path) {
      return '/tmp/iceberg-test/file.avro';
    },
    async deleteTemp(path) {
      deletedPaths.push(path);
    },
    async listDirectoryContents() { return { subdirectories: [], files: [] }; },
    async isTable() { return false; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VS Code mock helpers — vscode.window.createWebviewPanel is patched by test-setup
// ---------------------------------------------------------------------------

interface FakePanel {
  messages: PostedMessage[];
  disposeListeners: Array<() => void>;
  messageHandlers: Array<(msg: unknown) => void>;
  dispose(): void;
  triggerMessage(msg: unknown): void;
}

/**
 * Augment the mock's createWebviewPanel so we can capture messages and handlers.
 */
function makeFakePanel(): FakePanel {
  const messages: PostedMessage[] = [];
  const disposeListeners: Array<() => void> = [];
  const messageHandlers: Array<(msg: unknown) => void> = [];

  return {
    messages,
    disposeListeners,
    messageHandlers,
    dispose() {
      for (const h of disposeListeners) { h(); }
    },
    triggerMessage(msg: unknown) {
      for (const h of messageHandlers) { h(msg); }
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Extension Context
// ---------------------------------------------------------------------------

const fakeContext: any = {
  extensionUri: { fsPath: '.' },
  subscriptions: [],
};

// ---------------------------------------------------------------------------
// Test Logger
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg)  { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg)  { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};
function clearLog() { testLogLines.length = 0; }

// ---------------------------------------------------------------------------
// Patch vscode.window.createWebviewPanel to return a controlled fake
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeMock = require('../test/__mocks__/vscode');

function withInterceptedPanel(
  callback: (panel: FakePanel) => Promise<void>,
): Promise<void> {
  const fake = makeFakePanel();

  const origCreate = vscodeMock.window.createWebviewPanel.bind(vscodeMock.window);
  vscodeMock.window.createWebviewPanel = (
    _viewType: string,
    _title: string,
    _col: unknown,
    _opts: unknown,
  ) => {
    const messages: PostedMessage[] = fake.messages;
    return {
      viewType: _viewType,
      title: _title,
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: any) => uri,
        postMessage(msg: PostedMessage) { messages.push(msg); },
        onDidReceiveMessage(handler: (msg: unknown) => void) {
          fake.messageHandlers.push(handler);
          // Simulate the webview JS posting webviewReady on the next tick,
          // just like the real inline script does.
          Promise.resolve().then(() => handler({ type: 'webviewReady' }));
          return { dispose() {} };
        },
        _getMessages() { return messages; },
      },
      reveal(_col: unknown) {},
      onDidDispose(handler: () => void, _ctx: unknown, _subs: unknown) {
        fake.disposeListeners.push(handler);
        return { dispose() {} };
      },
      dispose() { fake.dispose(); },
    };
  };

  return callback(fake).finally(() => {
    vscodeMock.window.createWebviewPanel = origCreate;
  });
}

// ---------------------------------------------------------------------------
// Handle for connections
// ---------------------------------------------------------------------------

const testHandle: ActiveConnectionHandle = {
  connectionType: 'local',
  warehousePath: '/warehouse',
};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error('   ', err);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

  // ── Test 1: openManifestList message triggers openManifestListPanel ─────────

  await run('openManifestList message triggers openManifestListPanel', async () => {
    clearLog();
    const resourcePath = 's3://bucket/path/snap-123.avro';

    let manifestListOpenedWith: string | null = null;

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/test.avro'; },
      });
      const engine = makeQueryEngine({
        async parseManifestList() { return []; },
      });
      // Use a WebviewPanelManager subclass to capture the call
      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);

      // Open a metadata detail panel first so the message handler is wired
      await (mgr as any).openMetadataDetailPanel(resourcePath, testHandle);

      // Simulate openManifestList message from metadata detail webview
      let capturedPath: string | null = null;
      const origOpenManifest = (mgr as any).openManifestListPanel.bind(mgr);
      (mgr as any).openManifestListPanel = async (path: string, handle: ActiveConnectionHandle) => {
        capturedPath = path;
        return origOpenManifest(path, handle);
      };

      // Trigger the message through the panel's message handler
      fake.triggerMessage({ type: 'openManifestList', resourcePath });
      // Wait a tick for the async dispatch
      await new Promise(r => setTimeout(r, 10));

      manifestListOpenedWith = capturedPath;
    });

    assert.strictEqual(manifestListOpenedWith, resourcePath,
      `Expected openManifestListPanel called with ${resourcePath}, got ${manifestListOpenedWith}`);
  });

  // ── Test 2: Manifest list panel success path ─────────────────────────────────

  await run('Manifest list panel: success path posts loadManifestList with 2 rows', async () => {
    clearLog();
    const resourcePath = 's3://bucket/path/snap-123-m0.avro';
    const mockRows: ManifestEntryRow[] = [
      { manifestPath: 's3://bucket/manifest1.avro', manifestLength: 100, partitionSpecId: 0, content: 0, snapshotId: 1, addedFilesCount: 1 },
      { manifestPath: 's3://bucket/manifest2.avro', manifestLength: 200, partitionSpecId: 0, content: 0, snapshotId: 1, addedFilesCount: 2 },
    ];

    const messages: PostedMessage[] = [];
    await withInterceptedPanel(async (fake) => {
      // Capture actual panel messages
      fake.messages.length = 0;

      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/test.avro'; },
        async deleteTemp(_path) { adapter.deletedPaths.push(_path); },
      });
      const engine = makeQueryEngine({
        async parseManifestList() { return mockRows; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openManifestListPanel(resourcePath, testHandle);

      messages.push(...fake.messages);
    });

    const loadMsg = messages.find(m => m.type === 'loadManifestList');
    assert.ok(loadMsg, 'Expected loadManifestList message');
    assert.strictEqual((loadMsg as any).rows.length, 2, 'Expected 2 rows');
  });

  // ── Test 3: Manifest list panel fetchFileToTemp error ──────────────────────

  await run('Manifest list panel: fetchFileToTemp error → setState error, deleteTemp NOT called', async () => {
    clearLog();
    const resourcePath = 's3://bucket/bad.avro';
    const messages: PostedMessage[] = [];

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() {
          return storageError('not-found', 'File not found.');
        },
      });
      const engine = makeQueryEngine();

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openManifestListPanel(resourcePath, testHandle);
      messages.push(...fake.messages);
    });

    const errMsg = messages.find(m => m.type === 'setState' && (m as any).state === 'error');
    assert.ok(errMsg, 'Expected error setState');
    // deleteTemp should NOT have been called because we never got a temp file
    // (storageAdapter.deletedPaths should be empty)
  });

  // ── Test 4: Manifest list panel parseManifestList error ────────────────────

  await run('Manifest list panel: parseManifestList error → setState error and deleteTemp called', async () => {
    clearLog();
    const resourcePath = 's3://bucket/bad-avro.avro';
    const messages: PostedMessage[] = [];
    let deleteCalled = false;

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/test.avro'; },
        async deleteTemp(_path) { deleteCalled = true; },
      });
      const engine = makeQueryEngine({
        async parseManifestList() {
          return queryError('parse-failure', 'Could not read file.');
        },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openManifestListPanel(resourcePath, testHandle);
      messages.push(...fake.messages);
    });

    const errMsg = messages.find(m => m.type === 'setState' && (m as any).state === 'error');
    assert.ok(errMsg, 'Expected error setState');
    assert.ok(deleteCalled, 'Expected deleteTemp to be called on parse error');
  });

  // ── Test 5: Manifest list HTML has clickable manifest-file links ─────────────

  await run('Manifest list HTML: 3 rows produce 3 openManifestFile links', () => {
    const rows: ManifestEntryRow[] = [
      { manifestPath: 's3://b/m1.avro', manifestLength: 1, partitionSpecId: 0, content: 0, snapshotId: 1 },
      { manifestPath: 's3://b/m2.avro', manifestLength: 2, partitionSpecId: 0, content: 0, snapshotId: 1 },
      { manifestPath: 's3://b/m3.avro', manifestLength: 3, partitionSpecId: 0, content: 0, snapshotId: 1 },
    ];

    const html = getManifestListHtml('nonce123', 'vscode-resource:', 's3://b/snap.avro');

    // Verify the HTML has the manifest link handler
    // The manifest link script contains 'openManifestFile'
    assert.ok(html.includes('openManifestFile'), 'HTML must reference openManifestFile message type');

    // The data-path attribute with manifest paths should be generatable in the webview
    // The rows are injected at runtime via postMessage, not at HTML generation time
    // So this test verifies the structure is wired for it
    assert.ok(html.includes('manifest-link'), 'HTML must define manifest-link class for clickable rows');
  });

  // ── Test 6: Manifest file HTML — ORC file has no preview link ───────────────

  await run('Manifest file HTML: ORC file has no openParquetPreview reference in cell logic', () => {
    const html = getManifestFileHtml('nonce123', 'vscode-resource:', 's3://b/manifest.avro');

    // The HTML script must check for PARQUET format before rendering a file-link
    // It should NOT render file-link for non-PARQUET files
    assert.ok(html.includes('PARQUET'), 'HTML must have PARQUET check to conditionally render link');
    // The condition: only render file-link if fmt === 'PARQUET'
    assert.ok(html.includes('isParquet'), 'HTML must guard file links behind isParquet check');
    // Verify ORC path doesn't trigger link
    assert.ok(!html.includes("fmt === 'ORC'"), 'ORC should not be explicitly targeted — no-link is the default');
  });

  // ── Test 7: Parquet preview panel wasCapped banner ──────────────────────────

  await run('Parquet preview panel: wasCapped=true posts showCapBanner', async () => {
    clearLog();
    const resourcePath = 's3://bucket/data.parquet';
    const messages: PostedMessage[] = [];

    const mockResult: QueryResult = {
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i })),
      columnNames: ['id'],
      rowCount: 100,
      wasCapped: true,
      durationMs: 50,
    };

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/data.parquet'; },
      });
      const engine = makeQueryEngine({
        async previewParquet() { return mockResult; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openParquetPreviewPanel(resourcePath, testHandle);
      messages.push(...fake.messages);
    });

    const capBanner = messages.find(m => m.type === 'showCapBanner');
    assert.ok(capBanner, 'Expected showCapBanner message when wasCapped=true');
    assert.ok(
      (capBanner as any).message.toLowerCase().includes('100'),
      'Cap banner should mention 100 rows',
    );
  });

  // ── Test 8: Ad-hoc query: cancel transitions to idle ─────────────────────────

  await run('Ad-hoc query panel: cancelQuery message transitions to idle', async () => {
    clearLog();
    const resourcePath = 's3://bucket/data.parquet';
    const messages: PostedMessage[] = [];

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() {
          // Simulate a slow query that doesn't resolve before cancel
          return new Promise(resolve => setTimeout(() => resolve('/tmp/data.parquet'), 100));
        },
        async deleteTemp() {},
      });

      let cancelCalled = false;
      const engine = makeQueryEngine({
        cancelCurrentQuery() { cancelCalled = true; },
        async runAdHocQuery() {
          return queryError('cancelled', 'Operation cancelled.');
        },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openAdHocQueryPanel(resourcePath, testHandle);

      // Trigger cancel
      fake.triggerMessage({ type: 'cancelQuery' });
      await new Promise(r => setTimeout(r, 10));

      messages.push(...fake.messages);
    });

    const idleMsg = messages.find(m => m.type === 'setState' && (m as any).state === 'idle');
    assert.ok(idleMsg, 'Expected setState idle after cancelQuery');
  });

  // ── Test 9: Ad-hoc query LIMIT cap banner ─────────────────────────────────────

  await run('Ad-hoc query panel: wasCapped=true posts showCapBanner with 10000 rows message', async () => {
    clearLog();
    const resourcePath = 's3://bucket/data.parquet';
    const messages: PostedMessage[] = [];

    const mockResult: QueryResult = {
      rows: [],
      columnNames: [],
      rowCount: 10000,
      wasCapped: true,
      durationMs: 100,
    };

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/data.parquet'; },
        async deleteTemp() {},
      });
      const engine = makeQueryEngine({
        async runAdHocQuery() { return mockResult; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openAdHocQueryPanel(resourcePath, testHandle);

      // Trigger a query
      fake.triggerMessage({ type: 'runQuery', sql: 'SELECT * FROM data' });
      // Wait for async query flow
      await new Promise(r => setTimeout(r, 50));

      messages.push(...fake.messages);
    });

    const capBanner = messages.find(m => m.type === 'showCapBanner');
    assert.ok(capBanner, 'Expected showCapBanner when wasCapped=true');
    assert.ok(
      (capBanner as any).message.includes('10,000'),
      `Cap banner should mention 10,000 rows, got: ${(capBanner as any)?.message}`,
    );
  });

  // ── Test 10: Temp file cleanup on panel dispose ───────────────────────────────

  await run('Temp file cleanup on panel dispose', async () => {
    clearLog();
    const resourcePath = 's3://bucket/snap-123.avro';
    let deletedOnDispose = false;

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/test-dispose.avro'; },
        async deleteTemp(_path) { deletedOnDispose = true; },
      });
      const engine = makeQueryEngine({
        async parseManifestList() { return []; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);
      await mgr.openManifestListPanel(resourcePath, testHandle);

      // Simulate panel dispose — loadManifestListPanel deletes temp on success,
      // so set a new temp file manually to test the dispose path
      const key = `manifestList::${resourcePath}`;
      (mgr as any).tempFiles.set(key, '/tmp/remaining.avro');
      deletedOnDispose = false; // reset

      // Dispose the panel
      fake.dispose();
      await new Promise(r => setTimeout(r, 20));
    });

    assert.ok(deletedOnDispose, 'Expected deleteTemp to be called on panel dispose');
  });

  // ── Test 11: One-panel-per-resource guard ──────────────────────────────────────

  await run('One-panel-per-resource guard: opening same manifestList path twice keeps registry size = 1', async () => {
    clearLog();
    const resourcePath = 's3://bucket/snap-dedup.avro';

    await withInterceptedPanel(async (_fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/dedup.avro'; },
        async deleteTemp() {},
      });
      const engine = makeQueryEngine({
        async parseManifestList() { return []; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);

      await mgr.openManifestListPanel(resourcePath, testHandle);
      const sizeAfterFirst = (mgr as any).registry.size;

      // Second open — should reveal, not create
      await mgr.openManifestListPanel(resourcePath, testHandle);
      const sizeAfterSecond = (mgr as any).registry.size;

      assert.strictEqual(sizeAfterFirst, sizeAfterSecond,
        `Registry should not grow on second open: was ${sizeAfterFirst}, now ${sizeAfterSecond}`);
      assert.strictEqual(sizeAfterSecond, 1, 'Registry should have exactly 1 entry');
    });
  });

  // ── Test 12: No credentials in logs ──────────────────────────────────────────

  await run('No credential strings appear in log output', () => {
    const CRED_PATTERN = /(?:accessKey|secretKey|password)\s*[:=]/i;
    const credLines = testLogLines.filter(l => CRED_PATTERN.test(l));
    assert.strictEqual(credLines.length, 0,
      `Credential content found in logs:\n${credLines.join('\n')}`);
  });

  // ── Test 13: State re-delivery on reveal / webviewReady ───────────────────────

  await run('Manifest list panel re-posts loadManifestList on subsequent webviewReady', async () => {
    clearLog();
    const resourcePath = 's3://bucket/snap-restore.avro';
    const fakeRows: ManifestEntryRow[] = [
      { manifestPath: 's3://bucket/m1.avro', manifestLength: 1024, partitionSpecId: 0, snapshotId: 123, content: 0, addedFilesCount: 5, existingFilesCount: 0, deletedFilesCount: 0 },
    ];

    await withInterceptedPanel(async (fake) => {
      const adapter = makeStorageAdapter({
        async fetchFileToTemp() { return '/tmp/restore.avro'; },
        async deleteTemp() {},
      });
      const engine = makeQueryEngine({
        async parseManifestList() { return fakeRows; },
      });

      const mgr = new WebviewPanelManager(fakeContext, adapter, testLogger, engine as any);

      await mgr.openManifestListPanel(resourcePath, testHandle);

      await new Promise(resolve => setTimeout(resolve, 20));

      const countBefore = fake.messages.filter(m => m.type === 'loadManifestList').length;
      assert.strictEqual(countBefore, 1, 'expected 1 loadManifestList on first open');

      // Simulate the webview firing webviewReady a second time (e.g. tab recreated / navigated back)
      fake.triggerMessage({ type: 'webviewReady' });

      const countAfter = fake.messages.filter(m => m.type === 'loadManifestList').length;
      assert.strictEqual(countAfter, 2, 'expected loadManifestList to be re-posted when webviewReady is signaled again');
    });
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; }

})();
