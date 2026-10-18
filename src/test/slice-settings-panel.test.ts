/**
 * Slice integration smoke test — settings panel end-to-end.
 * (plan.md §4, FR-1, FR-2, FR-2b, FR-3, FR-4, FR-5, FR-6c, AC-1, AC-9)
 *
 * Run with:
 *   npm run test:slice-settings
 *
 * This test does NOT open a real VS Code window and does NOT invoke `vscode.*` APIs.
 * The `test-setup.ts` register intercepts `require('vscode')` and returns a stub.
 */
import * as assert from 'node:assert';

import type { ConnectionConfig } from '../connection/types';
import type { ActiveConnectionHandle } from '../storage/types';
import { storageError } from '../storage/errors';
import type { StorageError } from '../storage/errors';
import type { ILogger } from '../extension';
import { WebviewPanelManager } from '../panels/webviewPanelManager';
import { validateConnectionInput, validateWarehouseStructure, isAbsoluteLocalPath } from '../connection/validation';
import { ConnectionManager } from '../connection/connectionManager';
import {
  browseDirectory,
  findCandidateWarehouseRoots,
  getParentPath,
  joinStoragePath,
  normaliseStoragePath,
} from '../connection/discovery';

// ---------------------------------------------------------------------------
// The vscode mock (via test-setup.ts → __mocks__/vscode.ts) exposes
// window.createWebviewPanel which returns a fake panel. The fake panel's
// webview has a `_getMessages()` helper. We also need to capture the
// onDidReceiveMessage handler so we can fire messages from the test.
//
// We monkey-patch the mock once here and restore afterwards, scoped per test.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeMock = require('vscode') as any;

/** Build a fake panel and temporarily replace vscode.window.createWebviewPanel.
 *  Always returns a Promise so the finally runs after async work completes.
 */
async function withFakePanel(fn: (api: {
  getHtml: () => string;
  getMessages: () => Array<{ type: string; [k: string]: unknown }>;
  fireMessage: (msg: unknown) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const messages: Array<{ type: string; [k: string]: unknown }> = [];
  let msgHandler: ((msg: unknown) => void | Promise<void>) | null = null;

  const fakePanel: any = {
    title: '',
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: any) => uri,
      postMessage(msg: { type: string; [k: string]: unknown }) { messages.push(msg); },
      onDidReceiveMessage(handler: (msg: unknown) => void) {
        msgHandler = handler;
        return { dispose() {} };
      },
    },
    reveal(_col: unknown) {},
    onDidDispose(_handler: () => void, _ctx: unknown, _subs: unknown) { return { dispose() {} }; },
    dispose() {},
  };

  const original = vscodeMock.window.createWebviewPanel;
  vscodeMock.window.createWebviewPanel = () => fakePanel;
  try {
    await fn({
      getHtml:     () => fakePanel.webview.html as string,
      getMessages: () => messages,
      fireMessage: async (msg: unknown) => {
        if (msgHandler) { await msgHandler(msg); }
      },
    });
  } finally {
    vscodeMock.window.createWebviewPanel = original;
  }
}

// ---------------------------------------------------------------------------
// Fake Extension Context
// ---------------------------------------------------------------------------

const fakeContext: any = {
  extensionUri: { fsPath: '.' },
  subscriptions: [],
};

// ---------------------------------------------------------------------------
// Fake StorageAdapter (no-op — settings panel does not use it)
// ---------------------------------------------------------------------------

