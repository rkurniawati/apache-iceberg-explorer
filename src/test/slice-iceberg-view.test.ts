/**
 * Slice integration test — Apache Iceberg View Support.
 *
 * Tests:
 * 1. View metadata detection (isIcebergViewMetadata)
 * 2. SQL table reference extraction (extractTableReferencesFromSql)
 * 3. View metadata normalization (extractIcebergViewDetails)
 * 4. Tree item creation (makeViewItem)
 * 5. Query rejection with helpful guidance (resolveTableParquetFiles)
 * 6. WebviewPanelManager View Overview integration
 * 7. WebviewPanelManager Data Preview rejection for views
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Uri } from 'vscode';

import {
  isIcebergViewMetadata,
  extractTableReferencesFromSql,
  extractIcebergViewDetails,
} from '../utils/icebergView';
import { makeViewItem } from '../tree/types';
import { QueryEngine } from '../query/index';
import { WebviewPanelManager } from '../panels/webviewPanelManager';
import { PanelType, panelRegistryKey } from '../panels/types';
import type { StorageAdapter } from '../storage/StorageAdapter';
import type { ActiveConnectionHandle } from '../storage/types';
import type { ILogger } from '../extension';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const VIEW_METADATA_PATH = path.join(FIXTURE_DIR, 'view.metadata.json');
const V1_METADATA_PATH = path.join(FIXTURE_DIR, 'v1.metadata.json');
const V2_METADATA_PATH = path.join(FIXTURE_DIR, 'v2.metadata.json');
const V3_METADATA_PATH = path.join(FIXTURE_DIR, 'v3.metadata.json');

const testExtensionUri = { fsPath: path.resolve(__dirname, '../..') } as unknown as Uri;

// ---------------------------------------------------------------------------
// Test logger
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg) { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg) { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};

function clearLog() { testLogLines.length = 0; }

function makeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose: () => void }[] = [];
  return {
    subscriptions,
    extensionUri: testExtensionUri,
  } as unknown as vscode.ExtensionContext;
}

// ---------------------------------------------------------------------------
// Minimal test runner
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
  console.log('\nIceberg View Support Slice Tests:');

  // ── 1. Detection ──────────────────────────────────────────────────────────

  await run('isIcebergViewMetadata: identifies view.metadata.json as view', () => {
    const raw = JSON.parse(fs.readFileSync(VIEW_METADATA_PATH, 'utf8'));
    assert.strictEqual(isIcebergViewMetadata(raw), true);
  });

  await run('isIcebergViewMetadata: rejects standard table metadata (v1, v2, v3)', () => {
    const v1 = JSON.parse(fs.readFileSync(V1_METADATA_PATH, 'utf8'));
    const v2 = JSON.parse(fs.readFileSync(V2_METADATA_PATH, 'utf8'));
    const v3 = JSON.parse(fs.readFileSync(V3_METADATA_PATH, 'utf8'));

    assert.strictEqual(isIcebergViewMetadata(v1), false);
    assert.strictEqual(isIcebergViewMetadata(v2), false);
    assert.strictEqual(isIcebergViewMetadata(v3), false);
    assert.strictEqual(isIcebergViewMetadata(null), false);
    assert.strictEqual(isIcebergViewMetadata({}), false);
    assert.strictEqual(isIcebergViewMetadata('invalid'), false);
  });

  await run('isIcebergViewMetadata: detects structural view without view-uuid', () => {
    const structuralView = {
      formatVersion: 1,
      versions: [
        {
          versionId: 1,
          representations: [{ type: 'sql', sql: 'SELECT 1', dialect: 'spark' }],
        },
      ],
    };
    assert.strictEqual(isIcebergViewMetadata(structuralView), true);
  });

  // ── 2. Table References Extraction ────────────────────────────────────────

  await run('extractTableReferencesFromSql: extracts tables from SQL', () => {
    const sql1 = `
      SELECT AppUsername, Count
      FROM events
      WHERE (RecordType = 2)
    `;
    assert.deepStrictEqual(extractTableReferencesFromSql(sql1), ['events']);

    const sql2 = `
      SELECT *
      FROM datalake.events e
      JOIN "audit_logs" a ON e.id = a.event_id
      LEFT OUTER JOIN \`metrics\` m ON e.id = m.ref_id
    `;
    assert.deepStrictEqual(extractTableReferencesFromSql(sql2), [
      'datalake.events',
      'audit_logs',
      'metrics',
    ]);

    assert.deepStrictEqual(extractTableReferencesFromSql(''), []);
    assert.deepStrictEqual(extractTableReferencesFromSql(undefined as any), []);
  });

  // ── 3. View Details Extraction ────────────────────────────────────────────

  await run('extractIcebergViewDetails: normalizes view properties and SQL', () => {
    const raw = JSON.parse(fs.readFileSync(VIEW_METADATA_PATH, 'utf8'));
    const details = extractIcebergViewDetails(raw);

    assert.strictEqual(details.viewUuid, 'f76d529e-7c11-4da7-afde-65e95901aece');
    assert.strictEqual(details.formatVersion, 1);
    assert.strictEqual(details.location, 's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53');
    assert.strictEqual(details.currentVersionId, 1);
    assert.strictEqual(details.defaultCatalog, 'gdp_iceberg');
    assert.deepStrictEqual(details.defaultNamespace, ['datalake']);
    assert.strictEqual(details.viewDialect, 'trino');
    assert.ok(details.viewSql?.includes('FROM\n  events\nWHERE (RecordType = 2)'));
    assert.deepStrictEqual(details.referencedTables, ['events']);
    assert.strictEqual(details.versions.length, 1);
    assert.strictEqual(details.versionLog.length, 1);
  });

  // ── 4. Tree View ──────────────────────────────────────────────────────────

  await run('makeViewItem: creates item with view nodeType and eye icon', () => {
    const item = makeViewItem('s3://bucket/datalake.db/exception_view', 'exception_view', 's3://bucket/datalake.db');
    assert.strictEqual(item.nodeType, 'view');
    assert.strictEqual(item.label, 'exception_view');
    assert.strictEqual((item.iconPath as any).id, 'eye');
    assert.strictEqual(item.command?.command, 'icebergExplorer.openTableOverview');
  });

  // ── 5. View Query Rejection & Guidance ────────────────────────────────────

  await run('WebviewPanelManager: resolveTableParquetFiles informs views are metadata-only', async () => {
    const viewRaw = JSON.parse(fs.readFileSync(VIEW_METADATA_PATH, 'utf8'));
    const mockAdapter: Partial<StorageAdapter> = {
      isTable: async () => true,
      fetchMetadataJson: async () => viewRaw,
      listMetadataVersions: async () => [
        {
          label: '00000.metadata.json',
          resourcePath: 's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53/metadata/00000.metadata.json',
          sortKey: 0,
        },
      ],
    };

    const handle: ActiveConnectionHandle = {
      warehousePath: 's3a://ltr-test',
      storageType: 's3-compatible',
    } as unknown as ActiveConnectionHandle;

    const qe = new QueryEngine(testLogger, testExtensionUri);
    const manager = new WebviewPanelManager(makeContext(), mockAdapter as StorageAdapter, testLogger, qe);

    const result = await (manager as any).resolveTableParquetFiles(
      handle,
      's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53',
      mockAdapter,
    );

    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('is an Apache Iceberg View'));
    assert.ok(result.includes('references "events"'));
    assert.ok(result.includes('metadata-only'));
  });

  // ── 6. WebviewPanelManager View Overview ──────────────────────────────────

  await run('WebviewPanelManager: openTableOverviewPanel populates view properties without snapshot errors', async () => {
    clearLog();
    const viewRaw = JSON.parse(fs.readFileSync(VIEW_METADATA_PATH, 'utf8'));

    const mockAdapter: Partial<StorageAdapter> = {
      isTable: async () => true,
      fetchMetadataJson: async () => viewRaw,
      listMetadataVersions: async () => [
        {
          label: '00000.metadata.json',
          resourcePath: 's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53/metadata/00000.metadata.json',
          sortKey: 0,
        },
      ],
      listTables: async () => [],
    };

    const mockHandle: ActiveConnectionHandle = {
      warehousePath: 's3a://ltr-test',
      storageType: 's3-compatible',
    } as unknown as ActiveConnectionHandle;

    const manager = new WebviewPanelManager(makeContext(), mockAdapter as StorageAdapter, testLogger);
    const viewPath = 's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53';

    await manager.openTableOverviewPanel(viewPath, mockHandle, mockAdapter as StorageAdapter);

    const key = panelRegistryKey(PanelType.TableOverview, viewPath);
    const record = (manager as any).registry.get(key);
    assert.ok(record, 'Panel should be registered');

    const overviewMsg = record.gate.getTerminalMessage() as any;
    assert.ok(overviewMsg, 'loadTableOverview message should be posted');
    assert.strictEqual(overviewMsg.type, 'loadTableOverview');
    assert.strictEqual(overviewMsg.isView, true, 'isView should be true');
    assert.strictEqual(overviewMsg.viewUuid, 'f76d529e-7c11-4da7-afde-65e95901aece');
    assert.strictEqual(overviewMsg.viewDialect, 'trino');
    assert.ok(overviewMsg.viewSql.includes('FROM\n  events\nWHERE (RecordType = 2)'));
    assert.deepStrictEqual(overviewMsg.defaultNamespace, ['datalake']);
    assert.strictEqual(overviewMsg.snapshots.length, 0, 'views should have 0 snapshots');
    assert.strictEqual(overviewMsg.currentSnapshotId, null);
    assert.strictEqual(overviewMsg.columns.length, 33, 'schema should contain 33 fields from view');
  });

  // ── 7. WebviewPanelManager Data Preview Rejection ─────────────────────────

  await run('WebviewPanelManager: loadDataPreview informs preview unavailable for views', async () => {
    clearLog();
    const viewRaw = JSON.parse(fs.readFileSync(VIEW_METADATA_PATH, 'utf8'));

    const mockAdapter: Partial<StorageAdapter> = {
      isTable: async () => true,
      fetchMetadataJson: async () => viewRaw,
      listMetadataVersions: async () => [
        {
          label: '00000.metadata.json',
          resourcePath: 's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53/metadata/00000.metadata.json',
          sortKey: 0,
        },
      ],
      listTables: async () => [],
    };

    const mockHandle: ActiveConnectionHandle = {
      warehousePath: 's3a://ltr-test',
      storageType: 's3-compatible',
    } as unknown as ActiveConnectionHandle;

    const qe = new QueryEngine(testLogger, testExtensionUri);
    const manager = new WebviewPanelManager(makeContext(), mockAdapter as StorageAdapter, testLogger, qe);
    const messages: any[] = [];
    const fakeGate = { post: (msg: any) => messages.push(msg) };

    await (manager as any).loadDataPreview(
      fakeGate,
      's3a://ltr-test/datalake.db/exception_view-9250e55228b0434080f83910c9a99d53',
      mockHandle,
      mockAdapter as StorageAdapter,
    );

    const prevMsg = messages.find((m) => m.type === 'loadDataPreview');
    assert.ok(prevMsg, 'loadDataPreview message should be posted');
    assert.ok(prevMsg.error.includes('Data preview is not available for metadata-only views'));
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
})();
