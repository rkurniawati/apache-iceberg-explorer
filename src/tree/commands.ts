/**
 * Tree View command registrations (architecture.md §4, design.md §2.7).
 *
 * Registers:
 *  - icebergExplorer.openMetadataPanel   — opens the metadata detail panel
 *  - icebergExplorer.retryTreeNode       — clears cache and re-fetches children
 *  - icebergExplorer.activateConnection  — activates a saved connection
 *  - icebergExplorer.editConnection      — opens settings pre-populated for editing
 *  - icebergExplorer.deleteConnection    — deletes a saved connection
 *
 * Component boundary rule: commands delegate to the appropriate component;
 * this module never creates WebviewPanel instances directly.
 */

import * as vscode from 'vscode';

import type { ILogger } from '../extension.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { ConnectionConfig } from '../connection/types.js';
import type { WebviewPanelManager } from '../panels/webviewPanelManager.js';
import type { IcebergTreeProvider } from './icebergTreeProvider.js';
import type { IcebergTreeItem, TreeNodeType } from './types.js';

// ---------------------------------------------------------------------------
// registerTreeCommands
// ---------------------------------------------------------------------------

export function registerTreeCommands(
  context: vscode.ExtensionContext,
  provider: IcebergTreeProvider,
  panelManager: WebviewPanelManager,
  logger: ILogger,
  activateConnection: (id: string) => Promise<{ handle: ActiveConnectionHandle; adapter: StorageAdapter } | Error>,
  deleteConnection:   (id: string) => Promise<void>,
  listConnections:    () => ConnectionConfig[],
): void {

  // ── icebergExplorer.openMetadataPanel ────────────────────────────────────
  // Arguments: [resourcePath: string, handle: ActiveConnectionHandle]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.openMetadataPanel',
      (resourcePath: string, handle: ActiveConnectionHandle) => {
        logger.info(
          `openMetadataPanel command: resource=${resourcePath}`,
        );
        void panelManager.openMetadataDetailPanel(resourcePath, handle, provider.getStorageAdapter());
      },
    ),
  );

  // ── icebergExplorer.openParquetPreview ──────────────────────────────────
  // Arguments: [resourcePath: string]
  // The handle is retrieved from the provider to avoid passing the S3Client
  // (which has circular references) through JSON-serialised command arguments.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.openParquetPreview',
      (resourcePath: string) => {
        logger.info(`openParquetPreview command: resource=${resourcePath}`);
        const handle = provider.getActiveHandle();
        if (!handle) {
          logger.warn('openParquetPreview: no active connection handle — ignoring');
          return;
        }
        void panelManager.openParquetPreviewPanel(resourcePath, handle, provider.getStorageAdapter());
      },
    ),
  );

  // ── icebergExplorer.retryTreeNode ────────────────────────────────────────
  // Arguments: [parentPath: string, nodeType: TreeNodeType]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.retryTreeNode',
      (parentPath: string, _nodeType: TreeNodeType) => {
        logger.info(
          `retryTreeNode command: parentPath=${parentPath}`,
        );
        provider.clearCache(parentPath);
      },
    ),
  );

  // ── icebergExplorer.openTableOverview ──────────────────────────────────
  // Arguments: [tablePath: string]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.openTableOverview',
      async (tablePath: string) => {
        logger.info(`openTableOverview command: path=${tablePath}`);
        const handle = provider.getActiveHandle();
        if (!handle) {
          logger.warn('openTableOverview: no active connection handle — ignoring');
          return;
        }
        void panelManager.openTableOverviewPanel(tablePath, handle, provider.getStorageAdapter());
      },
    ),
  );

  // ── icebergExplorer.openConnectionDashboard ──────────────────────────────
  // Arguments: [id: string]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.openConnectionDashboard',
      async (id: string) => {
        logger.info(`openConnectionDashboard command: id=${id}`);
        const configs = listConnections();
        const config = configs.find(c => c.id === id);
        const handle = provider.getActiveHandle();
        if (!config || !handle) { return; }
        void panelManager.openConnectionDashboardPanel(config, handle, provider.getStorageAdapter());
      },
    ),
  );

  // ── icebergExplorer.openMetadataArchitecture ────────────────────────────
  // Arguments: [tablePath: string]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.openMetadataArchitecture',
      async (tablePath: string) => {
        logger.info(`openMetadataArchitecture command: path=${tablePath}`);
        const handle = provider.getActiveHandle();
        if (!handle) {
          logger.warn('openMetadataArchitecture: no active connection handle — ignoring');
          return;
        }
        void panelManager.openMetadataArchitecturePanel(tablePath, handle, provider.getStorageAdapter());
      },
    ),
  );

  // ── icebergExplorer.activateConnection ──────────────────────────────────
  // Arguments: [id: string]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.activateConnection',
      async (id: string) => {
        logger.info('activateConnection command');
        const result = await activateConnection(id);
        if (result instanceof Error) {
          void vscode.window.showErrorMessage(
            `Failed to activate connection: ${result.message}`,
          );
          return;
        }
        provider.setActiveConnectionId(id);
        provider.setActiveConnection(result.handle, result.adapter);

        const configs = listConnections();
        const config = configs.find(c => c.id === id);
        if (config) {
          void panelManager.openConnectionDashboardPanel(config, result.handle, result.adapter);
        }
      },
    ),
  );

  // ── icebergExplorer.editConnection ──────────────────────────────────────
  // Arguments: [id: string] — VS Code passes tree item when from context menu
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.editConnection',
      (idOrItem: string | IcebergTreeItem) => {
        const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.resourcePath;
        logger.info('editConnection command');
        void vscode.commands.executeCommand('icebergExplorer.openSettings', id);
      },
    ),
  );

  // ── icebergExplorer.deleteConnection ────────────────────────────────────
  // Arguments: [id: string] or [item: IcebergTreeItem]
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'icebergExplorer.deleteConnection',
      async (idOrItem: string | IcebergTreeItem) => {
        const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.resourcePath;
        logger.info('deleteConnection command');
        await deleteConnection(id);
        provider.setConnections(listConnections());
        // If the deleted connection was active, clear the active handle
        if (provider.getActiveHandle() !== null) {
          const remaining = listConnections();
          const stillActive = remaining.some((c) => c.id === id);
          if (!stillActive) {
            provider.setActiveConnectionId(null);
            provider.setActiveConnection(null);
          }
        }
      },
    ),
  );
}
