/**
 * Slice integration tests for new interactive webviews:
 * - Table 360° Overview Panel (Phase 1)
 * - Connection & Catalog Dashboard (Phase 2)
 * - Embedded Data Preview (Phase 3)
 * - Metadata Structure with Paginated Timeline & Drill-Down (Phase 4)
 *
 * Run with:
 *   npx ts-node -P tsconfig.test.json -r ./test-setup.ts src/test/slice-new-panels.test.ts
 */
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { ConnectionConfig } from '../connection/types.js';
import { storageError, type StorageError } from '../storage/errors.js';
import type { ILogger } from '../extension.js';
import type {
  ManifestEntryRow,
  DataFileRow,
  QueryResult,
  QueryError,
} from '../query/types.js';
import { WebviewPanelManager } from '../panels/webviewPanelManager.js';
import { PanelType, panelRegistryKey } from '../panels/types.js';
import { getTableOverviewHtml } from '../panels/html/tableOverview.js';
import { getSchemaOverviewHtml } from '../panels/html/schemaOverview.js';
import { getConnectionDashboardHtml } from '../panels/html/connectionDashboard.js';
import { getMetadataStructureHtml } from '../panels/html/metadataStructure.js';
import { makeTableItem, makeMetadataFolderItem, makeConnectionItem, makeSchemaItem } from '../tree/types.js';
import { analyzeQuery } from '../query/sqlAnalyzer.js';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function makeLogger(): ILogger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info: (msg: string) => logs.push(`INFO: ${msg}`),
    warn: (msg: string) => logs.push(`WARN: ${msg}`),
    error: (msg: string) => logs.push(`ERROR: ${msg}`),
  };
}

function makeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose: () => void }[] = [];
  return {
    subscriptions,
    extensionUri: vscode.Uri.file('/fake/extension'),
  } as unknown as vscode.ExtensionContext;
}

const sampleMetadataJson = {
  'format-version': 2,
  'table-uuid': 'test-uuid-1234',
  'location': 's3://warehouse/db/events',
  'last-updated-ms': 1700000000000,
  'current-schema-id': 0,
  'current-snapshot-id': 1001,
  'schemas': [
    {
      'schema-id': 0,
      'fields': [
        { id: 1, name: 'id', required: true, type: 'long' },
        { id: 2, name: 'event_name', required: false, type: 'string', doc: 'event identifier' },
      ],
    },
  ],
  'default-spec-id': 0,
  'partition-specs': [
    {
      'spec-id': 0,
      'fields': [
        { 'source-id': 1, 'field-id': 1000, name: 'id_bucket', transform: 'bucket[16]' },
      ],
    },
  ],
  'snapshots': [
    {
      'snapshot-id': 1001,
      'parent-snapshot-id': 1000,
      'timestamp-ms': 1700000000000,
      'manifest-list': 's3://warehouse/db/events/metadata/snap-1001.avro',
      'summary': {
        'operation': 'append',
        'added-records': '50',
        'added-data-files': '2',
      },
    },
    {
      'snapshot-id': 1000,
      'parent-snapshot-id': null,
      'timestamp-ms': 1699000000000,
      'manifest-list': 's3://warehouse/db/events/metadata/snap-1000.avro',
      'summary': {
        'operation': 'append',
        'added-records': '20',
      },
    },
  ],
};

function makeStorageAdapter(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    async listSchemas() { return ['db']; },
    async listTables() { return ['s3://warehouse/db/events']; },
    async listMetadataVersions() {
      return [{ resourcePath: 's3://warehouse/db/events/metadata/v1.metadata.json', label: 'v1.metadata.json', sortKey: 1 }];
    },
    async fetchMetadataJson() { return sampleMetadataJson; },
    async fetchFileToTemp() { return '/tmp/stub.tmp'; },
    async deleteTemp() {},
    async isTable(_handle: any, p: string) { return p.includes('events'); },
    ...overrides,
  } as unknown as StorageAdapter;
}

