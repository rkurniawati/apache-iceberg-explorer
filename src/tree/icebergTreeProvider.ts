/**
 * IcebergTreeProvider — VS Code TreeDataProvider implementation.
 *
 * Implements:
 *  FR-7  Lazy-load with loading indicator (AC-10)
 *  FR-8  Error/retry nodes on StorageError (AC-11)
 *  FR-9  Metadata versions sorted newest-first (AC-12)
 *
 * Component boundary rules (architecture.md §4):
 *  - Does NOT create WebviewPanel instances.
 *  - Does NOT access SecretStorage or hold raw credential strings.
 *  - Dispatches open-panel requests via the icebergExplorer.openMetadataPanel command only.
 */

import * as vscode from 'vscode';

import type { ILogger } from '../extension.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import { isStorageError } from '../storage/errors.js';
import type { ConnectionConfig } from '../connection/types.js';
import {
  IcebergTreeItem,
  makeConnectionItem,
  makeSchemaItem,
  makeTableItem,
  makeMetadataVersionItem,
  makeMetadataFolderItem,
  makeDataFolderItem,
  makeDataDirectoryItem,
  makeDataFileItem,
  makeLoadingItem,
  makeErrorItem,
} from './types.js';
import type { TreeNodeType } from './types.js';

// ---------------------------------------------------------------------------
// Root path sentinel — used as the Map key for root-level children when a
// connection is active (the active connection's sub-tree root).
// ---------------------------------------------------------------------------

const ROOT_PATH = '__root__';

// ---------------------------------------------------------------------------
// IcebergTreeProvider
// ---------------------------------------------------------------------------

