/**
 * Slice integration test — Iceberg Table Location Mismatch & Loose Path Matching.
 *
 * Verifies:
 * 1. Location parsing (identifying origin cloud provider, bucket, and prefix from table location property).
 * 2. Location mismatch detection between table metadata location and actual filesystem location.
 * 3. Warning notification and logger warning triggered on location mismatch.
 * 4. Loose path matching resolving S3/GCS URIs to local paths starting from warehouse/schema/table.
 * 5. LocalFsAdapter fetchFileToTemp, fetchMetadataJson, and pathGuard with S3 URIs.
 * 6. WebviewPanelManager breadcrumb and panel loading with loose path matching.
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Uri } from 'vscode';

import {
  parseLocation,
  isLocationMismatch,
  LocationResolver,
  globalLocationResolver,
} from '../storage/locationResolver.js';
import { LocalFsAdapter } from '../storage/localFsAdapter.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { ILogger } from '../extension.js';
import { WebviewPanelManager } from '../panels/webviewPanelManager.js';
import { PanelType, panelRegistryKey } from '../panels/types.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: unknown) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Test logger
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg) { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg) { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};

function clearLog() {
  testLogLines.length = 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
  console.log('\nIceberg Table Location & Loose Path Matching Slice Tests:');

  await test('parseLocation: parses s3a URI into scheme, bucket, and segments', () => {
    const parsed = parseLocation('s3a://ruthk-test/ruthktest/events');
    assert.strictEqual(parsed.scheme, 's3a');
    assert.strictEqual(parsed.bucket, 'ruthk-test');
    assert.strictEqual(parsed.pathInBucket, 'ruthktest/events');
    assert.deepStrictEqual(parsed.segments, ['ruthktest', 'events']);
  });

  await test('parseLocation: parses s3 URI with deep warehouse path', () => {
    const parsed = parseLocation('s3://my-bucket/warehouse/analytics/fact_orders/metadata/snap-1.avro');
    assert.strictEqual(parsed.scheme, 's3');
    assert.strictEqual(parsed.bucket, 'my-bucket');
    assert.deepStrictEqual(parsed.segments, ['warehouse', 'analytics', 'fact_orders', 'metadata', 'snap-1.avro']);
  });

  await test('parseLocation: parses gs URI', () => {
    const parsed = parseLocation('gs://lake-bucket/db/tbl');
    assert.strictEqual(parsed.scheme, 'gs');
    assert.strictEqual(parsed.bucket, 'lake-bucket');
    assert.deepStrictEqual(parsed.segments, ['db', 'tbl']);
  });

  await test('isLocationMismatch: detects mismatch when metadata has s3a and table is local', () => {
    const mismatch = isLocationMismatch(
      's3a://ruthk-test/ruthktest/events',
      '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
    );
    assert.strictEqual(mismatch, true);
  });

  await test('isLocationMismatch: detects mismatch across different S3 buckets', () => {
    const mismatch = isLocationMismatch(
      's3://bucket-prod/warehouse/db/events',
      's3://bucket-backup/warehouse/db/events',
    );
    assert.strictEqual(mismatch, true);
  });

  await test('isLocationMismatch: detects mismatch across cloud providers (s3 to gs)', () => {
    const mismatch = isLocationMismatch(
      's3://aws-bucket/warehouse/db/events',
      'gs://gcp-bucket/warehouse/db/events',
    );
    assert.strictEqual(mismatch, true);
  });

  await test('isLocationMismatch: returns false when location matches currentTablePath', () => {
    const mismatch = isLocationMismatch(
      '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
      '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
    );
    assert.strictEqual(mismatch, false);
  });

  await test('isLocationMismatch: returns false when metadata location is absent', () => {
    assert.strictEqual(isLocationMismatch(undefined, '/local/path'), false);
    assert.strictEqual(isLocationMismatch('', '/local/path'), false);
  });

  await test('detectAndWarnMismatch: logs warning and shows warning message once per table', () => {
    const resolver = new LocationResolver(testLogger);
    clearLog();

    let warningShown: string | undefined;
    const origShowWarning = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = (msg: string) => {
      warningShown = msg;
      return Promise.resolve(undefined);
    };

    try {
      const warned1 = resolver.detectAndWarnMismatch(
        's3a://ruthk-test/ruthktest/events',
        '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
        '/Users/ruthk/Downloads/datamart-files/warehouse',
        'events',
      );
      assert.strictEqual(warned1, true);
      assert.ok(testLogLines.some(l => l.includes('[LocationMismatch]')));
      assert.ok(warningShown && warningShown.includes('ruthk-test'));

      // Second invocation for the same table should be deduplicated
      clearLog();
      warningShown = undefined;
      const warned2 = resolver.detectAndWarnMismatch(
        's3a://ruthk-test/ruthktest/events',
        '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
        '/Users/ruthk/Downloads/datamart-files/warehouse',
        'events',
      );
      assert.strictEqual(warned2, true);
      assert.strictEqual(testLogLines.length, 0, 'Should not log duplicate warning');
      assert.strictEqual(warningShown, undefined, 'Should not show duplicate toast');
    } finally {
      (vscode.window as any).showWarningMessage = origShowWarning;
    }
  });

  await test('detectAndWarnMismatch: formats message correctly for cross-bucket cloud destination', () => {
    const resolver = new LocationResolver(testLogger);
    let warningShown: string | undefined;
    const origShowWarning = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = (msg: string) => {
      warningShown = msg;
      return Promise.resolve(undefined);
    };

    try {
      const warned = resolver.detectAndWarnMismatch(
        's3://bucket-prod/warehouse/db/events',
        'gs://bucket-backup/warehouse/db/events',
        'gs://bucket-backup/warehouse',
        'events',
      );
      assert.strictEqual(warned, true);
      assert.ok(warningShown && warningShown.includes('S3 bucket "bucket-prod"'));
      assert.ok(warningShown && warningShown.includes('GS bucket "bucket-backup"'));
    } finally {
      (vscode.window as any).showWarningMessage = origShowWarning;
    }
  });

  await test('resolvePath: loose matching resolves S3 URI using schema and table path', () => {
    const resolver = new LocationResolver(testLogger);
    const resolved = resolver.resolvePath(
      's3a://ruthk-test/ruthktest/events/metadata/snap-5635894063419479941-1-1bb8c114-6acd-4ef8-9ecb-d17073d2e36f.avro',
      '/Users/ruthk/Downloads/datamart-files/warehouse',
      '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events',
    );

    assert.strictEqual(
      resolved,
      path.join(
        '/Users/ruthk/Downloads/datamart-files/warehouse/ruthktest/events/metadata',
        'snap-5635894063419479941-1-1bb8c114-6acd-4ef8-9ecb-d17073d2e36f.avro',
      ),
    );
  });

  await test('resolvePath: aligns warehouse folder name if present in S3 URI', () => {
    const resolver = new LocationResolver(testLogger);
    const resolved = resolver.resolvePath(
      's3://bucket/warehouse/db/tbl/data/part-000.parquet',
      '/data/warehouse',
    );

    assert.strictEqual(resolved, path.join('/data/warehouse', 'db', 'tbl', 'data', 'part-000.parquet'));
  });

  await test('resolvePath: preserves already existing local path', () => {
    const resolver = new LocationResolver(testLogger);
    const tmpFile = path.join(os.tmpdir(), 'test-local-file.json');
    fs.writeFileSync(tmpFile, '{}');
    try {
      const resolved = resolver.resolvePath(tmpFile, os.tmpdir());
      assert.strictEqual(resolved, tmpFile);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  await test('LocalFsAdapter: fetchFileToTemp resolves S3 URI with loose matching without path traversal error', async () => {
    const tempWarehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'iceberg-wh-'));
    const metaDir = path.join(tempWarehouse, 'ruthktest', 'events', 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });

    const avroFileName = 'snap-5635894063419479941-1-1bb8c114-6acd-4ef8-9ecb-d17073d2e36f.avro';
    const localAvroPath = path.join(metaDir, avroFileName);
    fs.writeFileSync(localAvroPath, 'mock-avro-bytes');

    const handle: ActiveConnectionHandle = {
      connectionType: 'local',
      warehousePath: tempWarehouse,
    };

    const adapter = new LocalFsAdapter(testLogger);
    clearLog();

    try {
      // Pass the original S3 URI as stored in Iceberg metadata
      const s3Uri = `s3a://ruthk-test/ruthktest/events/metadata/${avroFileName}`;
      const tempResult = await adapter.fetchFileToTemp(handle, s3Uri);

      assert.ok(typeof tempResult === 'string', `Expected string temp file path, got ${JSON.stringify(tempResult)}`);
      assert.ok(fs.existsSync(tempResult), 'Temp file must exist');
      assert.strictEqual(fs.readFileSync(tempResult, 'utf-8'), 'mock-avro-bytes');
      await adapter.deleteTemp(tempResult);
    } finally {
      fs.rmSync(tempWarehouse, { recursive: true, force: true });
    }
  });

  await test('LocalFsAdapter: fetchMetadataJson reads metadata via S3 URI with loose matching', async () => {
    const tempWarehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'iceberg-wh-'));
    const metaDir = path.join(tempWarehouse, 'datalake', 'events', 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });

    const metaFile = '00001.metadata.json';
    const localMetaPath = path.join(metaDir, metaFile);
    fs.writeFileSync(localMetaPath, JSON.stringify({
      'format-version': 2,
      'table-uuid': 'uuid-123',
      'location': 's3a://ruthk-aug20/datalake/events',
    }));

    const handle: ActiveConnectionHandle = {
      connectionType: 'local',
      warehousePath: tempWarehouse,
    };

    const adapter = new LocalFsAdapter(testLogger);
    try {
      const s3Uri = `s3a://ruthk-aug20/datalake/events/metadata/${metaFile}`;
      const json = await adapter.fetchMetadataJson(handle, s3Uri);

      assert.ok(json && typeof json === 'object', 'Expected parsed JSON object');
      assert.strictEqual((json as any)['table-uuid'], 'uuid-123');
    } finally {
      fs.rmSync(tempWarehouse, { recursive: true, force: true });
    }
  });

  await test('LocalFsAdapter: pathGuard still rejects genuine path traversal outside warehouse', async () => {
    const tempWarehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'iceberg-wh-'));
    const handle: ActiveConnectionHandle = {
      connectionType: 'local',
      warehousePath: tempWarehouse,
    };
    const adapter = new LocalFsAdapter(testLogger);
    try {
      const result = await adapter.fetchFileToTemp(handle, path.join(tempWarehouse, '../../etc/passwd'));
      assert.ok(result && typeof result === 'object' && 'class' in result);
      assert.strictEqual((result as any).class, 'access-denied');
    } finally {
      fs.rmSync(tempWarehouse, { recursive: true, force: true });
    }
  });

  await test('WebviewPanelManager: breadcrumb navigation for local connection resolves to local table path', async () => {
    const subscriptions: { dispose: () => void }[] = [];
    const context = {
      subscriptions,
      extensionUri: { fsPath: '/ext' } as any,
    } as vscode.ExtensionContext;

    const warehousePath = '/Users/ruthk/Downloads/datamart-files/ruthk-aug20';
    const handle: ActiveConnectionHandle = {
      connectionType: 'local',
      warehousePath,
    };

    let openedTablePath: string | undefined;
    const manager = new WebviewPanelManager(
      context,
      new LocalFsAdapter(testLogger),
      testLogger,
      undefined,
      undefined,
      () => [{
        id: 'conn-test',
        label: 'ruthk-aug20',
        connectionType: 'local',
        warehousePath,
        sslVerification: true,
        savedAt: Date.now(),
      }],
    );

    (manager as any).openTableOverviewPanel = async (tp: string) => {
      openedTablePath = tp;
    };

    // Breadcrumb segment 2 (table) on an S3 URI from copied metadata
    const s3ResourcePath = 's3a://ruthk-aug20/datalake/events/metadata/snap-2455113331347942445-1-d8afd4a8-aec6-458c-a29f-ab1dd28a2d65.avro';
    await (manager as any)._handleBreadcrumbNavigate(s3ResourcePath, 2, handle);

    assert.strictEqual(
      openedTablePath,
      path.join(warehousePath, 'datalake', 'events'),
      'Breadcrumb should navigate to local table path, not /ruthk-aug20/datalake/events',
    );
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

void runTests();
