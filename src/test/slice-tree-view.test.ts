/**
 * Slice integration smoke test — Tree View Provider.
 * (plan.md §4, FR-7, FR-8, FR-9, AC-10, AC-11, AC-12)
 *
 * Run with:
 *   npx ts-node -P tsconfig.test.json -r ./test-setup.ts src/test/slice-tree-view.test.ts
 *
 * Tests do NOT open a real VS Code window; they use the stub in __mocks__/vscode.ts.
 */

import * as assert from 'node:assert';

import type { StorageAdapter } from '../storage/StorageAdapter';
import type { ActiveConnectionHandle, MetadataVersionEntry, DirectoryContentsResult } from '../storage/types';
import { storageError, type StorageError } from '../storage/errors';
import type { ILogger } from '../extension';
import { IcebergTreeProvider } from '../tree/icebergTreeProvider';
import type { IcebergTreeItem } from '../tree/types';
import type { ConnectionConfig } from '../connection/types';

// ---------------------------------------------------------------------------
// Fake extension context
// ---------------------------------------------------------------------------

const fakeContext: any = {
  extensionUri: { fsPath: '.' },
  subscriptions: [],
};

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
// Fake handle
// ---------------------------------------------------------------------------

const fakeHandle: ActiveConnectionHandle = {
  connectionType: 'local',
  warehousePath: '/warehouse',
};

// ---------------------------------------------------------------------------
// Stub connection configs
// ---------------------------------------------------------------------------

const conn1: ConnectionConfig = {
  id: 'conn-1',
  label: 'Alpha',
  connectionType: 'local',
  warehousePath: '/warehouse',
  sslVerification: true,
  savedAt: 1000,
};

const conn2: ConnectionConfig = {
  id: 'conn-2',
  label: 'Beta',
  connectionType: 's3',
  warehousePath: 's3://bucket/prefix',
  sslVerification: true,
  savedAt: 2000,
};

