/**
 * Unit & integration tests for Google Cloud Storage (GCS) support.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { GcsAdapter } from '../storage/gcsAdapter';
import { mapGcsError } from '../storage/errors';
import type { ActiveConnectionHandle, GcsConfig } from '../storage/types';
import { ConnectionManager, parseGcsUri, buildGcsConfig, parseServiceAccountKeyInput, parseJsonCredentials } from '../connection/connectionManager';
import { validateConnectionInput } from '../connection/validation';
import { resourcePathToBreadcrumbs } from '../panels/utils';
import type { ILogger } from '../extension';

// ---------------------------------------------------------------------------
// Test logger
// ---------------------------------------------------------------------------

const testLogLines: string[] = [];
const testLogger: ILogger = {
  info(msg)  { testLogLines.push(`[INFO]  ${msg}`); },
  warn(msg)  { testLogLines.push(`[WARN]  ${msg}`); },
  error(msg) { testLogLines.push(`[ERROR] ${msg}`); },
};

// ---------------------------------------------------------------------------
// In-memory SecretStorage & GlobalState mock for ConnectionManager
// ---------------------------------------------------------------------------

function makeFakeContext() {
  const store = new Map<string, string>();
  const state = new Map<string, any>();
  return {
    secrets: {
      async get(key: string) { return store.get(key); },
      async store(key: string, value: string) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      onDidChange: () => ({ dispose() {} }),
    },
    globalState: {
      get(key: string, defaultValue?: any) {
        return state.has(key) ? state.get(key) : defaultValue;
      },
      async update(key: string, value: any) { state.set(key, value); },
      keys: () => Array.from(state.keys()),
      setKeysForSync: () => {},
    },
    subscriptions: [],
  } as any;
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
  // 1. parseGcsUri
  await run('parseGcsUri parses gs:// and gcs:// URIs', () => {
    const res1 = parseGcsUri('gs://my-bucket/path/to/warehouse');
    assert.strictEqual(res1.bucket, 'my-bucket');
    assert.strictEqual(res1.keyPrefix, 'path/to/warehouse');

    const res2 = parseGcsUri('gcs://test-bucket/root/');
    assert.strictEqual(res2.bucket, 'test-bucket');
    assert.strictEqual(res2.keyPrefix, 'root');

    const res3 = parseGcsUri('gs://bucket-only');
    assert.strictEqual(res3.bucket, 'bucket-only');
    assert.strictEqual(res3.keyPrefix, '');

    assert.throws(() => parseGcsUri('s3://wrong-scheme/path'), /Invalid GCS URI/);
  });

  // 2. validateConnectionInput for GCS
  await run('validateConnectionInput accepts valid GCS connection with ADC', () => {
    const result = validateConnectionInput(
      {
        id: 'c1',
        label: 'GCS Warehouse',
        connectionType: 'gcs',
        warehousePath: 'gs://my-bucket/warehouse',
        sslVerification: true,
        savedAt: Date.now(),
        gcsAuthType: 'adc',
      },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(result.valid, true);
  });

  await run('validateConnectionInput requires service account key if serviceAccountKey auth chosen', () => {
    const resMissing = validateConnectionInput(
      {
        id: 'c2',
        label: 'GCS SA',
        connectionType: 'gcs',
        warehousePath: 'gs://my-bucket/warehouse',
        sslVerification: true,
        savedAt: Date.now(),
        gcsAuthType: 'serviceAccountKey',
      },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(resMissing.valid, false);
    if (!resMissing.valid) {
      assert.ok(resMissing.errors.some((e) => e.field === 'secretKey'));
    }

    const resValid = validateConnectionInput(
      {
        id: 'c2',
        label: 'GCS SA',
        connectionType: 'gcs',
        warehousePath: 'gs://my-bucket/warehouse',
        sslVerification: true,
        savedAt: Date.now(),
        gcsAuthType: 'serviceAccountKey',
      },
      { accessKey: '', secretKey: '{"type":"service_account"}' },
    );
    assert.strictEqual(resValid.valid, true);
  });

  await run('validateConnectionInput rejects invalid GCS URI', () => {
    const result = validateConnectionInput(
      {
        id: 'c3',
        label: 'GCS Bad URI',
        connectionType: 'gcs',
        warehousePath: 'https://storage.googleapis.com/bucket',
        sslVerification: true,
        savedAt: Date.now(),
        gcsAuthType: 'adc',
      },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === 'warehousePath'));
    }
  });

  // 3. ConnectionManager with GCS
  await run('ConnectionManager saves GCS ADC connection without writing secrets', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);

    const id = await cm.saveConnection(
      {
        label: 'GCS ADC',
        connectionType: 'gcs',
        warehousePath: 'gs://test-bucket/wh',
        sslVerification: true,
        gcsAuthType: 'adc',
      },
      { accessKey: '', secretKey: '' },
    );
    assert.ok(typeof id === 'string');

    const storedSecret = await ctx.secrets.get(`icebergExplorer.credentials.${id}`);
    assert.strictEqual(storedSecret, undefined);

    const hasCred = await cm.hasCredential(id);
    assert.strictEqual(hasCred, true);
  });

  await run('ConnectionManager saves GCS serviceAccountKey and preserves on mask', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);

    const id = await cm.saveConnection(
      {
        id: 'gcs-sa-1',
        label: 'GCS SA Key',
        connectionType: 'gcs',
        warehousePath: 'gs://test-bucket/wh',
        sslVerification: true,
        gcsAuthType: 'serviceAccountKey',
      },
      { accessKey: '', secretKey: '{"project_id":"demo"}' },
    );
    assert.strictEqual(id, 'gcs-sa-1');

    const storedRaw = await ctx.secrets.get('icebergExplorer.credentials.gcs-sa-1');
    assert.ok(storedRaw);
    const parsed = JSON.parse(storedRaw);
    assert.strictEqual(parsed.sk, '{"project_id":"demo"}');

    // Edit with masked secretKey
    await cm.saveConnection(
      {
        id: 'gcs-sa-1',
        label: 'GCS SA Key Renamed',
        connectionType: 'gcs',
        warehousePath: 'gs://test-bucket/wh',
        sslVerification: true,
        gcsAuthType: 'serviceAccountKey',
      },
      { accessKey: '', secretKey: '••••••••' },
    );

    const storedRaw2 = await ctx.secrets.get('icebergExplorer.credentials.gcs-sa-1');
    const parsed2 = JSON.parse(storedRaw2);
    assert.strictEqual(parsed2.sk, '{"project_id":"demo"}');
  });

  // 4. mapGcsError
  await run('mapGcsError maps Google API HTTP errors to standard StorageError', () => {
    const err403 = mapGcsError({ code: 403, message: 'Access denied' });
    assert.strictEqual(err403.class, 'access-denied');

    const err404 = mapGcsError({ code: 404, message: 'Not found' });
    assert.strictEqual(err404.class, 'not-found');

    const errSyntax = mapGcsError(new SyntaxError('Unexpected token'));
    assert.strictEqual(errSyntax.class, 'parse-failure');

    const errGeneric = mapGcsError(new Error('Network reset'));
    assert.strictEqual(errGeneric.class, 'internal');
  });

  // 5. GcsAdapter contract methods
  await run('GcsAdapter lists schemas, tables, and directory contents using mock client', async () => {
    const adapter = new GcsAdapter(testLogger);

    const mockBucket: any = {
      async getFiles(query: any) {
        if (query.prefix === 'warehouse/') {
          return [
            [],
            null,
            { prefixes: ['warehouse/db1/', 'warehouse/db2/'] },
          ];
        }
        if (query.prefix === 'warehouse/db1/') {
          return [
            [],
            null,
            { prefixes: ['warehouse/db1/tableA/', 'warehouse/db1/tableB/'] },
          ];
        }
        if (query.prefix === 'warehouse/db1/tableA/') {
          return [
            [{ name: 'warehouse/db1/tableA/data.parquet' }, { name: 'warehouse/db1/tableA/skip.COMPLETE.gz' }],
            null,
            { prefixes: ['warehouse/db1/tableA/metadata/', 'warehouse/db1/tableA/data/'] },
          ];
        }
        if (query.prefix === 'warehouse/db1/tableA/metadata/') {
          return [
            [
              { name: 'warehouse/db1/tableA/metadata/v1.metadata.json', metadata: { updated: '2026-01-01T00:00:00Z' } },
              { name: 'warehouse/db1/tableA/metadata/v2.metadata.json', metadata: { updated: '2026-01-02T00:00:00Z' } },
            ],
            null,
            {},
          ];
        }
        return [[], null, {}];
      },
      file(name: string) {
        return {
          async download() {
            return [Buffer.from(JSON.stringify({ formatVersion: 2, tableUuid: 'gcs-uuid' }))];
          },
          createReadStream() {
            return Readable.from([Buffer.from('PARQUET-MOCK-DATA')]);
          },
        };
      },
    };

    const handle: ActiveConnectionHandle = {
      connectionType: 'gcs',
      warehousePath: 'gs://iceberg-bucket/warehouse',
      gcsConfig: {
        client: { bucket: () => mockBucket } as any,
        bucket: 'iceberg-bucket',
        keyPrefix: 'warehouse',
      },
    };

    // listSchemas
    const schemas = await adapter.listSchemas(handle);
    assert.ok(Array.isArray(schemas));
    assert.deepStrictEqual(schemas, [
      'gs://iceberg-bucket/warehouse/db1',
      'gs://iceberg-bucket/warehouse/db2',
    ]);

    // listTables
    const tables = await adapter.listTables(handle, 'gs://iceberg-bucket/warehouse/db1');
    assert.ok(Array.isArray(tables));
    assert.deepStrictEqual(tables, [
      'gs://iceberg-bucket/warehouse/db1/tableA',
      'gs://iceberg-bucket/warehouse/db1/tableB',
    ]);

    // listMetadataVersions
    const versions = await adapter.listMetadataVersions(handle, 'gs://iceberg-bucket/warehouse/db1/tableA');
    assert.ok(Array.isArray(versions));
    assert.strictEqual(versions.length, 2);
    assert.strictEqual(versions[0].label, 'v2.metadata.json');
    assert.strictEqual(versions[1].label, 'v1.metadata.json');

    // fetchMetadataJson
    const metaJson: any = await adapter.fetchMetadataJson(handle, 'gs://iceberg-bucket/warehouse/db1/tableA/metadata/v2.metadata.json');
    assert.strictEqual(metaJson.formatVersion, 2);
    assert.strictEqual(metaJson.tableUuid, 'gcs-uuid');

    // fetchFileToTemp & deleteTemp
    const tempFile = await adapter.fetchFileToTemp(handle, 'gs://iceberg-bucket/warehouse/db1/tableA/data.parquet');
    assert.ok(typeof tempFile === 'string');
    const content = await fs.readFile(tempFile, 'utf-8');
    assert.strictEqual(content, 'PARQUET-MOCK-DATA');
    await adapter.deleteTemp(tempFile);
    await assert.rejects(async () => fs.access(tempFile));

    // listDirectoryContents
    const contents = await adapter.listDirectoryContents(handle, 'gs://iceberg-bucket/warehouse/db1/tableA');
    assert.ok(!('kind' in contents));
    assert.deepStrictEqual(contents.subdirectories, ['metadata', 'data']);
    assert.deepStrictEqual(contents.files, ['data.parquet']); // skip.COMPLETE.gz excluded!

    // isTable
    const isTab = await adapter.isTable(handle, 'gs://iceberg-bucket/warehouse/db1/tableA');
    assert.strictEqual(isTab, true);
  });

  // 6. resourcePathToBreadcrumbs with gs://
  await run('resourcePathToBreadcrumbs handles gs:// and gcs:// paths', () => {
    const segs1 = resourcePathToBreadcrumbs('gs://my-bucket/warehouse/db/my_table/metadata/v1.metadata.json');
    assert.deepStrictEqual(segs1, ['my-bucket/warehouse', 'db', 'my_table', 'v1.metadata.json']);

    const segs2 = resourcePathToBreadcrumbs('gcs://my-bucket/warehouse/db/my_table/data/part-000.parquet');
    assert.deepStrictEqual(segs2, ['my-bucket/warehouse', 'db', 'my_table', 'part-000.parquet']);
  });

  // 7. parseServiceAccountKeyInput & JSON repairs
  await run('parseServiceAccountKeyInput parses valid JSON string', () => {
    const json = JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'sa@test-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
    });
    const result = parseServiceAccountKeyInput(json);
    assert.ok(result.credentials);
    assert.strictEqual(result.credentials.project_id, 'test-project');
    assert.strictEqual(result.credentials.client_email, 'sa@test-project.iam.gserviceaccount.com');
  });

  await run('parseServiceAccountKeyInput repairs raw newlines in private_key and strips markdown fences', () => {
    const rawWithNewlines = `\`\`\`json
{
  "type": "service_account",
  "project_id": "test-project",
  "client_email": "sa@test-project.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC
-----END PRIVATE KEY-----"
}
\`\`\``;
    const result = parseServiceAccountKeyInput(rawWithNewlines);
    assert.ok(result.credentials);
    assert.strictEqual(result.credentials.project_id, 'test-project');
    assert.ok(result.credentials.private_key.includes('\n'));
  });

  await run('parseServiceAccountKeyInput repairs trailing commas and single quotes', () => {
    const relaxed = `{'type': 'service_account', 'project_id': 'test-project', 'client_email': 'sa@test.com',}`;
    const result = parseServiceAccountKeyInput(relaxed);
    assert.ok(result.credentials);
    assert.strictEqual(result.credentials.project_id, 'test-project');
  });

  await run('parseServiceAccountKeyInput reads key from local file path', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcs-test-'));
    const keyFile = path.join(tmpDir, 'service-account.json');
    await fs.writeFile(
      keyFile,
      JSON.stringify({
        type: 'service_account',
        project_id: 'file-project',
        client_email: 'sa@file.iam.gserviceaccount.com',
        private_key: 'KEY_CONTENT',
      }),
      'utf-8',
    );

    try {
      const result = parseServiceAccountKeyInput(keyFile);
      assert.strictEqual(result.keyFilename, keyFile);
      assert.ok(result.credentials);
      assert.strictEqual(result.credentials.project_id, 'file-project');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await run('parseServiceAccountKeyInput throws descriptive error for missing file or bad JSON', () => {
    assert.throws(
      () => parseServiceAccountKeyInput('/non/existent/path/to/key.json'),
      /Service Account key file not found: "\/non\/existent\/path\/to\/key\.json"/,
    );

    assert.throws(
      () => parseServiceAccountKeyInput('{ incomplete json'),
      /Invalid Service Account JSON/,
    );
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
})();
