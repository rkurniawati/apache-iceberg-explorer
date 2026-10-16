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
import { globalLocationResolver } from '../storage/locationResolver.js';
import {
  IcebergTreeItem,
  makeConnectionItem,
  makeSchemaItem,
  makeTableItem,
  makeViewItem,
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
  private readonly pendingFetches = new Map<string, Promise<IcebergTreeItem[]>>();

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
    this.pendingFetches.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Mark a connection as active by config id. */
  setActiveConnectionId(id: string | null): void {
    this.activeConnectionId = id;
    // Do not fire here — callers will call setActiveConnection which also fires.
  }

  /** Returns the ID of the currently active connection, or null. */
  getActiveConnectionId(): string | null {
    return this.activeConnectionId;
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
    this.pendingFetches.delete(parentPath);
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider implementation ───────────────────────────────────────

  getTreeItem(element: IcebergTreeItem): IcebergTreeItem {
    return element;
  }

  /**
   * Required for TreeView.reveal() — returns the parent of a tree item by
   * checking connection configs and looking up in the cache via the item's parentPath.
   */
  getParent(element: IcebergTreeItem): IcebergTreeItem | undefined {
    if (!element.parentPath) { return undefined; }

    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');

    // If the parent is the active connection
    if (
      this.activeConnectionId &&
      (element.parentPath === this.activeConnectionId || element.parentPath === ROOT_PATH)
    ) {
      const activeCfg = this.configs.find((c) => c.id === this.activeConnectionId);
      if (activeCfg) {
        return makeConnectionItem(activeCfg, true);
      }
    }

    // Check if parent matches any connection config (by ID or warehousePath)
    const connCfg = this.configs.find(
      (c) => c.id === element.parentPath || norm(c.warehousePath) === norm(element.parentPath!)
    );
    if (connCfg) {
      return makeConnectionItem(connCfg, connCfg.id === this.activeConnectionId);
    }

    const normParent = norm(element.parentPath);
    for (const children of this.cache.values()) {
      for (const child of children) {
        if (child.resourcePath === element.parentPath || norm(child.resourcePath) === normParent) {
          return child;
        }
      }
    }
    return undefined;
  }

  /**
   * Find a tree item by its exact resourcePath or connection ID/warehousePath,
   * or undefined if not yet loaded.
   */
  findItemByPath(resourcePath: string): IcebergTreeItem | undefined {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
    const activeCfg = this.configs.find((c) => c.id === this.activeConnectionId);
    const resolved = globalLocationResolver.resolvePath(resourcePath, activeCfg?.warehousePath);
    const normTarget = norm(resourcePath);
    const normResolved = norm(resolved);

    // Check saved connections first
    const conn = this.configs.find(
      (c) => c.id === resourcePath || norm(c.warehousePath) === normTarget || norm(c.warehousePath) === normResolved
    );
    if (conn) {
      return makeConnectionItem(conn, conn.id === this.activeConnectionId);
    }

    for (const children of this.cache.values()) {
      for (const child of children) {
        if (
          child.resourcePath === resourcePath ||
          norm(child.resourcePath) === normTarget ||
          norm(child.resourcePath) === normResolved
        ) {
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
        // No connections saved — return empty list so VS Code displays viewsWelcome
        return [];
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
    void this.fetchSchemasAsync(cacheKey);
  }

  /**
   * Async version of fetchSchemas that returns the loaded children and reuses in-flight fetches.
   */
  async fetchSchemasAsync(cacheKey: string): Promise<IcebergTreeItem[]> {
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    const pending = this.pendingFetches.get(cacheKey);
    if (pending) {
      return pending;
    }

    const handle = this.handle;
    if (!handle) {
      return [];
    }

    const promise = (async () => {
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
          const parentPath = this.activeConnectionId ?? ROOT_PATH;
          const rawChildren = await Promise.all(
            result.map(async (schemaPath) => {
              const label = lastSegment(schemaPath);
              if (label === 'metadata') return null;
              const tableCheck = await this.storageAdapter.isTable(handle, schemaPath);
              const isT = !isStorageError(tableCheck) && tableCheck;
              if (isT) {
                const isLikelyView = /(?:^|[._-])view(?:[._-]|$)/i.test(label);
                return isLikelyView
                  ? makeViewItem(schemaPath, label, parentPath)
                  : makeTableItem(schemaPath, label, parentPath);
              }
              if (label === 'data') return null;
              return makeSchemaItem(schemaPath, label, parentPath);
            }),
          );
          children = rawChildren.filter((c): c is IcebergTreeItem => c !== null);
        }
        this.cache.set(cacheKey, children);
        return children;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
        this.logger.warn(
          `Child load failed for schema: internal — showing retry node`,
        );
        const children = [makeErrorItem(cacheKey, 'schema', errorMsg)];
        this.cache.set(cacheKey, children);
        return children;
      } finally {
        this.pendingFetches.delete(cacheKey);
        this._onDidChangeTreeData.fire(undefined);
      }
    })();

    this.pendingFetches.set(cacheKey, promise);
    return promise;
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
    void this.fetchChildrenAsync(element, cacheKey, parentNodeType);
  }

  /**
   * Async version of fetchChildren that returns the loaded children and reuses in-flight fetches.
   */
  async fetchChildrenAsync(
    element: IcebergTreeItem,
    cacheKey: string,
    parentNodeType: TreeNodeType,
  ): Promise<IcebergTreeItem[]> {
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    const pending = this.pendingFetches.get(cacheKey);
    if (pending) {
      return pending;
    }

    const handle = this.handle;
    if (!handle) {
      return [];
    }

    const promise = (async () => {
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
            const rawChildren = await Promise.all(
              result.map(async (tablePath) => {
                const label = lastSegment(tablePath);
                if (label === 'metadata') return null;
                const tableCheck = await this.storageAdapter.isTable(handle, tablePath);
                const isT = !isStorageError(tableCheck) && tableCheck;
                if (isT) {
                  const isLikelyView = /(?:^|[._-])view(?:[._-]|$)/i.test(label);
                  return isLikelyView
                    ? makeViewItem(tablePath, label, element.resourcePath)
                    : makeTableItem(tablePath, label, element.resourcePath);
                }
                if (label === 'data') return null;
                return makeSchemaItem(tablePath, label, element.resourcePath);
              }),
            );
            children = rawChildren.filter((c): c is IcebergTreeItem => c !== null);
          }

        } else if (element.nodeType === 'table' || element.nodeType === 'view') {
          // ── Table / View → virtual folder nodes + root-level data files ─────
          this.logger.info(
            `Lazy-loading children for node type=${element.nodeType} path=${element.resourcePath}`,
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
              const rawChildren = await Promise.all(
                result.subdirectories.map(async (subDir) => {
                  if (subDir === 'metadata') return null;
                  const subPath = `${element.resourcePath}/${subDir}`;
                  const tableCheck = await this.storageAdapter.isTable(handle, subPath);
                  const isT = !isStorageError(tableCheck) && tableCheck;
                  if (isT) {
                    const isLikelyView = /(?:^|[._-])view(?:[._-]|$)/i.test(subDir);
                    return isLikelyView
                      ? makeViewItem(subPath, subDir, element.resourcePath)
                      : makeTableItem(subPath, subDir, element.resourcePath);
                  }
                  if (subDir === 'data') return null;
                  return makeSchemaItem(subPath, subDir, element.resourcePath);
                }),
              );
              children = rawChildren.filter((c): c is IcebergTreeItem => c !== null);
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
        return children;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
        this.logger.warn(
          `Child load failed for ${parentNodeType}: internal \u2014 showing retry node`,
        );
        const children = [makeErrorItem(cacheKey, parentNodeType, errorMsg)];
        this.cache.set(cacheKey, children);
        return children;
      } finally {
        this.pendingFetches.delete(cacheKey);
        // Fire refresh — VS Code will call getChildren again and get the cached result
        this._onDidChangeTreeData.fire(undefined);
      }
    })();

    this.pendingFetches.set(cacheKey, promise);
    return promise;
  }

  /**
   * Lazily loads tree nodes along the path to the target resource and returns
   * the corresponding IcebergTreeItem once loaded.
   */
  async resolveItemByPath(resourcePath: string): Promise<IcebergTreeItem | undefined> {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
    let activeCfg = this.configs.find((c) => c.id === this.activeConnectionId);
    const resolvedPath = globalLocationResolver.resolvePath(resourcePath, activeCfg?.warehousePath);
    const targetNorm = norm(resolvedPath);

    // 1. Fast path: check if already in cache or matches a connection
    const existing = this.findItemByPath(resourcePath) ?? this.findItemByPath(resolvedPath);
    if (existing) {
      return existing;
    }

    // 2. Identify the active or matching connection
    let warehouseNorm = activeCfg ? norm(activeCfg.warehousePath) : '';

    if (!activeCfg || (targetNorm !== warehouseNorm && !targetNorm.startsWith(warehouseNorm + '/'))) {
      const matchingConn = this.configs.find((c) => {
        const wNorm = norm(c.warehousePath);
        return targetNorm === wNorm || targetNorm.startsWith(wNorm + '/');
      });
      if (matchingConn) {
        if (matchingConn.id !== this.activeConnectionId) {
          const activated = await this._activateConnection(matchingConn.id);
          if (!(activated instanceof Error)) {
            this.setActiveConnectionId(matchingConn.id);
            this.setActiveConnection(activated.handle, activated.adapter);
            activeCfg = matchingConn;
            warehouseNorm = norm(activeCfg.warehousePath);
          } else {
            return undefined;
          }
        } else {
          activeCfg = matchingConn;
          warehouseNorm = norm(activeCfg.warehousePath);
        }
      }
    }

    if (!activeCfg || !this.handle) {
      return undefined;
    }

    if (targetNorm === warehouseNorm) {
      return makeConnectionItem(activeCfg, true);
    }

    if (!targetNorm.startsWith(warehouseNorm + '/')) {
      return undefined;
    }

    const relPath = targetNorm.slice(warehouseNorm.length + 1);
    const segments = relPath.split('/').filter(Boolean);
    if (segments.length === 0) {
      return undefined;
    }

    let currentChildren = await this.fetchSchemasAsync(ROOT_PATH);
    let currentItem: IcebergTreeItem | undefined;
    let accumulatedPath = warehouseNorm;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      accumulatedPath = `${accumulatedPath}/${seg}`;

      currentItem = currentChildren.find(
        (c) => norm(c.resourcePath) === accumulatedPath || lastSegment(c.resourcePath) === seg,
      );

      if (!currentItem) {
        return undefined;
      }

      if (i === segments.length - 1) {
        return currentItem;
      }

      currentChildren = await this.fetchChildrenAsync(
        currentItem,
        currentItem.resourcePath,
        currentItem.nodeType,
      );
    }

    return currentItem;
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