// ---------------------------------------------------------------------------
// Stub StorageAdapter helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    async listSchemas(_handle)                       { return []; },
    async listTables(_handle, _schema)               { return []; },
    async listMetadataVersions(_handle, _table)      { return []; },
    async fetchMetadataJson(_handle, _path)          { return {}; },
    async fetchFileToTemp(_handle, _path)            { return storageError('internal', 'n/a'); },
    async deleteTemp(_path)                          { return; },
    async listDirectoryContents(_handle, _dirPath): Promise<DirectoryContentsResult> {
      return { subdirectories: [], files: [] };
    },
    async isTable(_handle, _dirPath)                 { return false; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No-op callbacks for the new provider constructor
// ---------------------------------------------------------------------------

const noopActivate = async (_id: string): Promise<{ handle: ActiveConnectionHandle; adapter: StorageAdapter } | Error> =>
  ({ handle: fakeHandle, adapter: makeAdapter() });

const noopDelete = async (_id: string): Promise<void> => { /* no-op */ };

function makeProvider(adapter?: StorageAdapter): IcebergTreeProvider {
  return new IcebergTreeProvider(
    adapter ?? makeAdapter(),
    testLogger,
    noopActivate,
    noopDelete,
  );
}

// ---------------------------------------------------------------------------
// Async helper — waits for the provider's internal async fetch to complete
// and the _onDidChangeTreeData event to fire, then returns children.
// ---------------------------------------------------------------------------

async function waitForChildren(
  provider: IcebergTreeProvider,
  element?: IcebergTreeItem,
): Promise<IcebergTreeItem[]> {
  // First call may return [loadingItem]; we wait for the refresh event then call again.
  const firstResult = provider.getChildren(element);
  const firstItems = Array.isArray(firstResult)
    ? firstResult
    : await firstResult;

  // If the first result is a loading item, wait for the async fetch to settle.
  if (firstItems.length === 1 && (firstItems[0] as IcebergTreeItem).nodeType === 'loading') {
    await new Promise<void>((resolve) => {
      const unsub = (provider as any)._onDidChangeTreeData.event(() => {
        // unsubscribe is a no-op in the stub but call for correctness
        unsub.dispose();
        resolve();
      });
    });
    const secondResult = provider.getChildren(element);
    return Array.isArray(secondResult) ? secondResult : await secondResult;
  }

  return firstItems;
}

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

  // ── Root with no connections → empty array (triggers viewsWelcome) ───────────
  await run('Root with no connections → empty array', () => {
    const provider = makeProvider();
    // No setConnections call — configs is [] by default
    const children = provider.getChildren(undefined);
    const items = Array.isArray(children) ? children : [];
    assert.strictEqual(items.length, 0, `expected 0 items so viewsWelcome is shown, got ${items.length}`);
  });

  // ── New Test: Root with two connections → two connection nodes ─────────────
  await run('Root with two connections → two connection nodes', () => {
    const provider = makeProvider();
    provider.setConnections([conn1, conn2]);
    const children = provider.getChildren(undefined);
    const items = Array.isArray(children) ? children : [];
    assert.strictEqual(items.length, 2, `expected 2 connection nodes, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'connection');
    assert.strictEqual((items[1] as IcebergTreeItem).nodeType, 'connection');
    assert.strictEqual((items[0] as IcebergTreeItem).resourcePath, 'conn-1');
    assert.strictEqual((items[1] as IcebergTreeItem).resourcePath, 'conn-2');
  });

  // ── New Test: Inactive connection node → no children ──────────────────────
  await run('Inactive connection node → getChildren returns []', async () => {
    const { IcebergTreeItem: TreeItemClass, makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider();
    provider.setConnections([conn1]);
    // No active connection set
    const connItem = makeConnectionItem(conn1, false);
    const children = provider.getChildren(connItem);
    const items = Array.isArray(children) ? children : await children;
    assert.strictEqual(items.length, 0, `expected 0 children for inactive connection, got ${items.length}`);
  });

  // ── New Test: Active connection node → schema children ────────────────────
  await run('Active connection node → expands to schema children', async () => {
    const adapter = makeAdapter({
      async listSchemas() { return ['/warehouse/ns1', '/warehouse/ns2']; },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    const connItem = makeConnectionItem(conn1, true);
    const items = await waitForChildren(provider, connItem);
    assert.strictEqual(items.length, 2, `expected 2 schema items, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'schema');
  });

  // ── New Test: Context value on connection node ────────────────────────────
  await run('Connection node has contextValue === "icebergConnection"', async () => {
    const { makeConnectionItem } = await import('../tree/types.js');
    const connItem = makeConnectionItem(conn1, false);
    assert.strictEqual((connItem as any).contextValue, 'icebergConnection');
  });

  // ── New Test: Activate command marks connection as active ─────────────────
  await run('setActiveConnectionId marks a connection as active in rendered nodes', () => {
    const provider = makeProvider();
    provider.setConnections([conn1, conn2]);
    provider.setActiveConnectionId('conn-1');
    // The connection nodes rendered by getChildren should show conn-1 as active
    const items = provider.getChildren(undefined) as IcebergTreeItem[];
    assert.strictEqual(items.length, 2);
    // Active node uses green database icon; we cannot inspect ThemeColor in tests,
    // but we can verify the command argument still carries the id correctly
    const firstCmd = (items[0] as any).command;
    assert.ok(firstCmd, 'connection node must have a command');
    assert.strictEqual(firstCmd.command, 'icebergExplorer.activateConnection');
    assert.deepStrictEqual(firstCmd.arguments, ['conn-1']);
  });

  // ── New Test: setConnections([]) after active connection → empty array ─────
  await run('setConnections([]) removes all nodes and returns empty array', () => {
    const provider = makeProvider();
    provider.setConnections([conn1]);
    // Then remove all connections
    provider.setConnections([]);
    const items = provider.getChildren(undefined) as IcebergTreeItem[];
    assert.strictEqual(items.length, 0, `expected 0 items so viewsWelcome is shown, got ${items.length}`);
  });

  // ── Test 1 (updated): No active connection ────────────────────────────────
  await run('No active connection (empty configs) → getChildren(undefined) returns empty array', () => {
    const provider = makeProvider();
    // No setConnections call — handle is null, configs is [] by default
    const children = provider.getChildren(undefined);
    const items = Array.isArray(children) ? children : [];
    assert.strictEqual(items.length, 0, `expected 0 items, got ${items.length}`);
  });

  // ── Test 2: Root children success ────────────────────────────────────────
  await run('Root children success → connection node expands to 2 schema items after async resolves', async () => {
    const adapter = makeAdapter({
      async listSchemas() {
        return ['/warehouse/ns1', '/warehouse/ns2'];
      },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    // Get the connection node, then expand it
    const connItem = makeConnectionItem(conn1, true);
    const items = await waitForChildren(provider, connItem);
    assert.strictEqual(items.length, 2, `expected 2 schema items, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'schema');
    assert.strictEqual((items[1] as IcebergTreeItem).nodeType, 'schema');
  });

  // ── Test 3: Root children loading ────────────────────────────────────────
  await run('Root children loading → first getChildren call on connection node returns loading item', async () => {
    let resolveList!: (v: string[]) => void;
    const deferred = new Promise<string[]>((res) => { resolveList = res; });
    const adapter = makeAdapter({
      async listSchemas() { return deferred; },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    const connItem = makeConnectionItem(conn1, true);

    // Before the promise resolves, result should be a loading item
    const firstResult = provider.getChildren(connItem);
    const firstItems = Array.isArray(firstResult) ? firstResult : await firstResult;
    assert.strictEqual(firstItems.length, 1);
    assert.strictEqual((firstItems[0] as IcebergTreeItem).nodeType, 'loading');

    // Clean up — resolve so the async fetch can complete
    resolveList([]);
  });

  // ── Test 4: Root children error ──────────────────────────────────────────
  await run('Root children error → connection node expansion returns 1 error item with retry command', async () => {
    const adapter = makeAdapter({
      async listSchemas() {
        return storageError('access-denied', 'Access denied.');
      },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    const connItem = makeConnectionItem(conn1, true);
    const items = await waitForChildren(provider, connItem);
    assert.strictEqual(items.length, 1, `expected 1 error item, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'error');
    const cmd = (items[0] as any).command;
    assert.ok(cmd, 'error item must have a command');
    assert.strictEqual(cmd.command, 'icebergExplorer.retryTreeNode');
  });

  // ── Test 5: Metadata versions sorted newest-first ────────────────────────
  await run('Metadata versions sorted newest-first by sortKey descending', async () => {
    const entries: MetadataVersionEntry[] = [
      { label: 'v1.metadata.json', resourcePath: '/t/v1', sortKey: 1 },
      { label: 'v3.metadata.json', resourcePath: '/t/v3', sortKey: 3 },
      { label: 'v2.metadata.json', resourcePath: '/t/v2', sortKey: 2 },
    ];
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: ['metadata'], files: [] };
      },
      async listMetadataVersions() { return entries; },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('my_table', 'table', '/warehouse/ns1/my_table');

    // First expand the table to get the metadataFolder node
    const tableChildren = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(tableChildren.length, 1);
    const metadataFolderItem = tableChildren[0] as IcebergTreeItem;
    assert.strictEqual(metadataFolderItem.nodeType, 'metadataFolder');

    // Now expand the metadataFolder to get metadataVersion nodes
    const items = await waitForChildren(provider, metadataFolderItem);
    assert.strictEqual(items.length, 3);
    assert.strictEqual((items[0] as IcebergTreeItem).sortKey, 3, 'first item should have sortKey=3 (newest)');
    assert.strictEqual((items[1] as IcebergTreeItem).sortKey, 2);
    assert.strictEqual((items[2] as IcebergTreeItem).sortKey, 1, 'last item should have sortKey=1 (oldest)');
  });

  // ── Test 6: setActiveConnection(null) resets tree ────────────────────────
  await run('setActiveConnection(null) → inactive connection nodes show no children', () => {
    const provider = makeProvider();
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle);

    // Now reset
    provider.setActiveConnectionId(null);
    provider.setActiveConnection(null);

    // Root should now show a connection node for conn1 (configs still has it)
    const items = provider.getChildren(undefined) as IcebergTreeItem[];
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'connection');

    // But the connection node has no children (not active)
    const connChildren = provider.getChildren(items[0] as IcebergTreeItem) as IcebergTreeItem[];
    assert.strictEqual(connChildren.length, 0, 'inactive connection should have no children');
  });

  // ── Test 7: Retry command clears cache ───────────────────────────────────
  await run('Retry command clears cache entry for parentPath', async () => {
    let callCount = 0;
    const adapter = makeAdapter({
      async listSchemas() {
        callCount++;
        return ['/warehouse/ns1'];
      },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    const connItem = makeConnectionItem(conn1, true);
    // Wait for first load
    await waitForChildren(provider, connItem);
    assert.strictEqual(callCount, 1);

    // Cache should now have the root entry
    const cacheBeforeRetry = (provider as any).cache.has('__root__');
    assert.ok(cacheBeforeRetry, 'cache should contain __root__ after first load');

    // Clear cache via clearCache (same as what retryTreeNode command calls)
    provider.clearCache('__root__');
    const cacheAfterRetry = (provider as any).cache.has('__root__');
    assert.ok(!cacheAfterRetry, 'cache should not contain __root__ after clearCache');
  });

  // ── Test 8: Log output: no credentials ──────────────────────────────────
  await run('Log output: no entries contain accessKey or secretKey', () => {
    const CRED_PATTERN = /(?:accessKey|secretKey)/i;
    const credLines = testLogLines.filter(l => CRED_PATTERN.test(l));
    assert.strictEqual(
      credLines.length,
      0,
      `Credential content found in logs:\n${credLines.join('\n')}`,
    );
  });

  // ── Test 9: Table expansion — both folders present ───────────────────────
  await run('Table expansion — both metadata/ and data/ present → 2 virtual folder nodes', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: ['metadata', 'data'], files: [] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('events', 'table', '/warehouse/ns1/events');

    const items = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(items.length, 2, `expected 2 children, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'metadataFolder');
    assert.strictEqual((items[1] as IcebergTreeItem).nodeType, 'dataFolder');
  });

  // ── Test 10: Table expansion — only metadata present ─────────────────────
  await run('Table expansion — only metadata/ present → 1 metadataFolder node only', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: ['metadata'], files: [] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('events', 'table', '/warehouse/ns1/events');

    const items = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1, `expected 1 child, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'metadataFolder');
  });

  // ── Test 11: Table expansion — only data present ──────────────────────────
  await run('Table expansion — only data/ present → 1 dataFolder node only', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: ['data'], files: [] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('events', 'table', '/warehouse/ns1/events');

    const items = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1, `expected 1 child, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'dataFolder');
  });

  // ── Test 12: Table expansion — root-level parquet file (D3) ──────────────
  await run('Table expansion — root-level parquet file (D3) → dataFolder + dataFile', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: ['data'], files: ['orphan.parquet'] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('events', 'table', '/warehouse/ns1/events');

    const items = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(items.length, 2, `expected 2 children, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'dataFolder');
    assert.strictEqual((items[1] as IcebergTreeItem).nodeType, 'dataFile');
    assert.ok(
      String((items[1] as IcebergTreeItem).label).endsWith('.parquet'),
      'dataFile label should end with .parquet',
    );
  });

  // ── Test 13: Metadata folder expansion ───────────────────────────────────
  await run('Metadata folder expansion → sorted metadataVersion nodes', async () => {
    const entries: MetadataVersionEntry[] = [
      { label: 'v1.metadata.json', resourcePath: '/t/meta/v1', sortKey: 1 },
      { label: 'v3.metadata.json', resourcePath: '/t/meta/v3', sortKey: 3 },
    ];
    const adapter = makeAdapter({
      async listMetadataVersions() { return entries; },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const metadataFolderItem = new TreeItemClass(
      'Metadata', 'metadataFolder',
      '/warehouse/ns1/events/metadata',
      '/warehouse/ns1/events',
    );

    const items = await waitForChildren(provider, metadataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 2);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'metadataVersion');
    assert.strictEqual((items[0] as IcebergTreeItem).sortKey, 3, 'newest-first');
    assert.strictEqual((items[1] as IcebergTreeItem).sortKey, 1);
  });

  // ── Test 14: Data folder expansion ───────────────────────────────────────
  await run('Data folder expansion → dataDirectory + dataFile children', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents(_handle, dirPath) {
        if (dirPath === '/warehouse/ns1/events/data') {
          return { subdirectories: ['recordtype=0', 'recordtype=1'], files: ['some.parquet'] };
        }
        return { subdirectories: [], files: [] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const dataFolderItem = new TreeItemClass(
      'Data', 'dataFolder',
      '/warehouse/ns1/events/data',
      '/warehouse/ns1/events',
    );

    const items = await waitForChildren(provider, dataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 3, `expected 3 children, got ${items.length}`);
    const types = (items as IcebergTreeItem[]).map(i => i.nodeType);
    assert.ok(types.includes('dataDirectory'), 'should include dataDirectory');
    assert.ok(types.includes('dataFile'), 'should include dataFile');
    const dirs = (items as IcebergTreeItem[]).filter(i => i.nodeType === 'dataDirectory');
    assert.strictEqual(dirs.length, 2);
  });

  // ── Test 15: Data directory recursive expansion ───────────────────────────
  await run('Data directory recursive expansion → nested dataDirectory child', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents(_handle, dirPath) {
        if (dirPath === '/warehouse/ns1/events/data/recordtype=0') {
          return { subdirectories: ['timestamputc_month=2026-08'], files: [] };
        }
        return { subdirectories: [], files: [] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const dataDirItem = new TreeItemClass(
      'recordtype=0', 'dataDirectory',
      '/warehouse/ns1/events/data/recordtype=0',
      '/warehouse/ns1/events/data',
    );

    const items = await waitForChildren(provider, dataDirItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1, `expected 1 child, got ${items.length}`);
    const child = items[0] as IcebergTreeItem;
    assert.strictEqual(child.nodeType, 'dataDirectory');
    assert.strictEqual(child.label, 'timestamputc_month=2026-08');
    assert.strictEqual(child.resourcePath, '/warehouse/ns1/events/data/recordtype=0/timestamputc_month=2026-08');
  });

  // ── Test 16: COMPLETE.gz filter (contract test) ───────────────────────────
  await run('COMPLETE.gz filter (contract test) — adapter never returns COMPLETE.gz files', async () => {
    // Adapter is responsible for filtering; stub represents the already-filtered result
    const adapter = makeAdapter({
      async listDirectoryContents() {
        // COMPLETE.gz files are never returned by the adapter — stub shows only what passes
        return { subdirectories: [], files: ['data.parquet'] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const dataFolderItem = new TreeItemClass('Data', 'dataFolder', '/w/t/data', '/w/t');

    const items = await waitForChildren(provider, dataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1, `expected 1 dataFile node, got ${items.length}`);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'dataFile');
  });

  // ── Test 17: Parquet file has preview command ─────────────────────────────
  await run('Parquet dataFile node has icebergExplorer.openParquetPreview command', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: [], files: ['archive.parquet'] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const dataFolderItem = new TreeItemClass('Data', 'dataFolder', '/w/t/data', '/w/t');

    const items = await waitForChildren(provider, dataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1);
    const fileItem = items[0] as IcebergTreeItem;
    assert.strictEqual(fileItem.nodeType, 'dataFile');
    const cmd = (fileItem as any).command;
    assert.ok(cmd, 'parquet dataFile must have a command');
    assert.strictEqual(cmd.command, 'icebergExplorer.openParquetPreview');
  });

  // ── Test 18: Non-parquet file has no command (D2) ─────────────────────────
  await run('Non-parquet dataFile node (D2) has no command', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents() {
        return { subdirectories: [], files: ['events.avro'] };
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const dataFolderItem = new TreeItemClass('Data', 'dataFolder', '/w/t/data', '/w/t');

    const items = await waitForChildren(provider, dataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1);
    const fileItem = items[0] as IcebergTreeItem;
    assert.strictEqual(fileItem.nodeType, 'dataFile');
    assert.strictEqual((fileItem as any).command, undefined, 'non-parquet dataFile must NOT have a command');
  });

  // ── Test 19: Metadata version click still works (regression guard) ────────
  await run('metadataVersion node has icebergExplorer.openMetadataPanel command (regression guard)', async () => {
    const entries: MetadataVersionEntry[] = [
      { label: 'v1.metadata.json', resourcePath: '/t/meta/v1', sortKey: 1 },
    ];
    const adapter = makeAdapter({
      async listMetadataVersions() { return entries; },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const metadataFolderItem = new TreeItemClass(
      'Metadata', 'metadataFolder',
      '/warehouse/ns1/events/metadata',
      '/warehouse/ns1/events',
    );

    const items = await waitForChildren(provider, metadataFolderItem as IcebergTreeItem);
    assert.strictEqual(items.length, 1);
    const versionItem = items[0] as IcebergTreeItem;
    assert.strictEqual(versionItem.nodeType, 'metadataVersion');
    const cmd = (versionItem as any).command;
    assert.ok(cmd, 'metadataVersion must have a command');
    assert.strictEqual(cmd.command, 'icebergExplorer.openMetadataPanel');
  });

  // ── Test 20: Root-level isTable detects standalone table vs database ──────
  await run('Root-level isTable check detects standalone table vs database node', async () => {
    const adapter = makeAdapter({
      async listSchemas() { return ['/warehouse/standalone_table', '/warehouse/sales_db']; },
      async isTable(_handle, path) { return path === '/warehouse/standalone_table'; },
    });
    const { makeConnectionItem } = await import('../tree/types.js');
    const provider = makeProvider(adapter);
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');
    provider.setActiveConnection(fakeHandle, adapter);

    const connItem = makeConnectionItem(conn1, true);
    const items = await waitForChildren(provider, connItem);
    assert.strictEqual(items.length, 2);
    assert.strictEqual((items[0] as IcebergTreeItem).nodeType, 'table');
    assert.strictEqual((items[0] as IcebergTreeItem).label, 'standalone_table');
    assert.strictEqual((items[1] as IcebergTreeItem).nodeType, 'schema');
    assert.strictEqual((items[1] as IcebergTreeItem).label, 'sales_db');
  });

  // ── Test 21: Schema-level isTable enables multi-level namespace drilling ──
  await run('Schema-level isTable check enables nested namespace drilling (dogs -> testdogs.db -> dogtable1)', async () => {
    const adapter = makeAdapter({
      async listTables(_handle, schemaPath) {
        if (schemaPath === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        if (schemaPath === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        return [];
      },
      async isTable(_handle, path) {
        return path === 's3://rk-iceberg/dogs/testdogs.db/dogtable1';
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle, adapter);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    // 1. Expand "dogs" (schema) -> should yield testdogs.db as schema (isTable: false)
    const dogsItem = new TreeItemClass('dogs', 'schema', 's3://rk-iceberg/dogs');
    const dogsChildren = await waitForChildren(provider, dogsItem as IcebergTreeItem);
    assert.strictEqual(dogsChildren.length, 1);
    assert.strictEqual(dogsChildren[0].label, 'testdogs.db');
    assert.strictEqual(dogsChildren[0].nodeType, 'schema', 'testdogs.db should be schema because it contains sub-tables');

    // 2. Expand "testdogs.db" (schema) -> should yield dogtable1 as table (isTable: true)
    const dbItem = dogsChildren[0];
    const dbChildren = await waitForChildren(provider, dbItem);
    assert.strictEqual(dbChildren.length, 1);
    assert.strictEqual(dbChildren[0].label, 'dogtable1');
    assert.strictEqual(dbChildren[0].nodeType, 'table', 'dogtable1 should be table because isTable is true');
  });

  // ── Test 22: Table node fallback when missing metadata/data directly ──────
  await run('Intermediate table node fallback resolves child subdirectories when no metadata/data present', async () => {
    const adapter = makeAdapter({
      async listDirectoryContents(_handle, dirPath) {
        if (dirPath === '/warehouse/intermediate') {
          return { subdirectories: ['table_a'], files: [] };
        }
        return { subdirectories: [], files: [] };
      },
      async isTable(_handle, path) {
        return path === '/warehouse/intermediate/table_a';
      },
    });
    const provider = makeProvider(adapter);
    provider.setActiveConnection(fakeHandle, adapter);

    const { IcebergTreeItem: TreeItemClass } = await import('../tree/types.js');
    const tableItem = new TreeItemClass('intermediate', 'table', '/warehouse/intermediate');
    const children = await waitForChildren(provider, tableItem as IcebergTreeItem);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].label, 'table_a');
    assert.strictEqual(children[0].nodeType, 'table');
  });

  // ── Test 23: findItemByPath resolves connection by id or warehousePath ────
  await run('findItemByPath resolves connection item by config id or warehousePath', async () => {
    const provider = makeProvider();
    provider.setConnections([conn1, conn2]);
    provider.setActiveConnectionId('conn-1');

    const byId = provider.findItemByPath('conn-1');
    assert.ok(byId, 'expected connection item by id');
    assert.strictEqual(byId.resourcePath, 'conn-1');
    assert.strictEqual(byId.nodeType, 'connection');

    const byWarehouse = provider.findItemByPath('s3://bucket/prefix');
    assert.ok(byWarehouse, 'expected connection item by warehousePath');
    assert.strictEqual(byWarehouse.resourcePath, 'conn-2');
  });

  // ── Test 24: getParent resolves connection and nested parents ──────────────
  await run('getParent resolves active connection for root schema and parent for nested schema', async () => {
    const { makeSchemaItem } = await import('../tree/types.js');
    const provider = makeProvider();
    provider.setConnections([conn1]);
    provider.setActiveConnectionId('conn-1');

    // Root schema with parentPath === 'conn-1'
    const rootSchema = makeSchemaItem('/warehouse/dogs', 'dogs', 'conn-1');
    const rootParent = provider.getParent(rootSchema);
    assert.ok(rootParent, 'expected parent connection item');
    assert.strictEqual(rootParent.resourcePath, 'conn-1');
    assert.strictEqual(rootParent.nodeType, 'connection');

    // Add rootSchema to cache under '__root__'
    (provider as any).cache.set('__root__', [rootSchema]);

    // Nested schema under dogs
    const nestedSchema = makeSchemaItem('/warehouse/dogs/testdogs.db', 'testdogs.db', '/warehouse/dogs');
    const nestedParent = provider.getParent(nestedSchema);
    assert.ok(nestedParent, 'expected parent schema item');
    assert.strictEqual(nestedParent.resourcePath, '/warehouse/dogs');
  });

  // ── Test 25: resolveItemByPath drills down uncached path ───────────────────
  await run('resolveItemByPath drills down uncached path (dogs -> testdogs.db) and populates cache', async () => {
    const adapter = makeAdapter({
      async listSchemas() {
        return ['s3://rk-iceberg/dogs'];
      },
      async listTables(_handle, schemaPath) {
        if (schemaPath === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        return [];
      },
      async isTable() {
        return false;
      },
    });

    const s3Conn: ConnectionConfig = {
      id: 'conn-s3',
      label: 'S3 Connection',
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      sslVerification: true,
      savedAt: 1000,
    };
    const s3Handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      s3Config: {
        client: {} as any,
        bucket: 'rk-iceberg',
        keyPrefix: '',
      },
    };

    const provider = makeProvider(adapter);
    provider.setConnections([s3Conn]);
    provider.setActiveConnectionId('conn-s3');
    provider.setActiveConnection(s3Handle, adapter);

    // Tree cache is initially empty
    assert.strictEqual(provider.findItemByPath('s3://rk-iceberg/dogs/testdogs.db'), undefined);

    // Resolving uncached nested path
    const resolved = await provider.resolveItemByPath('s3://rk-iceberg/dogs/testdogs.db');
    assert.ok(resolved, 'expected resolved item for testdogs.db');
    assert.strictEqual(resolved.resourcePath, 's3://rk-iceberg/dogs/testdogs.db');
    assert.strictEqual(resolved.label, 'testdogs.db');
    assert.strictEqual(resolved.parentPath, 's3://rk-iceberg/dogs');

    // Verify ancestors are now cached and getParent works up to root
    const parent = provider.getParent(resolved);
    assert.ok(parent, 'expected parent of testdogs.db');
    assert.strictEqual(parent.resourcePath, 's3://rk-iceberg/dogs');

    const grandParent = provider.getParent(parent);
    assert.ok(grandParent, 'expected connection grandparent');
    assert.strictEqual(grandParent.resourcePath, 'conn-s3');
  });

  // ── Test 26: resolveItemByPath resolves connection root and table ───────────
  await run('resolveItemByPath resolves connection root and deep table item', async () => {
    const adapter = makeAdapter({
      async listSchemas() {
        return ['s3://rk-iceberg/dogs'];
      },
      async listTables(_handle, schemaPath) {
        if (schemaPath === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        if (schemaPath === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        return [];
      },
      async isTable(_handle, path) {
        return path === 's3://rk-iceberg/dogs/testdogs.db/dogtable1';
      },
    });

    const s3Conn: ConnectionConfig = {
      id: 'conn-s3',
      label: 'S3 Connection',
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      sslVerification: true,
      savedAt: 1000,
    };
    const s3Handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      s3Config: {
        client: {} as any,
        bucket: 'rk-iceberg',
        keyPrefix: '',
      },
    };

    const provider = makeProvider(adapter);
    provider.setConnections([s3Conn]);
    provider.setActiveConnectionId('conn-s3');
    provider.setActiveConnection(s3Handle, adapter);

    // 1. Resolve root breadcrumb
    const rootResolved = await provider.resolveItemByPath('s3://rk-iceberg');
    assert.ok(rootResolved, 'expected resolved root connection');
    assert.strictEqual(rootResolved.resourcePath, 'conn-s3');

    // 2. Resolve deep table item
    const tableResolved = await provider.resolveItemByPath('s3://rk-iceberg/dogs/testdogs.db/dogtable1');
    assert.ok(tableResolved, 'expected resolved table item');
    assert.strictEqual(tableResolved.resourcePath, 's3://rk-iceberg/dogs/testdogs.db/dogtable1');
    assert.strictEqual(tableResolved.nodeType, 'table');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; }

})();
