/**
 * Tree View Provider types (architecture.md §3–4, design.md §2.7).
 *
 * Defines the node type discriminant and the tree item class used by
 * IcebergTreeProvider.  No credential strings appear anywhere in these types.
 */

import * as vscode from 'vscode';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { ConnectionConfig } from '../connection/types.js';

// ---------------------------------------------------------------------------
// Node type discriminant
// ---------------------------------------------------------------------------

export type TreeNodeType =
  | 'connection'       // saved connection node at the tree root
  | 'schema'
  | 'table'
  | 'metadataFolder'   // virtual "Metadata" node under table
  | 'dataFolder'        // virtual "Data" node under table
  | 'metadataVersion'
  | 'dataDirectory'    // drillable subdirectory inside data/
  | 'dataFile'         // non-filtered file inside data/ at any depth
  | 'loading'
  | 'error';

// ---------------------------------------------------------------------------
// IcebergTreeItem
// ---------------------------------------------------------------------------

/**
 * A VS Code TreeItem subclass that carries Iceberg-specific metadata.
 *
 * Construction rules (per prompt §Step 1):
 *  - `schema`          : collapsible, no command, icon $(database)
 *  - `table`           : collapsible, no command, icon $(table)
 *  - `metadataFolder`  : collapsible, no command, icon $(folder). Virtual "Metadata" node.
 *  - `dataFolder`      : collapsible, no command, icon $(folder). Virtual "Data" node.
 *  - `metadataVersion` : not collapsible, command icebergExplorer.openMetadataPanel, icon $(file-code)
 *  - `dataDirectory`   : collapsible, no command, icon $(folder-opened)
 *  - `dataFile`        : not collapsible. Parquet: command icebergExplorer.openParquetPreview, icon $(file-binary). Others: no command, icon $(file).
 *  - `loading`         : not collapsible, label "Loading…", icon $(loading~spin)
 *  - `error`           : not collapsible, command icebergExplorer.retryTreeNode, icon $(error)
 */
export class IcebergTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly nodeType: TreeNodeType,
    /** Fully-qualified path/URI — used as panel registry key component. */
    public readonly resourcePath: string,
    /** Resource path of the parent node — needed for retry. */
    public readonly parentPath?: string,
    /** Numeric sort key — higher is newer (metadataVersion nodes only). */
    public readonly sortKey?: number,
    /** Active connection handle — stored for command dispatch (metadataVersion, dataFile). */
    public readonly handle?: ActiveConnectionHandle,
  ) {
    super(label, collapsibleStateFor(nodeType));
    this.id = resourcePath;
  }
}

// ---------------------------------------------------------------------------
// Item factories
// ---------------------------------------------------------------------------

/** Creates a schema node. */
export function makeSchemaItem(schemaPath: string, label: string, parentPath?: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    label,
    'schema',
    schemaPath,
    parentPath,
  );
  item.iconPath = new vscode.ThemeIcon('database');
  item.command = {
    command: 'icebergExplorer.openSchemaOverview',
    title: 'Open Schema Overview',
    arguments: [schemaPath, label],
  };
  return item;
}

/** Creates a table node. */
export function makeTableItem(tablePath: string, label: string, parentPath: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    label,
    'table',
    tablePath,
    parentPath,
  );
  item.iconPath = new vscode.ThemeIcon('table');
  item.command = {
    command: 'icebergExplorer.openTableOverview',
    title: 'Open Table Overview',
    arguments: [tablePath],
  };
  return item;
}

/** Creates a metadata version node with an open-panel command. */
export function makeMetadataVersionItem(
  resourcePath: string,
  label: string,
  sortKey: number,
  handle: ActiveConnectionHandle,
  parentPath: string,
): IcebergTreeItem {
  const item = new IcebergTreeItem(
    label,
    'metadataVersion',
    resourcePath,
    parentPath,
    sortKey,
    handle,
  );
  item.iconPath = new vscode.ThemeIcon('file-code');
  item.command = {
    command: 'icebergExplorer.openMetadataPanel',
    title: 'Open',
    arguments: [resourcePath, handle],
  };
  return item;
}