const fakeStorageAdapter: any = {
  async listSchemas() { return []; },
  async listTables() { return []; },
  async listMetadataVersions() { return []; },
  async fetchMetadataJson() { return {}; },
  async fetchFileToTemp() { return ''; },
  async deleteTemp() { return; },
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
// Stub callbacks
// ---------------------------------------------------------------------------

const noopSaveConnection = async (
  _config: ConnectionConfig,
  _creds: { accessKey: string; secretKey: string },
): Promise<void> => { /* success */ };

const noopActivateConnection = async (
  _id: string,
): Promise<ActiveConnectionHandle> => ({ connectionType: 'local', warehousePath: '/tmp' });

const noopDeleteConnection = async (_id: string): Promise<void> => { /* no-op */ };

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

  // 1. openSettingsPanel opens a panel — HTML contains title string
  await run('openSettingsPanel opens a panel with correct title in HTML', async () => {
    clearLog();
    await withFakePanel(async ({ getHtml }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);
      const html = getHtml();
      assert.ok(
        html.includes('Iceberg Explorer \u2014 Settings'),
        `HTML did not contain expected title. First 300 chars: ${html.slice(0, 300)}`,
      );
    });
  });

  // 2. One-panel-per-resource guard — calling twice leaves registry size == 1
  await run('One-panel-per-resource guard: calling openSettingsPanel twice keeps registry size 1', async () => {
    const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
    const original = vscodeMock.window.createWebviewPanel;
    let createCount = 0;
    vscodeMock.window.createWebviewPanel = () => {
      createCount++;
      return {
        title: '',
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (uri: any) => uri,
          postMessage() {},
          onDidReceiveMessage() { return { dispose() {} }; },
        },
        reveal() {},
        onDidDispose() { return { dispose() {} }; },
        dispose() {},
      };
    };
    try {
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);
      const sizeAfterFirst = (mgr as any).registry.size;

      // Second call — panel already in registry, should reveal and return
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);
      const sizeAfterSecond = (mgr as any).registry.size;

      assert.strictEqual(sizeAfterFirst,  1, `expected size 1 after first call, got ${sizeAfterFirst}`);
      assert.strictEqual(sizeAfterSecond, 1, `expected size 1 after second call, got ${sizeAfterSecond}`);
      assert.strictEqual(createCount, 1, `createWebviewPanel should be called only once, was called ${createCount} times`);
    } finally {
      vscodeMock.window.createWebviewPanel = original;
    }
  });

  // 3. saveConnection message → saveSuccess response
  await run('saveConnection message → saveSuccess is posted back', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);

      await fireMessage({
        type: 'saveConnection',
        connectionType: 'local',
        label: 'My Warehouse',
        warehousePath: '/data/warehouse',
        sslVerification: true,
      });

      const msgs = getMessages();
      const success = msgs.find((m) => m.type === 'saveSuccess');
      assert.ok(success, `expected saveSuccess in messages: ${JSON.stringify(msgs)}`);
    });
  });

  // 4. saveConnection message → saveError when callback rejects
  await run('saveConnection message → saveError when saveConnection callback rejects', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const failingSave = async () => { throw new Error('disk full'); };
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, failingSave, noopActivateConnection, noopDeleteConnection);

      await fireMessage({
        type: 'saveConnection',
        connectionType: 'local',
        label: 'Bad',
        warehousePath: '/tmp',
        sslVerification: true,
      });

      const msgs = getMessages();
      const errorMsg = msgs.find((m) => m.type === 'saveError');
      assert.ok(errorMsg, `expected saveError in messages: ${JSON.stringify(msgs)}`);
      assert.ok(
        typeof errorMsg!.message === 'string' && (errorMsg!.message as string).length > 0,
        'saveError must carry a non-empty message',
      );
    });
  });

  // 5. activateConnection message → activateSuccess
  await run('activateConnection message → activateSuccess is posted back', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);

      await fireMessage({ type: 'activateConnection', id: 'conn-abc' });

      const msgs = getMessages();
      const success = msgs.find((m) => m.type === 'activateSuccess');
      assert.ok(success, `expected activateSuccess in messages: ${JSON.stringify(msgs)}`);
    });
  });

  // 6. activateConnection message → activateError when callback returns StorageError
  await run('activateConnection message → activateError when callback returns StorageError', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const failingActivate = async (_id: string): Promise<ActiveConnectionHandle | StorageError> =>
        storageError('not-found', 'Connection not found.');
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, failingActivate, noopDeleteConnection);

      await fireMessage({ type: 'activateConnection', id: 'missing-conn' });

      const msgs = getMessages();
      const errorMsg = msgs.find((m) => m.type === 'activateError');
      assert.ok(errorMsg, `expected activateError in messages: ${JSON.stringify(msgs)}`);
      assert.strictEqual(
        errorMsg!.message, 'Connection not found.',
        `activateError message mismatch: ${String(errorMsg!.message)}`,
      );
    });
  });

  // 7. HTML does NOT contain the old saved-connections section
  await run('HTML does NOT contain id="saved-section" (saved connections removed from panel)', async () => {
    await withFakePanel(async ({ getHtml }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);
      const html = getHtml();
      assert.ok(
        !html.includes('id="saved-section"'),
        'HTML must NOT contain id="saved-section" (section was removed)',
      );
    });
  });

  // 8. No credential strings in logs (NFR-7, design.md §2.8.3)
  await run('No credential strings (accessKey / secretKey) appear in log output', async () => {
    clearLog();
    await withFakePanel(async ({ fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, noopSaveConnection, noopActivateConnection, noopDeleteConnection);

      // Simulate a save with S3 credentials
      await fireMessage({
        type: 'saveConnection',
        connectionType: 's3',
        label: 'S3 Test',
        warehousePath: 's3://my-bucket/prefix',
        endpointUrl: 'https://s3.example.com',
        region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sslVerification: true,
      });
    });

    const CRED_PATTERN = /(?:AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI|accessKey\s*[:=]|secretKey\s*[:=])/i;
    const credLines = testLogLines.filter(l => CRED_PATTERN.test(l));
    assert.strictEqual(
      credLines.length, 0,
      `Credential content found in logs:\n${credLines.join('\n')}`,
    );
  });

  // 9. saveConnection trims whitespace from credentials and accepts optional endpointUrl
  await run('saveConnection message trims credentials and accepts optional endpointUrl', async () => {
    let capturedConfig: ConnectionConfig | null = null;
    let capturedCreds: { accessKey: string; secretKey: string } | null = null;
    const saveSpy = async (cfg: ConnectionConfig, creds: { accessKey: string; secretKey: string }) => {
      capturedConfig = cfg;
      capturedCreds = creds;
    };

    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, saveSpy, noopActivateConnection, noopDeleteConnection);

      await fireMessage({
        type: 'saveConnection',
        connectionType: 's3',
        label: '  AWS Production  ',
        warehousePath: '  s3://my-bucket/prefix  ',
        endpointUrl: '',
        region: '  us-east-1  ',
        accessKey: '  AKIAIOSFODNN7EXAMPLE  ',
        secretKey: '  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n  ',
        sslVerification: true,
      });

      const msgs = getMessages();
      const success = msgs.find((m) => m.type === 'saveSuccess');
      assert.ok(success, `expected saveSuccess in messages: ${JSON.stringify(msgs)}`);
      assert.strictEqual(capturedConfig?.label, 'AWS Production');
      assert.strictEqual(capturedConfig?.warehousePath, 's3://my-bucket/prefix');
      assert.strictEqual(capturedConfig?.region, 'us-east-1');
      assert.strictEqual(capturedConfig?.endpointUrl, undefined);
      assert.strictEqual(capturedCreds?.accessKey, 'AKIAIOSFODNN7EXAMPLE');
      assert.strictEqual(capturedCreds?.secretKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    });
  });

  // 10. validateConnectionInput allows empty/omitted endpointUrl for S3
  await run('validateConnectionInput permits S3 connections without endpointUrl', async () => {
    const valid = validateConnectionInput(
      {
        id: 'test-conn',
        label: 'AWS',
        connectionType: 's3',
        warehousePath: 's3://my-bucket',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: Date.now(),
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    );
    assert.strictEqual(valid.valid, true, `expected valid: true, got ${JSON.stringify(valid)}`);
  });

  await run('validateConnectionInput rejects S3 connection with empty warehousePath', async () => {
    const res = validateConnectionInput(
      {
        id: 'test-conn',
        label: 'AWS Empty Path',
        connectionType: 's3',
        warehousePath: '   ',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: Date.now(),
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    );
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.ok(res.errors.some((e) => e.field === 'warehousePath'));
    }
  });

  await run('validateConnectionInput rejects S3 connection with invalid S3 URI', async () => {
    const res = validateConnectionInput(
      {
        id: 'test-conn',
        label: 'AWS Invalid URI',
        connectionType: 's3',
        warehousePath: '/not/an/s3/path',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: Date.now(),
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    );
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.ok(res.errors.some((e) => e.field === 'warehousePath'));
    }
  });

  await run('validateConnectionInput accepts S3 connection with warehouse path prefix', async () => {
    const res = validateConnectionInput(
      {
        id: 'test-conn',
        label: 'AWS Warehouse Prefix',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/warehouse-path/subpath',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: Date.now(),
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    );
    assert.strictEqual(res.valid, true);
  });

  // Helper for ConnectionManager testing
  function makeFakeContext(initialConfigs: ConnectionConfig[] = []) {
    const store = new Map<string, any>();
    store.set('icebergExplorer.connections', initialConfigs);
    const secrets = new Map<string, string>();
    return {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, val: any) => { store.set(key, val); },
      },
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, val: string) => { secrets.set(key, val); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    } as any;
  }

  // 11. validateConnectionInput rejects empty or whitespace-only connection name
  await run('validateConnectionInput rejects empty or whitespace-only connection name', async () => {
    const res = validateConnectionInput(
      {
        id: 'c1',
        label: '   ',
        connectionType: 'local',
        warehousePath: '/tmp/iceberg',
        sslVerification: true,
        savedAt: Date.now(),
      },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.ok(res.errors.some((e) => e.field === 'label' && e.message === 'Connection name is required.'));
    }
  });

  // 12. validateConnectionInput rejects duplicate connection name (case-insensitive, trimmed)
  await run('validateConnectionInput rejects duplicate connection name (case-insensitive, trimmed)', async () => {
    const existing: ConnectionConfig[] = [
      {
        id: 'conn-1',
        label: 'AWS',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 1000,
      },
    ];
    const res = validateConnectionInput(
      {
        id: 'conn-2',
        label: '  aws  ',
        connectionType: 's3',
        warehousePath: 's3://other-bucket',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 2000,
      },
      { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      existing,
    );
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.ok(res.errors.some((e) => e.field === 'label' && e.message.includes('already exists')));
    }
  });

  // 13. validateConnectionInput allows editing existing connection without name collision error
  await run('validateConnectionInput allows editing existing connection without name collision error', async () => {
    const existing: ConnectionConfig[] = [
      {
        id: 'conn-1',
        label: 'AWS',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 1000,
      },
    ];
    const res = validateConnectionInput(
      {
        id: 'conn-1',
        label: 'AWS',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg-updated',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 2000,
      },
      { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      existing,
    );
    assert.strictEqual(res.valid, true);
  });

  // 14. ConnectionManager.saveConnection prevents saving connection with duplicate name
  await run('ConnectionManager.saveConnection prevents saving connection with duplicate name', async () => {
    const ctx = makeFakeContext([
      {
        id: 'c1',
        label: 'aws',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 1000,
      },
    ]);
    const cm = new ConnectionManager(ctx, testLogger);
    const result = await cm.saveConnection(
      {
        label: 'AWS',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg-2',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    );
    assert.ok(result instanceof Error, 'Expected saveConnection to return an Error for duplicate name');
    assert.ok(result.message.includes('already exists'));
  });

  // 15. ConnectionManager sanitizes pre-existing duplicate connections from storage
  await run('ConnectionManager sanitizes pre-existing duplicate connections from storage', async () => {
    const ctx = makeFakeContext([
      {
        id: 'c1',
        label: 'aws',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 1000,
      },
      {
        id: 'c2',
        label: 'aws',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
        savedAt: 2000,
      },
    ]);
    const cm = new ConnectionManager(ctx, testLogger);
    const configs = cm.listConnections();
    assert.strictEqual(configs.length, 1, 'Exact duplicate connections should be pruned to 1');
    assert.strictEqual(configs[0].id, 'c2', 'Newer connection should be preserved');
  });

  // 16. saveConnection in settings panel receives saveError when backend returns duplicate name error
  await run('saveConnection in settings panel posts saveError when duplicate name is rejected', async () => {
    const failingSave = async () => {
      throw new Error('Validation failed: label: A connection with the name "aws" already exists.');
    };
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, failingSave, noopActivateConnection, noopDeleteConnection);

      await fireMessage({
        type: 'saveConnection',
        connectionType: 's3',
        label: 'aws',
        warehousePath: 's3://my-bucket/prefix',
        region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sslVerification: true,
      });

      const msgs = getMessages();
      const errorMsg = msgs.find((m) => m.type === 'saveError');
      assert.ok(errorMsg, `expected saveError in messages: ${JSON.stringify(msgs)}`);
      assert.ok(String(errorMsg!.message).includes('already exists'));
    });
  });

  // 17. ConnectionManager.saveConnection preserves existing credentials and skips redundant write when editing with masked credentials
  await run('ConnectionManager.saveConnection preserves existing credentials when editing with masked credentials', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);
    const saveId = await cm.saveConnection(
      {
        id: 'conn-1',
        label: 'AWS Initial',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/prefix',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: 'ORIGINAL_AK', secretKey: 'ORIGINAL_SK' },
    );
    assert.strictEqual(saveId, 'conn-1');

    // Spy on secrets.store to ensure redundant writes are skipped
    let storeCallCount = 0;
    const origStore = ctx.secrets.store;
    ctx.secrets.store = async (k: string, v: string) => {
      storeCallCount++;
      return origStore(k, v);
    };

    // Edit connection and provide masked credentials
    const editResult = await cm.saveConnection(
      {
        id: 'conn-1',
        label: 'AWS Updated Label',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/prefix-2',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: '••••••••', secretKey: '••••••••' },
    );
    assert.strictEqual(editResult, 'conn-1');
    assert.strictEqual(storeCallCount, 0, 'Expected secrets.store to be skipped when credentials did not change');

    // Verify stored credentials in SecretStorage
    const storedRaw = await ctx.secrets.get('icebergExplorer.credentials.conn-1');
    assert.ok(storedRaw, 'Expected credentials to exist in SecretStorage');
    const stored = JSON.parse(storedRaw);
    assert.strictEqual(stored.ak, 'ORIGINAL_AK');
    assert.strictEqual(stored.sk, 'ORIGINAL_SK');

    // Also check hasCredential returns true
    const hasCred = await cm.hasCredential('conn-1');
    assert.strictEqual(hasCred, true);
  });

  // 18. ConnectionManager.saveConnection updates only the modified credential when the other is masked
  await run('ConnectionManager.saveConnection updates only the modified credential when the other is masked', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);
    await cm.saveConnection(
      {
        id: 'conn-1',
        label: 'AWS Initial',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/prefix',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: 'ORIGINAL_AK', secretKey: 'ORIGINAL_SK' },
    );

    // Provide masked accessKey, new secretKey
    const editResult = await cm.saveConnection(
      {
        id: 'conn-1',
        label: 'AWS Initial',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/prefix',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: '••••••••', secretKey: 'NEW_SECRET_KEY' },
    );
    assert.strictEqual(editResult, 'conn-1');

    const storedRaw = await ctx.secrets.get('icebergExplorer.credentials.conn-1');
    const stored = JSON.parse(storedRaw);
    assert.strictEqual(stored.ak, 'ORIGINAL_AK');
    assert.strictEqual(stored.sk, 'NEW_SECRET_KEY');
  });

  // 19. ConnectionManager.saveConnection rejects masked credentials when saving a new connection without existing credentials
  await run('ConnectionManager.saveConnection rejects masked credentials when saving a new connection without existing credentials', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);
    const result = await cm.saveConnection(
      {
        label: 'AWS New',
        connectionType: 's3',
        warehousePath: 's3://my-bucket/prefix',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: '••••••••', secretKey: '••••••••' },
    );
    assert.ok(result instanceof Error, 'Expected saveConnection to fail for new connection with masked credentials');
    assert.ok(result.message.includes('Access key is required'));
  });

  // 20. WebviewPanelManager.openSettingsPanel sends editConnection with hasSavedCredentials and sslVerification
  await run('WebviewPanelManager.openSettingsPanel sends editConnection with hasSavedCredentials and sslVerification', async () => {
    await withFakePanel(async ({ getMessages }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      const editConfig: ConnectionConfig = {
        id: 'conn-s3-1',
        label: 'My S3',
        connectionType: 's3',
        warehousePath: 's3://bucket/path',
        endpointUrl: 'https://minio.local:9000',
        region: 'us-east-1',
        sslVerification: false,
        savedAt: 12345,
      };

      await mgr.openSettingsPanel(
        editConfig,
        noopSaveConnection,
        noopActivateConnection,
        noopDeleteConnection,
        undefined,
        async (id) => id === 'conn-s3-1',
      );

      const msgs = getMessages();
      const editMsg = msgs.find((m) => m.type === 'editConnection');
      assert.ok(editMsg, `expected editConnection in messages: ${JSON.stringify(msgs)}`);
      assert.strictEqual(editMsg!.hasSavedCredentials, true);
      assert.strictEqual((editMsg!.config as any).sslVerification, false);
      assert.strictEqual((editMsg!.config as any).label, 'My S3');
    });
  });

  await run('Settings panel client script contains valid JavaScript syntax without parse errors', async () => {
    const { getSettingsHtml } = await import('../panels/html/settings.js');
    const html = getSettingsHtml('test-nonce', 'vscode-resource:', [{ id: 'c1', label: 'Existing' }]);
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length > 0, 'Settings HTML should contain at least one <script> tag');
    for (const match of scriptMatches) {
      assert.doesNotThrow(() => {
        new Function('acquireVsCodeApi', match[1]);
      }, 'Settings webview script must not have syntax errors');
    }
  });

  await run('Settings panel client script executes without runtime errors during initialization', async () => {
    const { getSettingsHtml } = await import('../panels/html/settings.js');
    const html = getSettingsHtml('test-nonce', 'vscode-resource:', [{ id: 'c1', label: 'Existing' }]);
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];

    const mockElement = (id = '') => ({
      id,
      value: '',
      textContent: '',
      style: {},
      classList: { add() {}, remove() {} },
      addEventListener() {},
      querySelectorAll() { return []; },
      scrollIntoView() {},
      dataset: {},
      disabled: false,
    });

    const elements: Record<string, any> = {};
    const mockDocument = {
      getElementById(id: string) {
        if (!elements[id]) {
          elements[id] = mockElement(id);
        }
        return elements[id];
      },
      querySelectorAll() { return []; },
    };
    const mockWindow = {
      addEventListener() {},
    };

    for (const match of scriptMatches) {
      assert.doesNotThrow(() => {
        const fn = new Function('acquireVsCodeApi', 'document', 'window', match[1]);
        fn(() => ({ postMessage() {} }), mockDocument, mockWindow);
      }, 'Settings webview script must not throw runtime errors on initialization');
    }
  });

  // ── Warehouse structure validation ──────────────────────────────────────────
  function makeMockAdapterForDogs() {
    return {
      async listSchemas(h: ActiveConnectionHandle) {
        if (h.warehousePath === 's3://rk-iceberg') {
          return ['s3://rk-iceberg/dogs'];
        }
        if (h.warehousePath === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        if (h.warehousePath === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        return [];
      },
      async listTables(_h: ActiveConnectionHandle, p: string) {
        if (p === 's3://rk-iceberg/dogs') {
          return ['s3://rk-iceberg/dogs/testdogs.db'];
        }
        if (p === 's3://rk-iceberg/dogs/testdogs.db') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1'];
        }
        if (p === 's3://rk-iceberg/dogs/testdogs.db/dogtable1') {
          return ['s3://rk-iceberg/dogs/testdogs.db/dogtable1/data', 's3://rk-iceberg/dogs/testdogs.db/dogtable1/metadata'];
        }
        return [];
      },
      async isTable(_h: ActiveConnectionHandle, p: string) {
        return p === 's3://rk-iceberg/dogs/testdogs.db/dogtable1';
      },
      async listDirectoryContents(_h: ActiveConnectionHandle, dirPath: string) {
        const norm = dirPath.replace(/\/+$/, '');
        if (norm === 's3://rk-iceberg') {
          return { subdirectories: ['dogs'], files: [] };
        }
        if (norm === 's3://rk-iceberg/dogs') {
          return { subdirectories: ['testdogs.db'], files: [] };
        }
        if (norm === 's3://rk-iceberg/dogs/testdogs.db') {
          return { subdirectories: ['dogtable1'], files: [] };
        }
        if (norm === 's3://rk-iceberg/dogs/testdogs.db/dogtable1') {
          return { subdirectories: ['metadata', 'data'], files: [] };
        }
        return { subdirectories: [], files: [] };
      },
    } as any;
  }

  await run('validateWarehouseStructure rejects warehouse path s3://rk-iceberg when table is not directly under schema', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: '', client: {} as any },
    };
    const res = await validateWarehouseStructure(handle, adapter);
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.strictEqual(res.errors[0].field, 'warehousePath');
      assert.ok(res.errors[0].message.includes('No Iceberg tables found'));
    }
  });

  await run('validateWarehouseStructure rejects warehouse path s3://rk-iceberg/dogs/testdogs.db when schema does not contain table', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg/dogs/testdogs.db',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: 'dogs/testdogs.db', client: {} as any },
    };
    const res = await validateWarehouseStructure(handle, adapter);
    assert.strictEqual(res.valid, false);
    if (!res.valid) {
      assert.strictEqual(res.errors[0].field, 'warehousePath');
    }
  });

  await run('validateWarehouseStructure accepts warehouse path s3://rk-iceberg/dogs when table is under testdogs.db schema', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg/dogs',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: 'dogs', client: {} as any },
    };
    const res = await validateWarehouseStructure(handle, adapter);
    assert.strictEqual(res.valid, true);
  });

  await run('ConnectionManager.saveConnection with adapter rejects s3://rk-iceberg and accepts s3://rk-iceberg/dogs', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);
    const adapter = makeMockAdapterForDogs();

    // 1. Rejects s3://rk-iceberg
    const rejectRes = await cm.saveConnection(
      {
        label: 'AWS rk-iceberg root',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      adapter,
    );
    assert.ok(rejectRes instanceof Error, 'Expected saveConnection to fail for s3://rk-iceberg');
    assert.ok(rejectRes.message.includes('warehousePath'));

    // 2. Accepts s3://rk-iceberg/dogs
    const acceptRes = await cm.saveConnection(
      {
        label: 'AWS rk-iceberg dogs',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg/dogs',
        region: 'us-east-1',
        sslVerification: true,
      },
      {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      adapter,
    );
    assert.strictEqual(typeof acceptRes, 'string', 'Expected saveConnection to succeed for s3://rk-iceberg/dogs');
  });

  await run('saveConnection message with GCS connectionType and ADC succeeds and posts saveSuccess', async () => {
    let savedConfig: any = null;
    await withFakePanel(async ({ fireMessage, getMessages }) => {
      const mgr = new WebviewPanelManager(
        fakeContext,
        fakeStorageAdapter,
        testLogger,
        undefined as any,
        undefined,
        undefined,
      );

      await mgr.openSettingsPanel(
        undefined,
        async (config) => { savedConfig = config; },
        noopActivateConnection,
        noopDeleteConnection,
      );

      await fireMessage({
        type: 'saveConnection',
        label: 'My GCS Warehouse',
        connectionType: 'gcs',
        warehousePath: 'gs://my-bucket/iceberg',
        gcsAuthType: 'adc',
        projectId: 'gcp-proj',
      });

      const msgs = getMessages();
      const saveSuccess = msgs.find((m) => m.type === 'saveSuccess');
      assert.ok(saveSuccess, 'saveSuccess message was posted');
      assert.strictEqual(savedConfig.connectionType, 'gcs');
      assert.strictEqual(savedConfig.warehousePath, 'gs://my-bucket/iceberg');
      assert.strictEqual(savedConfig.gcsAuthType, 'adc');
      assert.strictEqual(savedConfig.projectId, 'gcp-proj');
    });
  });

  await run('WebviewPanelManager.openSettingsPanel sends editConnection with GCS configuration and hasSavedCredentials=true for ADC', async () => {
    await withFakePanel(async ({ getMessages }) => {
      const mgr = new WebviewPanelManager(
        fakeContext,
        fakeStorageAdapter,
        testLogger,
        undefined as any,
        undefined,
        undefined,
      );

      const editConfig: ConnectionConfig = {
        id: 'conn-gcs-1',
        label: 'My GCS',
        connectionType: 'gcs',
        warehousePath: 'gs://gcs-bucket/wh',
        sslVerification: true,
        gcsAuthType: 'adc',
        projectId: 'demo-p',
        savedAt: 12345,
      };

      await mgr.openSettingsPanel(
        editConfig,
        noopSaveConnection,
        noopActivateConnection,
        noopDeleteConnection,
        undefined,
        async (id) => id === 'conn-gcs-1',
      );

      const msgs = getMessages();
      const editMsg = msgs.find((m) => m.type === 'editConnection');
      assert.ok(editMsg, `expected editConnection in messages: ${JSON.stringify(msgs)}`);
      assert.strictEqual(editMsg!.hasSavedCredentials, false); // ADC does not require stored credentials
      assert.strictEqual((editMsg!.config as any).connectionType, 'gcs');
      assert.strictEqual((editMsg!.config as any).gcsAuthType, 'adc');
      assert.strictEqual((editMsg!.config as any).projectId, 'demo-p');
    });
  });

  await run('WebviewPanelManager.openSettingsPanel sends editConnection with hasSavedCredentials=true for GCS serviceAccountKey', async () => {
    await withFakePanel(async ({ getMessages }) => {
      const mgr = new WebviewPanelManager(
        fakeContext,
        fakeStorageAdapter,
        testLogger,
        undefined as any,
        undefined,
        undefined,
      );

      const editConfig: ConnectionConfig = {
        id: 'conn-gcs-sa',
        label: 'My GCS SA',
        connectionType: 'gcs',
        warehousePath: 'gs://gcs-bucket/wh',
        sslVerification: true,
        gcsAuthType: 'serviceAccountKey',
        savedAt: 12345,
      };

      await mgr.openSettingsPanel(
        editConfig,
        noopSaveConnection,
        noopActivateConnection,
        noopDeleteConnection,
        undefined,
        async (id) => id === 'conn-gcs-sa',
      );

      const msgs = getMessages();
      const editMsg = msgs.find((m) => m.type === 'editConnection');
      assert.ok(editMsg, `expected editConnection in messages: ${JSON.stringify(msgs)}`);
      assert.strictEqual(editMsg!.hasSavedCredentials, true);
    });
  });

  await run('Settings HTML includes "Save Connection" button and banner connect button', async () => {
    const { getSettingsHtml } = await import('../panels/html/settings.js');
    const html = getSettingsHtml('test-nonce', 'vscode-resource:', [{ id: 'c1', label: 'Existing' }]);
    assert.ok(html.includes('id="save-btn"'), 'HTML must contain save-btn');
    assert.ok(html.includes('Save Connection'), 'HTML must have "Save Connection" text');
    assert.ok(html.includes('id="banner-connect-btn"'), 'HTML must contain banner-connect-btn');
    assert.ok(html.includes('id="status-banner-text"'), 'HTML must contain status-banner-text');
  });

  await run('saveSuccess message includes connectionId for newly saved connection', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(undefined, async () => 'conn-saved-123', noopActivateConnection, noopDeleteConnection);

      await fireMessage({
        type: 'saveConnection',
        connectionType: 'local',
        label: 'New Conn',
        warehousePath: '/data/warehouse',
        sslVerification: true,
      });

      const msgs = getMessages();
      const saveSuccess = msgs.find((m) => m.type === 'saveSuccess');
      assert.ok(saveSuccess, 'saveSuccess message was posted');
      assert.strictEqual(saveSuccess!.connectionId, 'conn-saved-123');
    });
  });

  await run('isAbsoluteLocalPath classifies POSIX, Windows drive, UNC, and relative paths correctly', async () => {
    assert.strictEqual(isAbsoluteLocalPath('/var/data/iceberg'), true);
    assert.strictEqual(isAbsoluteLocalPath('c:\\downloads\\iceberg'), true);
    assert.strictEqual(isAbsoluteLocalPath('C:\\downloads\\iceberg'), true);
    assert.strictEqual(isAbsoluteLocalPath('D:/downloads/iceberg'), true);
    assert.strictEqual(isAbsoluteLocalPath('\\\\server\\share\\iceberg'), true);
    assert.strictEqual(isAbsoluteLocalPath('downloads/iceberg'), false);
    assert.strictEqual(isAbsoluteLocalPath('./downloads/iceberg'), false);
    assert.strictEqual(isAbsoluteLocalPath('../downloads/iceberg'), false);
    assert.strictEqual(isAbsoluteLocalPath(''), false);
  });

  await run('validateConnectionInput accepts Windows absolute paths for local connection', async () => {
    const resBackslash = validateConnectionInput(
      { id: 'win-1', label: 'Win Backslash', connectionType: 'local', warehousePath: 'c:\\downloads\\iceberg', sslVerification: true, savedAt: Date.now() },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(resBackslash.valid, true);

    const resSlash = validateConnectionInput(
      { id: 'win-2', label: 'Win Slash', connectionType: 'local', warehousePath: 'C:/downloads/iceberg', sslVerification: true, savedAt: Date.now() },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(resSlash.valid, true);

    const resRelative = validateConnectionInput(
      { id: 'rel-1', label: 'Relative Path', connectionType: 'local', warehousePath: 'downloads\\iceberg', sslVerification: true, savedAt: Date.now() },
      { accessKey: '', secretKey: '' },
    );
    assert.strictEqual(resRelative.valid, false);
    if (!resRelative.valid) {
      assert.strictEqual(resRelative.errors[0].field, 'warehousePath');
      assert.ok(resRelative.errors[0].message.includes('absolute path'));
    }
  });

  // ── S3 / GCS / Local Browser & Auto-Detection Tests ─────────────────────────

  await run('discovery path helpers: getParentPath, normaliseStoragePath, joinStoragePath', async () => {
    assert.strictEqual(normaliseStoragePath('s3://my-bucket/dogs/'), 's3://my-bucket/dogs');
    assert.strictEqual(normaliseStoragePath('gs://my-bucket/'), 'gs://my-bucket');
    assert.strictEqual(normaliseStoragePath('gcs://my-bucket/path'), 'gs://my-bucket/path');

    assert.strictEqual(joinStoragePath('s3://my-bucket', 'dogs'), 's3://my-bucket/dogs');
    assert.strictEqual(joinStoragePath('s3://my-bucket/dogs', 'testdogs.db'), 's3://my-bucket/dogs/testdogs.db');

    assert.strictEqual(getParentPath('s3://my-bucket'), null);
    assert.strictEqual(getParentPath('s3://my-bucket/'), null);
    assert.strictEqual(getParentPath('s3://my-bucket/dogs'), 's3://my-bucket');
    assert.strictEqual(getParentPath('s3://my-bucket/dogs/testdogs.db'), 's3://my-bucket/dogs');
    assert.strictEqual(getParentPath('gs://my-bucket/dogs/testdogs.db'), 'gs://my-bucket/dogs');
  });

  await run('browseDirectory detects schema and table badges accurately in S3', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: '', client: {} as any },
    };

    // Browse bucket root
    const rootRes = await browseDirectory(handle, adapter, 's3://rk-iceberg');
    assert.ok(!('error' in rootRes));
    if (!('error' in rootRes)) {
      assert.strictEqual(rootRes.currentPath, 's3://rk-iceberg');
      assert.strictEqual(rootRes.parentPath, null);
      assert.strictEqual(rootRes.items.length, 1);
      assert.strictEqual(rootRes.items[0].name, 'dogs');
      assert.strictEqual(rootRes.items[0].isTable, false);
      assert.strictEqual(rootRes.items[0].isSchema, false);
    }

    // Browse dogs/
    const dogsRes = await browseDirectory(handle, adapter, 's3://rk-iceberg/dogs');
    assert.ok(!('error' in dogsRes));
    if (!('error' in dogsRes)) {
      assert.strictEqual(dogsRes.parentPath, 's3://rk-iceberg');
      assert.strictEqual(dogsRes.items.length, 1);
      assert.strictEqual(dogsRes.items[0].name, 'testdogs.db');
      assert.strictEqual(dogsRes.items[0].isSchema, true); // contains dogtable1
      assert.strictEqual(dogsRes.items[0].isTable, false);
    }

    // Browse dogs/testdogs.db/
    const schemaRes = await browseDirectory(handle, adapter, 's3://rk-iceberg/dogs/testdogs.db');
    assert.ok(!('error' in schemaRes));
    if (!('error' in schemaRes)) {
      assert.strictEqual(schemaRes.parentPath, 's3://rk-iceberg/dogs');
      assert.strictEqual(schemaRes.items.length, 1);
      assert.strictEqual(schemaRes.items[0].name, 'dogtable1');
      assert.strictEqual(schemaRes.items[0].isTable, true);
    }
  });

  await run('findCandidateWarehouseRoots discovers s3://rk-iceberg/dogs from bucket root', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: '', client: {} as any },
    };

    const candidates = await findCandidateWarehouseRoots(handle, adapter);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0], 's3://rk-iceberg/dogs');
  });

  await run('findCandidateWarehouseRoots discovers s3://rk-iceberg/dogs when starting from schema path', async () => {
    const adapter = makeMockAdapterForDogs();
    const handle: ActiveConnectionHandle = {
      connectionType: 's3',
      warehousePath: 's3://rk-iceberg/dogs/testdogs.db',
      s3Config: { bucket: 'rk-iceberg', keyPrefix: 'dogs/testdogs.db', client: {} as any },
    };

    const candidates = await findCandidateWarehouseRoots(handle, adapter);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0], 's3://rk-iceberg/dogs');
  });

  await run('Settings HTML includes Browse button, Detect button, Suggestion banner, and Warehouse browser', async () => {
    const { getSettingsHtml } = await import('../panels/html/settings.js');
    const html = getSettingsHtml('test-nonce', 'vscode-resource:', [{ id: 'c1', label: 'Existing' }]);
    assert.ok(html.includes('id="browse-warehouse-btn"'), 'HTML must contain browse-warehouse-btn');
    assert.ok(html.includes('id="detect-warehouse-btn"'), 'HTML must contain detect-warehouse-btn');
    assert.ok(html.includes('id="warehouse-browser"'), 'HTML must contain warehouse-browser');
    assert.ok(html.includes('id="path-suggestion"'), 'HTML must contain path-suggestion');
    assert.ok(html.includes('id="apply-suggestion-btn"'), 'HTML must contain apply-suggestion-btn');
  });

  await run('Settings panel handles browseDirectory and detectWarehouse messages', async () => {
    await withFakePanel(async ({ getMessages, fireMessage }) => {
      const mgr = new WebviewPanelManager(fakeContext, fakeStorageAdapter, testLogger);
      await mgr.openSettingsPanel(
        undefined,
        noopSaveConnection,
        noopActivateConnection,
        noopDeleteConnection,
        undefined,
        undefined,
        async (_config, _creds, _dirPath) => ({
          currentPath: 's3://rk-iceberg/dogs',
          parentPath: 's3://rk-iceberg',
          items: [{ name: 'testdogs.db', path: 's3://rk-iceberg/dogs/testdogs.db', isTable: false, isSchema: true }],
        }),
        async (_config, _creds, _searchPath) => ['s3://rk-iceberg/dogs'],
      );

      // Fire browseDirectory
      await fireMessage({
        type: 'browseDirectory',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg/dogs',
      });

      const msgs = getMessages();
      const browseMsg = msgs.find((m) => m.type === 'browseDirectoryResult');
      assert.ok(browseMsg, 'Expected browseDirectoryResult message');
      assert.strictEqual(browseMsg!.currentPath, 's3://rk-iceberg/dogs');
      assert.strictEqual((browseMsg as any).items.length, 1);

      // Fire detectWarehouse
      await fireMessage({
        type: 'detectWarehouse',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
      });

      const detectMsg = msgs.find((m) => m.type === 'detectWarehouseResult');
      assert.ok(detectMsg, 'Expected detectWarehouseResult message');
      assert.strictEqual((detectMsg as any).suggestedPaths[0], 's3://rk-iceberg/dogs');
    });
  });

  await run('ConnectionManager saveConnection includes suggestedWarehousePath on failure', async () => {
    const ctx = makeFakeContext();
    const cm = new ConnectionManager(ctx, testLogger);
    const adapter = makeMockAdapterForDogs();

    const result = await cm.saveConnection(
      {
        id: 'auto-test',
        label: 'Auto Detect Test',
        connectionType: 's3',
        warehousePath: 's3://rk-iceberg',
        region: 'us-east-1',
        sslVerification: true,
      },
      { accessKey: 'ak', secretKey: 'sk' },
      adapter,
    );

    assert.ok(result instanceof Error, 'Expected saveConnection to fail for s3://rk-iceberg');
    assert.strictEqual((result as any).suggestedWarehousePath, 's3://rk-iceberg/dogs');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; }

})();