function makeQueryEngine(overrides: Partial<any> = {}) {
  return {
    async parseManifestList(): Promise<ManifestEntryRow[]> {
      return [
        {
          manifestPath: 's3://warehouse/db/events/metadata/m1.avro',
          manifestLength: 1024,
          partitionSpecId: 0,
          snapshotId: 1001,
          addedFilesCount: 2,
          existingFilesCount: 0,
          deletedFilesCount: 0,
          content: 0,
        },
      ];
    },
    async parseManifestFile(): Promise<DataFileRow[]> {
      return [
        {
          status: 1, // ADDED
          filePath: 's3://warehouse/db/events/data/file1.parquet',
          fileFormat: 'PARQUET',
          recordCount: 50,
          fileSizeBytes: 2048,
        },
      ];
    },
    async previewParquet(): Promise<QueryResult> {
      return {
        rows: [{ id: 1, event_name: 'click' }, { id: 2, event_name: 'view' }],
        columnNames: ['id', 'event_name'],
        rowCount: 2,
        wasCapped: false,
        durationMs: 5,
      };
    },
    async runAdHocQuery(): Promise<QueryResult> {
      return {
        rows: [{ id: 1, event_name: 'click' }],
        columnNames: ['id', 'event_name'],
        rowCount: 1,
        wasCapped: false,
        durationMs: 5,
      };
    },
    cancelCurrentQuery() {},
    ...overrides,
  };
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  const handle = { connectionId: 'c1' } as unknown as ActiveConnectionHandle;

  // ─── Phase 1: Table 360° Overview ──────────────────────────────────────────

  await test('Table Overview: HTML shell contains tabs, filters, and nonce', () => {
    const html = getTableOverviewHtml('test-nonce', 'vscode-resource:', 's3://warehouse/db/events');
    assert.ok(html.includes('id="tab-schema"'), 'Contains Schema tab content');
    assert.ok(html.includes('id="tab-preview"'), 'Contains Data Preview tab content');
    assert.ok(html.includes('id="tab-snapshots"'), 'Contains Snapshots tab content');
    assert.ok(html.includes('id="schema-search"'), 'Contains schema filter input');
    assert.ok(html.includes('nonce="test-nonce"'), 'Nonce applied to scripts and styles');
    assert.ok(html.includes("document.getElementById('table-name').textContent = (msg.isView ? 'View ' : 'Table ') + msg.tableName;"), 'Formats table header with Table prefix');
    assert.ok(html.includes('webviewReady'), 'Posts webviewReady on init');
  });

  await test('Table Overview: loads table metadata, schema columns, partitions, and snapshots', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);

    const key = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Panel registered in manager registry');

    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadTableOverview');
    assert.strictEqual(lastMsg.tableName, 'events');
    assert.strictEqual(lastMsg.formatVersion, 2);
    assert.strictEqual(lastMsg.columns.length, 2);
    assert.strictEqual(lastMsg.columns[0].name, 'id');
    assert.strictEqual(lastMsg.partitionSpec[0].name, 'id_bucket');
    assert.strictEqual(lastMsg.snapshots.length, 2);
    assert.strictEqual(lastMsg.snapshots[0].snapshotId, '1001'); // sorted newest first
  });

  await test('Table Overview: singleton per table (opening twice keeps registry size 1)', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);

    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);
    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);

    assert.strictEqual((manager as any).registry.size, 1);
  });

  // ─── Phase 2: Connection & Catalog Dashboard ───────────────────────────────

  await test('Connection Dashboard: HTML shell contains inventory metrics and schema search, does not list tables', () => {
    const html = getConnectionDashboardHtml('test-nonce', 'vscode-resource:');
    assert.ok(html.includes('id="stat-schemas"'), 'Contains schemas stat card');
    assert.ok(html.includes('id="stat-tables"'), 'Contains tables stat card');
    assert.ok(html.includes('id="schema-search"'), 'Contains searchable schema roster input');
    assert.ok(html.includes('id="schemas-tbody"'), 'Contains schemas table body');
    assert.ok(html.includes('id="edit-settings-btn"'), 'Contains Edit Settings button');
    assert.ok(html.includes('data-action="open-schema"'), 'Contains open-schema action links');
    assert.ok(!html.includes('id="tables-tbody"'), 'Does not list tables on warehouse overview');
  });

  await test('Schema Overview: HTML shell contains schema info and tables roster', () => {
    const html = getSchemaOverviewHtml('test-nonce', 'vscode-resource:', 's3://warehouse/db');
    assert.ok(html.includes('id="schema-title"'), 'Contains schema title');
    assert.ok(html.includes('id="stat-tables"'), 'Contains tables stat card');
    assert.ok(html.includes('id="table-search"'), 'Contains searchable table roster input');
    assert.ok(html.includes('id="tables-tbody"'), 'Contains tables table body');
    assert.ok(html.includes('id="warehouse-btn"'), 'Contains Warehouse Overview button');
  });

  await test('Connection Dashboard: lists schemas and tables with inventory counts', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);

    const config: ConnectionConfig = {
      id: 'conn-1',
      label: 'Production Warehouse',
      connectionType: 's3',
      warehousePath: 's3://warehouse',
      sslVerification: true,
      savedAt: 1700000000000,
    };

    await manager.openConnectionDashboardPanel(config, handle, adapter);

    const key = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-1');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Connection Dashboard registered');

    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadConnectionDashboard');
    assert.strictEqual(lastMsg.connectionLabel, 'Production Warehouse');
    assert.strictEqual(lastMsg.schemasCount, 1);
    assert.strictEqual(lastMsg.tablesCount, 1);
    assert.strictEqual(lastMsg.schemas.length, 1);
    assert.strictEqual(lastMsg.schemas[0].name, 'db');
    assert.strictEqual(lastMsg.schemas[0].tableCount, 1);
  });

  await test('Schema Overview: lists tables in the selected schema', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);

    await manager.openSchemaOverviewPanel('s3://warehouse/db', handle, adapter, 'db');

    const key = panelRegistryKey(PanelType.SchemaOverview, 's3://warehouse/db');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Schema Overview registered');

    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadSchemaOverview');
    assert.strictEqual(lastMsg.schemaName, 'db');
    assert.strictEqual(lastMsg.tablesCount, 1);
    assert.strictEqual(lastMsg.tables[0].name, 'events');
  });

  // ─── Phase 3: Embedded Data Preview ────────────────────────────────────────

  await test('Data Preview: loadDataPreview fetches parquet sample and posts loadDataPreview message', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    await (manager as any).loadDataPreview(record.gate, 's3://warehouse/db/events', handle, adapter);

    const previewMsg = messages.find(m => m.type === 'loadDataPreview') as any;
    assert.ok(previewMsg, 'loadDataPreview posted');
    assert.strictEqual(previewMsg.rowCount, 2);
    assert.deepStrictEqual(previewMsg.columns, ['id', 'event_name']);
    assert.strictEqual(previewMsg.rows[0].event_name, 'click');
  });

  // ─── Phase 4: Metadata Structure ──────────────────────────────────────────

  await test('Metadata Structure: HTML shell includes pagination controls and manifest list container', () => {
    const html = getMetadataStructureHtml('test-nonce', 'vscode-resource:', 's3://warehouse/db/events');
    assert.ok(html.includes('id="page-prev-btn"'), 'Includes previous page button');
    assert.ok(html.includes('id="page-next-btn"'), 'Includes next page button');
    assert.ok(html.includes('id="page-indicator"'), 'Includes pagination indicator');
    assert.ok(html.includes('id="manifests-list"'), 'Includes manifests container');
    assert.ok(html.includes('id="manifests-count"'), 'Includes manifests count badge');
  });

  await test('Metadata Structure: loads latest snapshot lineage and manifests', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);

    const key = panelRegistryKey(PanelType.MetadataStructure, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Metadata Structure registered');

    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadMetadataStructure');
    assert.strictEqual(lastMsg.currentSnapshotId, '1001');
    assert.strictEqual(lastMsg.snapshots.length, 2);
    assert.ok(lastMsg.availableMetadataFiles, 'availableMetadataFiles present');
    assert.strictEqual(lastMsg.availableMetadataFiles.length, 1);
    assert.strictEqual(lastMsg.availableMetadataFiles[0].isLatest, true);
    assert.ok(lastMsg.activeSnapshot, 'Active snapshot data present');
    assert.strictEqual(lastMsg.activeSnapshot.snapshotId, '1001');
    assert.strictEqual(lastMsg.activeSnapshot.manifests.length, 1);
    assert.strictEqual(lastMsg.activeSnapshot.manifests[0].addedFiles, 2);
  });

  await test('Metadata Structure: drill down into manifest data files via loadManifestDataFiles', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.MetadataStructure, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    await (manager as any).loadManifestDataFiles(record.gate, 's3://warehouse/db/events/metadata/m1.avro', handle, adapter);

    const manifestFilesMsg = messages.find(m => m.type === 'loadManifestDataFiles') as any;
    assert.ok(manifestFilesMsg, 'loadManifestDataFiles message received');
    assert.strictEqual(manifestFilesMsg.files.length, 1);
    assert.strictEqual(manifestFilesMsg.files[0].path, 's3://warehouse/db/events/data/file1.parquet');
    assert.strictEqual(manifestFilesMsg.files[0].status, 'ADDED');
  });

  await test('Metadata Structure: HTML includes Snapshot Manifest Hierarchy and metadata version switcher', () => {
    const html = getMetadataStructureHtml('test-nonce', 'vscode-resource:', 's3://warehouse/db/events');
    assert.ok(!html.includes('onclick='), 'No inline onclick handler in HTML');
    assert.ok(html.includes('preview-btn'), 'Includes preview-btn class for delegated preview click handling');
    assert.ok(html.includes("'openParquetPreview'"), 'Includes openParquetPreview event posting');
    assert.ok(html.includes('Snapshot Manifest Hierarchy'), 'Includes Snapshot Manifest Hierarchy section title');
    assert.ok(html.includes('meta-file-select'), 'Includes metadata file selector dropdown');
    assert.ok(html.includes('view-meta-json-btn'), 'Includes View JSON Details button');
  });

  await test('Metadata Structure: openParquetPreview message opens parquet preview panel', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    let openedResource: string | undefined;
    (manager as any).openParquetPreviewPanel = async (res: string) => {
      openedResource = res;
    };

    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.MetadataStructure, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);

    (record.panel.webview as any)._receiveMessage({
      type: 'openParquetPreview',
      resourcePath: 's3://warehouse/db/events/data/file1.parquet',
    });

    assert.strictEqual(openedResource, 's3://warehouse/db/events/data/file1.parquet');
  });

  await test('Metadata Structure: openMetadataPanel message opens metadata detail panel', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    let openedMetaResource: string | undefined;
    (manager as any).openMetadataDetailPanel = async (res: string) => {
      openedMetaResource = res;
    };

    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.MetadataStructure, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);

    (record.panel.webview as any)._receiveMessage({
      type: 'openMetadataPanel',
      resourcePath: 's3://warehouse/db/events/metadata/v1.metadata.json',
    });

    assert.strictEqual(openedMetaResource, 's3://warehouse/db/events/metadata/v1.metadata.json');
  });

  await test('Metadata Structure: selectStructureMetadataFile switches metadata version', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter({
      async listMetadataVersions() {
        return [
          { resourcePath: 's3://warehouse/db/events/metadata/v2.metadata.json', label: 'v2.metadata.json', sortKey: 2 },
          { resourcePath: 's3://warehouse/db/events/metadata/v1.metadata.json', label: 'v1.metadata.json', sortKey: 1 },
        ];
      },
    });
    const qe = makeQueryEngine();
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.MetadataStructure, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    (record.panel.webview as any)._receiveMessage({
      type: 'selectStructureMetadataFile',
      tablePath: 's3://warehouse/db/events',
      metadataPath: 's3://warehouse/db/events/metadata/v1.metadata.json',
    });

    // Wait microtask
    await new Promise((r) => setImmediate(r));

    const metaArchMsg = messages.find(m => m.type === 'loadMetadataStructure') as any;
    assert.ok(metaArchMsg, 'loadMetadataStructure message received after version switch');
    assert.strictEqual(metaArchMsg.metadataFile, 's3://warehouse/db/events/metadata/v1.metadata.json');
    assert.strictEqual(metaArchMsg.availableMetadataFiles?.length, 2);
    assert.strictEqual(metaArchMsg.availableMetadataFiles[0].isLatest, true);
    assert.strictEqual(metaArchMsg.availableMetadataFiles[1].isLatest, false);
  });

  await test('Metadata Structure: reveals metadata node path in tree view', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const qe = makeQueryEngine();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      qe as any,
      (p) => { revealedPath = p; },
    );

    // Opening with table path reveals tablePath/metadata
    await manager.openMetadataStructurePanel('s3://warehouse/db/events', handle, adapter);
    assert.strictEqual(revealedPath, 's3://warehouse/db/events/metadata');

    // Opening with tablePath/metadata also normalizes and reveals tablePath/metadata
    revealedPath = '';
    await manager.openMetadataStructurePanel('s3://warehouse/db/events/metadata', handle, adapter);
    assert.strictEqual(revealedPath, 's3://warehouse/db/events/metadata');
  });

  // ─── Ad-hoc Query Table Path Resolution ──────────────────────────────────

  await test('Ad-hoc query panel: queries Iceberg table path by resolving active parquet data files', async () => {
    const logger = makeLogger();
    const tempFilesCleaned: string[] = [];
    const adapter = makeStorageAdapter({
      async fetchFileToTemp(_handle: any, p: string) {
        return `/tmp/${path.basename(p)}`;
      },
      async deleteTemp(p: string) {
        tempFilesCleaned.push(p);
      },
    });
    let queriedFiles: string[] | string = [];
    let queriedTableName: string | undefined;
    const qe = makeQueryEngine({
      async runAdHocQuery(tempPath: string | string[], _sql: string, tableName?: string): Promise<QueryResult> {
        queriedFiles = tempPath;
        queriedTableName = tableName;
        return {
          rows: [{ id: 1, event_name: 'click' }],
          columnNames: ['id', 'event_name'],
          rowCount: 1,
          wasCapped: false,
          durationMs: 5,
        };
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openAdHocQueryPanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.AdHocQuery, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Ad-hoc query panel registered');

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    // Trigger runQuery
    await (manager as any).executeAdHocQuery(
      record.gate,
      key,
      's3://warehouse/db/events',
      handle,
      adapter,
      'SELECT * FROM data',
    );

    assert.deepStrictEqual(queriedFiles, ['/tmp/file1.parquet'], 'Resolved and queried table parquet data file');
    assert.strictEqual(queriedTableName, 'events', 'Passed events table alias');
    const resultMsg = messages.find(m => m.type === 'loadQueryResult') as any;
    assert.ok(resultMsg, 'loadQueryResult message sent to webview');
    assert.strictEqual(resultMsg.result.rowCount, 1);
    assert.ok(tempFilesCleaned.includes('/tmp/file1.parquet'), 'Temp files cleaned up after query');
  });

  await test('Ad-hoc query panel: falls back to child table when queried on namespace directory path', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter({
      async listMetadataVersions(_handle: any, p: string) {
        if (p === 's3://rk-iceberg/dogs/testdogs.db/dogtable1') {
          return [{ resourcePath: 's3://rk-iceberg/dogs/testdogs.db/dogtable1/metadata/v1.metadata.json', label: 'v1.metadata.json', sortKey: 1 }];
        }
        return [];
      },
      async listTables(_handle: any, p: string) {
        if (p === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        return [];
      },
      async isTable(_handle: any, p: string) {
        return p === 's3://rk-iceberg/dogs/testdogs.db/dogtable1';
      },
      async fetchFileToTemp(_handle: any, p: string) {
        return `/tmp/${path.basename(p)}`;
      },
      async deleteTemp() {},
    });
    let queriedTableName: string | undefined;
    const qe = makeQueryEngine({
      async runAdHocQuery(_paths: any, _sql: any, tableName?: string): Promise<QueryResult> {
        queriedTableName = tableName;
        return {
          rows: [{ id: 1, breed: 'corgi' }],
          columnNames: ['id', 'breed'],
          rowCount: 1,
          wasCapped: false,
          durationMs: 5,
        };
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openAdHocQueryPanel('s3://rk-iceberg/dogs/testdogs.db', handle, adapter);
    const key = panelRegistryKey(PanelType.AdHocQuery, 's3://rk-iceberg/dogs/testdogs.db');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Ad-hoc query panel registered');

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    // Run query against the namespace directory path
    await (manager as any).executeAdHocQuery(
      record.gate,
      key,
      's3://rk-iceberg/dogs/testdogs.db',
      handle,
      adapter,
      'SELECT * FROM data',
    );

    assert.strictEqual(queriedTableName, 'dogtable1', 'Resolved child table name dogtable1');
    const resultMsg = messages.find(m => m.type === 'loadQueryResult') as any;
    assert.ok(resultMsg, 'loadQueryResult message sent to webview');
    assert.strictEqual(resultMsg.result.rowCount, 1);
  });

  await test('Connection Dashboard: discovers nested namespace tables (dogs -> testdogs.db -> dogtable1)', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter({
      async listSchemas() {
        return ['s3://rk-iceberg/dogs'];
      },
      async listTables(_handle: any, p: string) {
        if (p === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        if (p === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        return [];
      },
      async isTable(_handle: any, p: string) {
        return p === 's3://rk-iceberg/dogs/testdogs.db/dogtable1';
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);

    const config: ConnectionConfig = {
      id: 'conn-dogs',
      label: 'Dogs Warehouse',
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      sslVerification: true,
      savedAt: 1700000000000,
    };

    await manager.openConnectionDashboardPanel(config, handle, adapter);
    const key = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-dogs');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Connection Dashboard registered');

    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadConnectionDashboard');
    assert.strictEqual(lastMsg.schemasCount, 1, 'Only direct warehouse subdirectories counted as schemas');
    assert.strictEqual(lastMsg.tablesCount, 1, 'Discovered 1 actual table');
    assert.strictEqual(lastMsg.tables[0].name, 'dogtable1', 'Table name is dogtable1');
    assert.strictEqual(lastMsg.tables[0].path, 's3://rk-iceberg/dogs/testdogs.db/dogtable1');
    assert.strictEqual(lastMsg.tables[0].schema, 'dogs.testdogs.db', 'Nested namespace formatted as dogs.testdogs.db');
    assert.strictEqual(lastMsg.schemas.length, 1);
    assert.strictEqual(lastMsg.schemas[0].name, 'dogs', 'Schema name is direct subdirectory dogs');
    assert.strictEqual(lastMsg.schemas[0].path, 's3://rk-iceberg/dogs', 'Schema path is s3://rk-iceberg/dogs');
    assert.strictEqual(lastMsg.schemas[0].tableCount, 1, 'Discovered 1 table under dogs schema');
  });

  // ─── SQL Analyzer & Ad-Hoc Query Budgeting ─────────────────────────────────

  await test('SQL Analyzer: parses simple scan and extracts LIMIT', () => {
    const res1 = analyzeQuery('SELECT * FROM data LIMIT 100');
    assert.strictEqual(res1.isSimpleScan, true);
    assert.strictEqual(res1.requestedLimit, 100);
    assert.strictEqual(res1.hasFilterOrTransform, false);

    const res2 = analyzeQuery('SELECT id, name FROM events');
    assert.strictEqual(res2.isSimpleScan, true);
    assert.strictEqual(res2.requestedLimit, undefined);
    assert.strictEqual(res2.hasFilterOrTransform, false);
  });

  await test('SQL Analyzer: identifies WHERE, GROUP BY, ORDER BY, and aggregates', () => {
    const resWhere = analyzeQuery('SELECT * FROM data WHERE id > 10 LIMIT 50');
    assert.strictEqual(resWhere.isSimpleScan, false);
    assert.strictEqual(resWhere.requestedLimit, 50);
    assert.strictEqual(resWhere.hasFilterOrTransform, true);

    const resGroup = analyzeQuery('SELECT id, count(*) FROM data GROUP BY id');
    assert.strictEqual(resGroup.isSimpleScan, false);
    assert.strictEqual(resGroup.hasFilterOrTransform, true);

    const resOrder = analyzeQuery('SELECT * FROM data ORDER BY ts DESC LIMIT 10');
    assert.strictEqual(resOrder.isSimpleScan, false);
    assert.strictEqual(resOrder.requestedLimit, 10);
    assert.strictEqual(resOrder.hasFilterOrTransform, true);

    const resAgg = analyzeQuery('SELECT count(*) FROM data');
    assert.strictEqual(resAgg.isSimpleScan, false);
    assert.strictEqual(resAgg.hasFilterOrTransform, true);
  });

  await test('Ad-hoc query resolution: stops file accumulation when single file has enough rows for simple scan', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const files50: DataFileRow[] = [];
    for (let i = 0; i < 50; i++) {
      files50.push({
        status: 1,
        filePath: `s3://warehouse/db/events/data/file_${i}.parquet`,
        fileFormat: 'PARQUET',
        recordCount: 200,
        fileSizeBytes: 1024 * 100,
      });
    }
    const qe = makeQueryEngine({
      async parseManifestFile(): Promise<DataFileRow[]> {
        return files50;
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    const res = await (manager as any).resolveTableParquetFiles(
      handle,
      's3://warehouse/db/events',
      adapter,
      'SELECT * FROM data LIMIT 100',
    );

    assert.ok(typeof res !== 'string', 'Resolution succeeded');
    assert.strictEqual(res.parquetPaths.length, 1, 'Only 1 file needed since it has 200 rows >= 100 limit');
    assert.strictEqual(res.accumulatedRecords, 200);
    assert.strictEqual(res.isSampled, true);
    assert.strictEqual(res.totalDataFiles, 50);
  });

  await test('Ad-hoc query resolution: accumulates micro-files until row target is met', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const microFiles: DataFileRow[] = [];
    for (let i = 0; i < 50; i++) {
      microFiles.push({
        status: 1,
        filePath: `s3://warehouse/db/events/data/micro_${i}.parquet`,
        fileFormat: 'PARQUET',
        recordCount: 5,
        fileSizeBytes: 1024 * 10,
      });
    }
    const qe = makeQueryEngine({
      async parseManifestFile(): Promise<DataFileRow[]> {
        return microFiles;
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    const res = await (manager as any).resolveTableParquetFiles(
      handle,
      's3://warehouse/db/events',
      adapter,
      'SELECT * FROM data LIMIT 100',
    );

    assert.ok(typeof res !== 'string', 'Resolution succeeded');
    assert.strictEqual(res.parquetPaths.length, 20, 'Accumulated 20 files (20 * 5 = 100 rows)');
    assert.strictEqual(res.accumulatedRecords, 100);
    assert.strictEqual(res.isSampled, true);
  });

  await test('Ad-hoc query resolution: sorts smallest files first for simple scan', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const mixedFiles: DataFileRow[] = [
      {
        status: 1,
        filePath: 's3://warehouse/db/events/data/huge_compaction.parquet',
        fileFormat: 'PARQUET',
        recordCount: 50000,
        fileSizeBytes: 40 * 1024 * 1024, // 40 MB
      },
      {
        status: 1,
        filePath: 's3://warehouse/db/events/data/small_recent.parquet',
        fileFormat: 'PARQUET',
        recordCount: 500,
        fileSizeBytes: 200 * 1024, // 200 KB
      },
      {
        status: 1,
        filePath: 's3://warehouse/db/events/data/medium.parquet',
        fileFormat: 'PARQUET',
        recordCount: 2000,
        fileSizeBytes: 2 * 1024 * 1024, // 2 MB
      },
    ];
    const qe = makeQueryEngine({
      async parseManifestFile(): Promise<DataFileRow[]> {
        return mixedFiles;
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    const res = await (manager as any).resolveTableParquetFiles(
      handle,
      's3://warehouse/db/events',
      adapter,
      'SELECT * FROM data LIMIT 100',
    );

    assert.ok(typeof res !== 'string', 'Resolution succeeded');
    assert.strictEqual(res.parquetPaths.length, 1, 'Smallest file alone satisfied the 100-row limit');
    assert.strictEqual(res.parquetPaths[0], 's3://warehouse/db/events/data/small_recent.parquet', 'Selected 200KB file first');
    assert.strictEqual(res.accumulatedBytes, 200 * 1024);
  });

  await test('Ad-hoc query resolution: halts file accumulation when byte budget ceiling (50MB) is reached', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    const largeFiles: DataFileRow[] = [];
    for (let i = 0; i < 20; i++) {
      largeFiles.push({
        status: 1,
        filePath: `s3://warehouse/db/events/data/part_${i}.parquet`,
        fileFormat: 'PARQUET',
        recordCount: 100,
        fileSizeBytes: 10 * 1024 * 1024, // 10 MB each
      });
    }
    const qe = makeQueryEngine({
      async parseManifestFile(): Promise<DataFileRow[]> {
        return largeFiles;
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    const res = await (manager as any).resolveTableParquetFiles(
      handle,
      's3://warehouse/db/events',
      adapter,
      'SELECT id, count(*) FROM data GROUP BY id',
    );

    assert.ok(typeof res !== 'string', 'Resolution succeeded');
    assert.strictEqual(res.parquetPaths.length, 5, 'Stopped after 5 files (5 * 10MB = 50MB ceiling)');
    assert.strictEqual(res.accumulatedBytes, 50 * 1024 * 1024);
  });

  await test('Ad-hoc query resolution: aborts early on schema mismatch before fetching manifests or parquet files', async () => {
    const logger = makeLogger();
    let tempFilesFetched = 0;
    const adapter = makeStorageAdapter({
      async fetchFileToTemp() {
        tempFilesFetched++;
        return '/tmp/manifest.avro';
      },
    });
    const qe = makeQueryEngine({
      async validateQuery(_sql: string, columns: any[]) {
        assert.ok(columns.length > 0, 'Schema columns should be passed to validateQuery');
        return { kind: 'QueryError', class: 'internal', message: 'Binder Error: Referenced column "applicationid" not found' };
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    const res = await (manager as any).resolveTableParquetFiles(
      handle,
      's3://warehouse/db/events',
      adapter,
      'SELECT * FROM data WHERE applicationid = 1',
    );

    assert.ok(typeof res !== 'string');
    assert.strictEqual((res as any).kind, 'QueryError', 'Should return QueryError');
    assert.ok((res as any).message.includes('applicationid'));
    assert.strictEqual(tempFilesFetched, 0, 'Should not fetch any manifest or parquet files');
  });

  await test('Ad-hoc query panel: displays informative sampling and limit banner in webview', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter({
      async fetchFileToTemp(_handle: any, p: string) {
        return `/tmp/${path.basename(p)}`;
      },
      async deleteTemp() {},
    });
    const qe = makeQueryEngine({
      async parseManifestFile(): Promise<DataFileRow[]> {
        return [
          { status: 1, filePath: 's3://warehouse/db/events/data/f1.parquet', fileFormat: 'PARQUET', recordCount: 1000, fileSizeBytes: 1024 * 500 },
          { status: 1, filePath: 's3://warehouse/db/events/data/f2.parquet', fileFormat: 'PARQUET', recordCount: 1000, fileSizeBytes: 1024 * 500 },
        ];
      },
      async runAdHocQuery(): Promise<QueryResult> {
        return {
          rows: [{ id: 1 }],
          columnNames: ['id'],
          rowCount: 1,
          wasCapped: false,
          durationMs: 10,
        };
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger, qe as any);

    await manager.openAdHocQueryPanel('s3://warehouse/db/events', handle, adapter);
    const key = panelRegistryKey(PanelType.AdHocQuery, 's3://warehouse/db/events');
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Ad-hoc query panel registered');

    const messages: PostedMessage[] = [];
    record.gate.post = (msg: PostedMessage) => messages.push(msg);

    await (manager as any).executeAdHocQuery(
      record.gate,
      key,
      's3://warehouse/db/events',
      handle,
      adapter,
      'SELECT * FROM data LIMIT 100',
    );

    const bannerMsg = messages.find(m => m.type === 'showCapBanner') as any;
    assert.ok(bannerMsg, 'showCapBanner message sent');
    assert.ok(bannerMsg.message.includes('Read 1 file(s)'), `Banner says read 1 file: ${bannerMsg.message}`);
    assert.ok(bannerMsg.message.includes('satisfy LIMIT 100'), `Banner mentions limit 100: ${bannerMsg.message}`);
  });

  // ─── Tree Node Commands Integration ────────────────────────────────────────

  await test('Tree items: table node has openTableOverview command', () => {
    const item = makeTableItem('s3://warehouse/db/events', 'events', 's3://warehouse/db');
    assert.ok(item.command, 'Table item has command');
    assert.strictEqual(item.command?.command, 'icebergExplorer.openTableOverview');
    assert.deepStrictEqual(item.command?.arguments, ['s3://warehouse/db/events']);
  });

  await test('Tree items: metadata folder node has openMetadataStructure command', () => {
    const item = makeMetadataFolderItem('s3://warehouse/db/events');
    assert.ok(item.command, 'Metadata folder item has command');
    assert.strictEqual(item.command?.command, 'icebergExplorer.openMetadataStructure');
    assert.deepStrictEqual(item.command?.arguments, ['s3://warehouse/db/events']);
  });

  await test('Tree items: schema node has openSchemaOverview command', () => {
    const item = makeSchemaItem('s3://warehouse/db', 'db', 's3://warehouse');
    assert.ok(item.command, 'Schema item has command');
    assert.strictEqual(item.command?.command, 'icebergExplorer.openSchemaOverview');
    assert.deepStrictEqual(item.command?.arguments, ['s3://warehouse/db', 'db']);
  });

  await test('Breadcrumb navigate: segment 0 (bucket) navigates to top-most overview (Connection Dashboard)', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
      () => [{ id: 'conn-1', label: 'My Warehouse', connectionType: 's3', warehousePath: 's3://warehouse', sslVerification: true, savedAt: 1000 }],
    );

    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);
    const tableKey = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const tableRecord = (manager as any).registry.get(tableKey);
    assert.ok(tableRecord, 'Table overview opened');

    // Simulate breadcrumb click on segment 0 ("warehouse" bucket)
    (tableRecord.panel.webview as any)._receiveMessage({ type: 'breadcrumbNavigate', segment: 0 });

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse');
    const dashKey = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-1');
    const dashRecord = (manager as any).registry.get(dashKey);
    assert.ok(dashRecord, 'Connection dashboard opened on bucket breadcrumb navigation');
    const lastMsg = dashRecord.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadConnectionDashboard');
    assert.strictEqual(lastMsg.initialFilter, '');
  });

  await test('Breadcrumb navigate: segment 1 (schema) navigates to Schema Overview', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
      () => [{ id: 'conn-1', label: 'My Warehouse', connectionType: 's3', warehousePath: 's3://warehouse', sslVerification: true, savedAt: 1000 }],
    );

    await manager.openTableOverviewPanel('s3://warehouse/db/events', handle, adapter);
    const tableKey = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const tableRecord = (manager as any).registry.get(tableKey);

    // Simulate breadcrumb click on segment 1 ("db" schema)
    (tableRecord.panel.webview as any)._receiveMessage({ type: 'breadcrumbNavigate', segment: 1 });

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse/db');
    const schemaKey = panelRegistryKey(PanelType.SchemaOverview, 's3://warehouse/db');
    const schemaRecord = (manager as any).registry.get(schemaKey);
    assert.ok(schemaRecord, 'Schema overview opened on schema breadcrumb navigation');
    const lastMsg = schemaRecord.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadSchemaOverview');
    assert.strictEqual(lastMsg.schemaName, 'db');
    assert.strictEqual(lastMsg.tablesCount, 1);
  });

  await test('Breadcrumb navigate: segment 2 (table) in child panel navigates to Table Overview', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
    );

    await manager.openMetadataDetailPanel('s3://warehouse/db/events/metadata/v1.metadata.json', handle, adapter);
    const metaKey = panelRegistryKey(PanelType.MetadataDetail, 's3://warehouse/db/events/metadata/v1.metadata.json');
    const metaRecord = (manager as any).registry.get(metaKey);

    // Simulate breadcrumb click on segment 2 ("events" table)
    (metaRecord.panel.webview as any)._receiveMessage({ type: 'breadcrumbNavigate', segment: 2 });

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse/db/events');
    const tableKey = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const tableRecord = (manager as any).registry.get(tableKey);
    assert.ok(tableRecord, 'Table overview opened on table breadcrumb navigation');
  });

  await test('Breadcrumb navigate in Schema Overview: segment 0 (bucket) navigates to Connection Dashboard', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
      () => [{ id: 'conn-1', label: 'My Warehouse', connectionType: 's3', warehousePath: 's3://warehouse', sslVerification: true, savedAt: 1000 }],
    );

    await manager.openSchemaOverviewPanel('s3://warehouse/db', handle, adapter, 'db');
    const schemaKey = panelRegistryKey(PanelType.SchemaOverview, 's3://warehouse/db');
    const schemaRecord = (manager as any).registry.get(schemaKey);

    // Click segment 0 (warehouse)
    (schemaRecord.panel.webview as any)._receiveMessage({ type: 'breadcrumbNavigate', segment: 0 });
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse');
    const dashKey = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-1');
    const dashRecord = (manager as any).registry.get(dashKey);
    assert.ok(dashRecord, 'Connection Dashboard opened from Schema Overview breadcrumb');
  });

  await test('Webview link: clicking table link in Schema Overview reveals table in tree view', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
    );

    const schemaPanel = await manager.openSchemaOverviewPanel('s3://warehouse/db', handle, adapter, 'db');
    assert.strictEqual(revealedPath, 's3://warehouse/db');

    // Simulate clicking a table link in Schema Overview
    (schemaPanel.webview as any)._receiveMessage({ type: 'openTableOverview', resourcePath: 's3://warehouse/db/events' });
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse/db/events');
    const tableKey = panelRegistryKey(PanelType.TableOverview, 's3://warehouse/db/events');
    const tableRecord = (manager as any).registry.get(tableKey);
    assert.ok(tableRecord, 'Table overview opened from schema panel table link');
  });

  await test('Webview link: clicking schema card in Connection Dashboard reveals schema in tree view', async () => {
    const logger = makeLogger();
    const adapter = makeStorageAdapter();
    let revealedPath = '';
    const manager = new WebviewPanelManager(
      makeContext(),
      adapter,
      logger,
      undefined,
      (p) => { revealedPath = p; },
      () => [{ id: 'conn-1', label: 'My Warehouse', connectionType: 's3', warehousePath: 's3://warehouse', sslVerification: true, savedAt: 1000 }],
    );

    await manager.openConnectionDashboardPanel(
      { id: 'conn-1', label: 'My Warehouse', connectionType: 's3', warehousePath: 's3://warehouse', sslVerification: true, savedAt: 1000 },
      handle,
      adapter,
    );
    assert.strictEqual(revealedPath, 's3://warehouse');

    const dashKey = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-1');
    const dashRecord = (manager as any).registry.get(dashKey);

    // Simulate clicking a schema card
    (dashRecord.panel.webview as any)._receiveMessage({ type: 'openSchemaOverview', schemaPath: 's3://warehouse/db', schemaName: 'db' });
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(revealedPath, 's3://warehouse/db');
    const schemaKey = panelRegistryKey(PanelType.SchemaOverview, 's3://warehouse/db');
    const schemaRecord = (manager as any).registry.get(schemaKey);
    assert.ok(schemaRecord, 'Schema overview opened from dashboard schema card');
  });

  await test('Connection Dashboard: retrying by opening panel again reloads data if panel was in error state', async () => {
    const logger = makeLogger();
    let shouldFail = true;
    const adapter = makeStorageAdapter({
      async listSchemas() {
        if (shouldFail) {
          return { kind: 'StorageError', class: 'internal', message: 'Connection unavailable' };
        }
        return ['db'];
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);
    const config: ConnectionConfig = {
      id: 'conn-retry-1',
      label: 'Retry Warehouse',
      connectionType: 's3',
      warehousePath: 's3://warehouse',
      sslVerification: true,
      savedAt: 1000,
    };

    // First attempt fails
    await manager.openConnectionDashboardPanel(config, handle, adapter);
    const key = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-retry-1');
    const record = (manager as any).registry.get(key);
    assert.ok(record);
    assert.strictEqual(record.gate.hasError(), true);

    // Connection becomes available; user retries by clicking tree node (which calls openConnectionDashboardPanel)
    shouldFail = false;
    await manager.openConnectionDashboardPanel(config, handle, adapter);

    assert.strictEqual(record.gate.hasError(), false);
    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadConnectionDashboard');
    assert.strictEqual(lastMsg.schemasCount, 1);
  });

  await test('Connection Dashboard: retryConnectionDashboardIfError reloads data when panel is in error state', async () => {
    const logger = makeLogger();
    let shouldFail = true;
    const adapter = makeStorageAdapter({
      async listSchemas() {
        if (shouldFail) {
          return { kind: 'StorageError', class: 'internal', message: 'Connection unavailable' };
        }
        return ['db'];
      },
    });
    const manager = new WebviewPanelManager(makeContext(), adapter, logger);
    const config: ConnectionConfig = {
      id: 'conn-retry-2',
      label: 'Retry Warehouse 2',
      connectionType: 's3',
      warehousePath: 's3://warehouse',
      sslVerification: true,
      savedAt: 1000,
    };

    await manager.openConnectionDashboardPanel(config, handle, adapter);
    const key = panelRegistryKey(PanelType.ConnectionDashboard, 'conn-retry-2');
    const record = (manager as any).registry.get(key);
    assert.strictEqual(record.gate.hasError(), true);

    shouldFail = false;
    await manager.retryConnectionDashboardIfError(config, handle, adapter);

    assert.strictEqual(record.gate.hasError(), false);
    const lastMsg = record.gate.getTerminalMessage() as any;
    assert.strictEqual(lastMsg.type, 'loadConnectionDashboard');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

void runTests();