export class IcebergTreeProvider
  implements vscode.TreeDataProvider<IcebergTreeItem> {

  // ── Event emitter ──────────────────────────────────────────────────────────

  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<IcebergTreeItem | undefined | null | void>();

  /** VS Code calls this to subscribe to tree refresh events. */
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // ── State ──────────────────────────────────────────────────────────────────

  private handle: ActiveConnectionHandle | null = null;
  private activeConnectionId: string | null = null;
  private configs: ConnectionConfig[] = [];

  /**
   * Children cache.  Keyed by the parent node's `resourcePath` (or ROOT_PATH
   * for the active connection's schema-level root).
   * A cache hit means the async fetch has completed; the loading item is never stored here.
   */
  private readonly cache = new Map<string, IcebergTreeItem[]>();

  // ── Constructor ────────────────────────────────────────────────────────────

  constructor(
    private storageAdapter: StorageAdapter,
    private readonly logger: ILogger,
    private readonly _activateConnection: (id: string) => Promise<{ handle: ActiveConnectionHandle; adapter: StorageAdapter } | Error>,
    private readonly _deleteConnection:   (id: string) => Promise<void>,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Replace the full list of saved connection configs.  Fires a full tree refresh.
   */
  setConnections(configs: ConnectionConfig[]): void {
    this.configs = configs;
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Update the active connection handle.  Call with `null` to reset to the
   * "not configured" state.  Fires a full tree refresh in both cases.
   */
  setActiveConnection(
    handle: ActiveConnectionHandle | null,
    adapter?: StorageAdapter,
  ): void {
    this.handle = handle;
    if (adapter) {
      this.storageAdapter = adapter;
    }
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Mark a connection as active by config id.  Used after activating a connection
   * so its tree node renders with the active icon and expands to show schemas.
   */
  setActiveConnectionId(id: string | null): void {
    this.activeConnectionId = id;
    // Do not fire here — callers will call setActiveConnection which also fires.
  }

  /** Returns the currently active storage adapter. */
  getStorageAdapter(): StorageAdapter {
    return this.storageAdapter;
  }

  /** Returns the currently active connection handle, or null if not connected. */
  getActiveHandle(): ActiveConnectionHandle | null {
    return this.handle;
  }

  /**
   * Clear the cache entry for a given path and fire a refresh so VS Code
   * re-calls `getChildren` for that node.  Used by the retry command.
   */
  clearCache(parentPath: string): void {
    this.cache.delete(parentPath);
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider implementation ───────────────────────────────────────

  getTreeItem(element: IcebergTreeItem): IcebergTreeItem {
    return element;
  }

  /**
   * Required for TreeView.reveal() — returns the parent of a tree item by
   * looking it up in the cache via the item's parentPath.
   */
  getParent(element: IcebergTreeItem): IcebergTreeItem | undefined {
    if (!element.parentPath) { return undefined; }
    for (const children of this.cache.values()) {
      for (const child of children) {
        if (child.resourcePath === element.parentPath) {
          return child;
        }
      }
    }
    return undefined;
  }

  /**
   * Find a cached tree item by its exact resourcePath, or undefined if not yet loaded.
   */
  findItemByPath(resourcePath: string): IcebergTreeItem | undefined {
    for (const children of this.cache.values()) {
      for (const child of children) {
        if (child.resourcePath === resourcePath) {
          return child;
        }
      }
    }
    return undefined;
  }

  getChildren(element?: IcebergTreeItem): IcebergTreeItem[] | Promise<IcebergTreeItem[]> {
    // ── Root level ────────────────────────────────────────────────────────────
    if (element === undefined) {
      if (this.configs.length === 0) {
        // No connections saved — show placeholder
        const item = new IcebergTreeItem(
          'No connections \u2014 click \u2699 to add one',
          'loading',
          '__not-configured__',
        );
        item.command = {
          command: 'icebergExplorer.openSettings',
          title: 'Add connection',
        };
        return [item];
      }
      // One node per saved connection
      return this.configs.map((cfg) =>
        makeConnectionItem(cfg, cfg.id === this.activeConnectionId),
      );
    }

    // ── Connection node ───────────────────────────────────────────────────────
    if (element.nodeType === 'connection') {
      if (element.resourcePath !== this.activeConnectionId || this.handle === null) {
        // Inactive connection — no sub-tree
        return [];
      }
      // Active connection — show its schemas (delegate to root fetch logic)
      return this.getSchemaChildren(ROOT_PATH);
    }

    // ── Leaf node types (no children) ────────────────────────────────────────
    if (
      element.nodeType === 'metadataVersion' ||
      element.nodeType === 'dataFile' ||
      element.nodeType === 'loading' ||
      element.nodeType === 'error'
    ) {
      return [];
    }

    // ── Determine the cache key ───────────────────────────────────────────────
    const cacheKey = element.resourcePath;

    // ── Cache hit ─────────────────────────────────────────────────────────────
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // ── Determine parent node type (for error-item construction) ──────────────
    const parentNodeType: TreeNodeType = element.nodeType;

    // ── Start async fetch; return loading item immediately ────────────────────
    this.fetchChildren(element, cacheKey, parentNodeType);
    return [makeLoadingItem(cacheKey)];
  }

  // ── Schema children (shared between old root path and connection node) ──────

  private getSchemaChildren(cacheKey: string): IcebergTreeItem[] {
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    this.fetchSchemas(cacheKey);
    return [makeLoadingItem(cacheKey)];
  }

  // ── Internal fetch logic ──────────────────────────────────────────────────

  /**
   * Fetch schemas for the active connection (root-level fetch triggered by a
   * connection node expansion).
   */
  private fetchSchemas(cacheKey: string): void {
    const handle = this.handle!;

    void (async () => {
      try {
        this.logger.info(
          `Lazy-loading children for node type=schema path=${cacheKey}`,
        );
        const result = await this.storageAdapter.listSchemas(handle);
        let children: IcebergTreeItem[];
        if (isStorageError(result)) {
          this.logger.warn(
            `Child load failed for schema: ${result.class} — showing retry node`,
          );
          children = [makeErrorItem(cacheKey, 'schema', result.message)];
        } else {
          children = await Promise.all(
            result.map(async (schemaPath) => {
              const tableCheck = await this.storageAdapter.isTable(handle, schemaPath);
              const isT = !isStorageError(tableCheck) && tableCheck;
              const label = lastSegment(schemaPath);
              return isT
                ? makeTableItem(schemaPath, label, cacheKey)
                : makeSchemaItem(schemaPath, label);
            }),
          );
        }
        this.cache.set(cacheKey, children);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
        this.logger.warn(
          `Child load failed for schema: internal — showing retry node`,
        );
        this.cache.set(cacheKey, [makeErrorItem(cacheKey, 'schema', errorMsg)]);
      } finally {
        this._onDidChangeTreeData.fire(undefined);
      }
    })();
  }

  /**
   * Perform the async Storage Layer call, populate the cache, then fire a
   * tree refresh so VS Code calls `getChildren` again and gets real children.
   */
  private fetchChildren(
    element: IcebergTreeItem,
    cacheKey: string,
    parentNodeType: TreeNodeType,
  ): void {
    const handle = this.handle!;

    void (async () => {
      try {
        let children: IcebergTreeItem[];

        if (element.nodeType === 'schema') {
          // ── Schema → tables or nested namespaces ────────────────────────────
          this.logger.info(
            `Lazy-loading children for node type=table path=${element.resourcePath}`,
          );
          const result = await this.storageAdapter.listTables(handle, element.resourcePath);
          if (isStorageError(result)) {
            this.logger.warn(
              `Child load failed for table: ${result.class} — showing retry node`,
            );
            children = [makeErrorItem(cacheKey, parentNodeType, result.message)];
          } else {
            children = await Promise.all(
              result.map(async (tablePath) => {
                const tableCheck = await this.storageAdapter.isTable(handle, tablePath);
                const isT = !isStorageError(tableCheck) && tableCheck;
                const label = lastSegment(tablePath);
                return isT
                  ? makeTableItem(tablePath, label, element.resourcePath)
                  : makeSchemaItem(tablePath, label);
              }),
            );
          }

        } else if (element.nodeType === 'table') {
          // ── Table → virtual folder nodes + root-level data files ─────────────
          this.logger.info(
            `Lazy-loading children for node type=table path=${element.resourcePath}`,
          );
          const result = await this.storageAdapter.listDirectoryContents(handle, element.resourcePath);
          if (isStorageError(result)) {
            this.logger.warn(
              `Child load failed for table: ${result.class} — showing retry node`,
            );
            children = [makeErrorItem(cacheKey, parentNodeType, result.message)];
          } else {
            children = [];
            const hasMetadata = result.subdirectories.includes('metadata');
            const hasData = result.subdirectories.includes('data');

            if (hasMetadata || hasData) {
              if (hasMetadata) {
                children.push(makeMetadataFolderItem(element.resourcePath));
              }
              if (hasData) {
                children.push(makeDataFolderItem(element.resourcePath));
              }
              // D3: root-level files at the table path (not inside data/)
              for (const fileName of result.files) {
                const filePath = `${element.resourcePath}/${fileName}`;
                children.push(makeDataFileItem(filePath, fileName, handle, element.resourcePath));
              }
            } else if (result.subdirectories.length > 0) {
              // Node was marked as table but contains subdirectories instead of metadata/data.
              // Gracefully treat as an intermediate namespace and resolve child items.
              this.logger.info(
                `Table node path=${element.resourcePath} has no metadata/data; resolving subdirectories: [${result.subdirectories.join(', ')}]`,
              );
              children = await Promise.all(
                result.subdirectories.map(async (subDir) => {
                  const subPath = `${element.resourcePath}/${subDir}`;
                  const tableCheck = await this.storageAdapter.isTable(handle, subPath);
                  const isT = !isStorageError(tableCheck) && tableCheck;
                  return isT
                    ? makeTableItem(subPath, subDir, element.resourcePath)
                    : makeSchemaItem(subPath, subDir);
                }),
              );
            }
          }


        } else if (element.nodeType === 'metadataFolder') {
          // ── Metadata folder → metadata versions ──────────────────────────────
          this.logger.info(
            `Lazy-loading children for node type=metadataFolder path=${element.resourcePath}`,
          );
          // parentPath is the table path (stored at construction time)
          const tablePath = element.parentPath ?? element.resourcePath.replace(/\/metadata$/, '');
          const result = await this.storageAdapter.listMetadataVersions(handle, tablePath);
          if (isStorageError(result)) {
            this.logger.warn(
              `Child load failed for metadataFolder: ${result.class} \u2014 showing retry node`,
            );
            children = [makeErrorItem(cacheKey, parentNodeType, result.message)];
          } else {
            // FR-9, AC-12: sort newest-first by sortKey descending
            const sorted = [...result].sort((a, b) => b.sortKey - a.sortKey);
            children = sorted.map((entry) =>
              makeMetadataVersionItem(
                entry.resourcePath,
                entry.label,
                entry.sortKey,
                handle,
                element.resourcePath,
              ),
            );
          }

        } else if (element.nodeType === 'dataFolder' || element.nodeType === 'dataDirectory') {
          // ── Data folder / Data directory → sub-dirs and files ────────────────
          this.logger.info(
            `Lazy-loading children for node type=${element.nodeType} path=${element.resourcePath}`,
          );
          const result = await this.storageAdapter.listDirectoryContents(handle, element.resourcePath);
          if (isStorageError(result)) {
            this.logger.warn(
              `Child load failed for ${element.nodeType}: ${result.class} \u2014 showing retry node`,
            );
            children = [makeErrorItem(cacheKey, parentNodeType, result.message)];
          } else {
            children = [];
            for (const dirName of result.subdirectories) {
              const dirPath = `${element.resourcePath}/${dirName}`;
              children.push(makeDataDirectoryItem(dirPath, dirName, element.resourcePath));
            }
            for (const fileName of result.files) {
              const filePath = `${element.resourcePath}/${fileName}`;
              children.push(makeDataFileItem(filePath, fileName, handle, element.resourcePath));
            }
          }

        } else {
          children = [];
        }

        this.cache.set(cacheKey, children);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
        this.logger.warn(
          `Child load failed for ${parentNodeType}: internal \u2014 showing retry node`,
        );
        this.cache.set(cacheKey, [makeErrorItem(cacheKey, parentNodeType, errorMsg)]);
      } finally {
        // Fire refresh — VS Code will call getChildren again and get the cached result
        this._onDidChangeTreeData.fire(undefined);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Returns the last path segment of a local path or S3 URI. */
function lastSegment(p: string): string {
  const trimmed = p.replace(/\/$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