/** Creates a virtual "Metadata" folder node under a table. */
export function makeMetadataFolderItem(tablePath: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    'Metadata',
    'metadataFolder',
    `${tablePath}/metadata`,
    tablePath,
  );
  item.iconPath = new vscode.ThemeIcon('folder');
  item.command = {
    command: 'icebergExplorer.openMetadataArchitecture',
    title: 'Open Metadata Architecture',
    arguments: [tablePath],
  };
  return item;
}

/** Creates a virtual "Data" folder node under a table. */
export function makeDataFolderItem(tablePath: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    'Data',
    'dataFolder',
    `${tablePath}/data`,
    tablePath,
  );
  item.iconPath = new vscode.ThemeIcon('folder');
  return item;
}

/** Creates a drillable data sub-directory node. */
export function makeDataDirectoryItem(
  resourcePath: string,
  label: string,
  parentPath: string,
): IcebergTreeItem {
  const item = new IcebergTreeItem(
    label,
    'dataDirectory',
    resourcePath,
    parentPath,
  );
  item.iconPath = new vscode.ThemeIcon('folder-opened');
  return item;
}

/** Creates a data file node. Parquet files get a preview command; others have no command. */
export function makeDataFileItem(
  resourcePath: string,
  label: string,
  handle: ActiveConnectionHandle,
  parentPath: string,
): IcebergTreeItem {
  const item = new IcebergTreeItem(
    label,
    'dataFile',
    resourcePath,
    parentPath,
    undefined,
    handle,
  );
  if (label.endsWith('.parquet')) {
    item.iconPath = new vscode.ThemeIcon('file-binary');
    // Pass only the serializable resourcePath string — the command handler
    // retrieves the live handle from the provider to avoid JSON circular refs.
    item.command = {
      command: 'icebergExplorer.openParquetPreview',
      title: 'Preview',
      arguments: [resourcePath],
    };
  } else {
    item.iconPath = new vscode.ThemeIcon('file');
  }
  return item;
}

/** Creates a loading spinner placeholder node. */
export function makeLoadingItem(parentPath: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    'Loading\u2026',
    'loading',
    `${parentPath}/__loading__`,
    parentPath,
  );
  item.iconPath = new vscode.ThemeIcon('loading~spin');
  return item;
}

/** Creates an error-with-retry node. */
export function makeErrorItem(parentPath: string, parentNodeType: TreeNodeType, errorMessage: string): IcebergTreeItem {
  const item = new IcebergTreeItem(
    'Error loading \u2014 click to retry',
    'error',
    `${parentPath}/__error__`,
    parentPath,
  );
  item.iconPath = new vscode.ThemeIcon('error');
  item.tooltip = errorMessage;
  item.command = {
    command: 'icebergExplorer.retryTreeNode',
    title: 'Retry',
    arguments: [parentPath, parentNodeType],
  };
  return item;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a connection node for a saved connection at the tree root. */
export function makeConnectionItem(config: ConnectionConfig, isActive: boolean): IcebergTreeItem {
  const item = new IcebergTreeItem(
    config.label,
    'connection',
    config.id,
  );
  item.description = `${config.connectionType.toUpperCase()} \u2014 ${config.warehousePath}`;
  item.tooltip = config.warehousePath;
  item.contextValue = 'icebergConnection';
  item.iconPath = isActive
    ? new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'))
    : new vscode.ThemeIcon('database');
  // Inactive connections have no sub-tree, so set collapsibleState explicitly
  // to None — this removes the expand chevron that would make them appear open.
  item.collapsibleState = isActive
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.None;
  item.command = {
    command: 'icebergExplorer.activateConnection',
    title: 'Activate',
    arguments: [config.id],
  };
  return item;
}

function collapsibleStateFor(nodeType: TreeNodeType): vscode.TreeItemCollapsibleState {
  // 'connection' is intentionally omitted here — makeConnectionItem sets
  // collapsibleState directly based on isActive, overriding this default.
  return nodeType === 'schema' ||
    nodeType === 'table' ||
    nodeType === 'metadataFolder' ||
    nodeType === 'dataFolder' ||
    nodeType === 'dataDirectory'
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
}
