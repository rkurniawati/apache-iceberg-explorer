import * as vscode from 'vscode';
import { ConnectionManager, browseDirectory, findCandidateWarehouseRoots, buildHandleForPath } from './connection/index.js';
import { WebviewPanelManager } from './panels/webviewPanelManager.js';
import { LocalFsAdapter } from './storage/localFsAdapter.js';
import { S3Adapter } from './storage/s3Adapter.js';
import { GcsAdapter } from './storage/gcsAdapter.js';
import { IcebergTreeProvider, registerTreeCommands } from './tree/index.js';
import { QueryEngine } from './query/index.js';

/**
 * Thin logger wrapper around VS Code OutputChannel.
 * Passed to every component at construction time so each one
 * never imports `vscode` directly for logging and can be replaced
 * with a test double in unit tests.
 */
export interface ILogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function createLogger(channel: vscode.OutputChannel): ILogger {
  return {
    info:  (msg) => channel.appendLine(`[info]  ${msg}`),
    warn:  (msg) => channel.appendLine(`[warn]  ${msg}`),
    error: (msg) => channel.appendLine(`[error] ${msg}`),
  };
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Logging — single OutputChannel for the extension lifetime (design.md §2.8)
  const channel = vscode.window.createOutputChannel('Iceberg Explorer');
  context.subscriptions.push(channel);
  const logger = createLogger(channel);
  logger.info('Iceberg Explorer activated');

  // Construct core components — Storage adapter selection is wired here; the real
  // StorageAdapter is injected when a connection is activated.  At this point we
  // only construct the ConnectionManager so activation remains < 500 ms (NFR-1).
  const connectionManager = new ConnectionManager(context, logger);

  const localFsAdapter = new LocalFsAdapter(logger);
  const s3Adapter = new S3Adapter(logger);
  const gcsAdapter = new GcsAdapter(logger);

  const getAdapterForType = (type: 'local' | 's3' | 'gcs') =>
    type === 's3' ? s3Adapter : type === 'gcs' ? gcsAdapter : localFsAdapter;

  // Callback injected into tree provider and commands to activate a connection by id.
  const activateConnectionCallback = async (id: string) => {
    const result = await connectionManager.activateConnection(id);
    if (result instanceof Error) { return result; }
    const adapter = getAdapterForType(result.connectionType);
    return { handle: result, adapter };
  };

  // Tree View Provider — constructed with injected callbacks (D3).
  const treeProvider = new IcebergTreeProvider(
    localFsAdapter,
    logger,
    activateConnectionCallback,
    (id) => connectionManager.deleteConnection(id),
  );

  // Populate tree with initially saved connections
  treeProvider.setConnections(connectionManager.listConnections());

  // createTreeView (instead of registerTreeDataProvider) gives us a TreeView handle
  // with a .reveal() method, required for breadcrumb navigation (FR-18).
  // Registering treeView immediately ensures VS Code has a provider right away.
  const treeView = vscode.window.createTreeView('icebergExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Mark tree as initialized to dismiss viewsWelcome loading state
  void vscode.commands.executeCommand('setContext', 'icebergExplorer.initialized', true);
  logger.info('Iceberg Explorer tree view registered');

  const queryEngine = new QueryEngine(logger, context.extensionUri);
  // Warm up WASM asynchronously so activation remains snappy.
  setTimeout(() => queryEngine.warmUp(), 0);
  // Ensure the worker thread is terminated when the extension is deactivated.
  context.subscriptions.push({ dispose: () => queryEngine.dispose() });

  const panelManager = new WebviewPanelManager(
    context,
    localFsAdapter,
    logger,
    queryEngine,
    async (resourcePath: string) => {
      try {
        let item = treeProvider.findItemByPath(resourcePath);
        if (!item) {
          item = await treeProvider.resolveItemByPath(resourcePath);
        }
        if (item) {
          await treeView.reveal(item, { select: true, focus: false, expand: true });
          logger.info(`Tree reveal: ${resourcePath}`);
        } else {
          logger.warn(`Tree reveal skipped — item not cached: ${resourcePath}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Tree reveal failed: ${msg}`);
      }
    },
    () => connectionManager.listConnections(),
  );

  // Register the settings command (FR-1, AC-1).
  // Accepts an optional editId to pre-populate the form for editing.
  context.subscriptions.push(
    vscode.commands.registerCommand('icebergExplorer.openSettings', (editId?: string) => {
      // Look up the config for pre-populating the edit form (non-credential fields only)
      const editConfig = editId ? connectionManager.listConnections().find((c) => c.id === editId) : undefined;
      void panelManager.openSettingsPanel(
        editConfig,
        // saveConnection returns string | Error; throw on Error so the panel
        // can post saveError (design.md §2.5.2)
        async (config, creds) => {
          const adapter = getAdapterForType(config.connectionType);
          const result = await connectionManager.saveConnection(config, creds, adapter);
          if (result instanceof Error) { throw result; }
          // Keep the tree in sync after save
          treeProvider.setConnections(connectionManager.listConnections());
          return result;
        },
        // activateConnection returns ActiveConnectionHandle | Error; the panel
        // callback signature expects ActiveConnectionHandle | StorageError —
        // wrap an Error as a StorageError so the panel can post activateError
        async (id) => {
          const result = await connectionManager.activateConnection(id);
          if (result instanceof Error) {
            return { kind: 'StorageError' as const, class: 'internal' as const, message: result.message };
          }
          // Notify tree provider of the newly activated connection (FR-7)
          const adapter = getAdapterForType(result.connectionType);
          treeProvider.setActiveConnectionId(id);
          treeProvider.setActiveConnection(result, adapter);

          // Select and expand the corresponding node in the tree view
          try {
            const item = treeProvider.findItemByPath(id);
            if (item) {
              await treeView.reveal(item, { select: true, focus: false, expand: true });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`Tree reveal failed on activate: ${msg}`);
          }

          // Open the overview webview (Connection Dashboard)
          const configs = connectionManager.listConnections();
          const config = configs.find((c) => c.id === id);
          if (config) {
            void panelManager.openConnectionDashboardPanel(config, result, adapter);
          }

          return result;
        },
        (id) => {
          const p = connectionManager.deleteConnection(id);
          // Keep the tree in sync after delete
          void p.then(() => treeProvider.setConnections(connectionManager.listConnections()));
          return p;
        },
        () => connectionManager.listConnections(),
        (id) => connectionManager.hasCredential(id),
        async (config, creds, dirPath) => {
          const handle = await connectionManager.createTemporaryHandle(config, creds);
          if (handle instanceof Error) { return handle; }
          const adapter = getAdapterForType(config.connectionType);
          const targetPath = dirPath || config.warehousePath;
          return browseDirectory(handle, adapter, targetPath);
        },
        async (config, creds, searchPath) => {
          const handle = await connectionManager.createTemporaryHandle(config, creds);
          if (handle instanceof Error) { return handle; }
          const adapter = getAdapterForType(config.connectionType);
          const targetPath = searchPath || config.warehousePath;
          const pathHandle = buildHandleForPath(handle, targetPath);
          return findCandidateWarehouseRoots(pathHandle, adapter);
        },
      );
    }),
  );

  // Register tree-related commands (openMetadataPanel, retryTreeNode, connectConnection, disconnectConnection, editConnection, deleteConnection)
  registerTreeCommands(
    context,
    treeProvider,
    panelManager,
    logger,
    activateConnectionCallback,
    (id) => connectionManager.deleteConnection(id),
    () => connectionManager.listConnections(),
  );
}

export function deactivate(): void {
  // context.subscriptions handles cleanup; nothing explicit needed here.
}
