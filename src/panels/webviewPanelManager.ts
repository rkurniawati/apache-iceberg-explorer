/**
 * Webview Panel Manager — manages all VS Code WebviewPanel instances.
 *
 * Implements:
 *  T-15  Module scaffold, panel registry, PanelType enum
 *  T-16  openMetadataDetailPanel + one-panel-per-resource guard (FR-19, AD-6)
 *  T-17  loadMetadataPanel — fetch via Storage Layer, post messages
 *  T-28  Panel state machine and error surface (FR-20, design.md §2.3)
 *  T-29  Logging contract (design.md §2.8.2)
 *  T-31  Manifest list / manifest file / Parquet preview / ad-hoc query panels
 *        (FR-11, FR-12, FR-13, FR-14–FR-17, NFR-6, design.md §2.6)
 */
import * as vscode from 'vscode';

import type { ILogger } from '../extension.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import { isStorageError, type ErrorClass, type StorageError } from '../storage/errors.js';
import type { ConnectionConfig } from '../connection/types.js';
import { PanelType, panelRegistryKey } from './types.js';
import type { WebviewMessage } from './messages.js';
import { generateNonce, getMetadataDetailHtml } from './html/metadataDetail.js';
import { getSettingsHtml } from './html/settings.js';
import { getManifestListHtml } from './html/manifestList.js';
import { getManifestFileHtml } from './html/manifestFile.js';
import { getParquetPreviewHtml } from './html/parquetPreview.js';
import { getAdHocQueryHtml } from './html/adHocQuery.js';
import { getTableOverviewHtml } from './html/tableOverview.js';
import { getSchemaOverviewHtml } from './html/schemaOverview.js';
import { getConnectionDashboardHtml } from './html/connectionDashboard.js';
import { getMetadataArchitectureHtml } from './html/metadataArchitecture.js';
import type {
  TableColumnSummary,
  TablePartitionField,
  SnapshotSummaryItem,
  DiscoveredTableItem,
  DiscoveredSchemaItem,
  ManifestArchitectureCard,
  ManifestDataFileEntry,
} from './messages.js';
import { lastPathSegment, resourcePathToBreadcrumbs } from './utils.js';
import type { QueryEngine, ManifestEntryRow, DataFileRow } from '../query/index.js';
import { isQueryError } from '../query/index.js';
import { analyzeQuery } from '../query/sqlAnalyzer.js';

// ---------------------------------------------------------------------------
// User-facing error strings — one per error class (design.md §2.5.2, FR-20)
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<ErrorClass, string> = {
  'access-denied': 'Access denied. Check your connection credentials and permissions.',
  'not-found':     'File not found. The resource may have been deleted or moved.',
  'parse-failure': 'Could not read file. The file may be corrupted or in an unsupported format.',
  'internal':      'An unexpected error occurred. Please try again.',
};

const QUERY_ERROR_MESSAGES: Record<string, string> = {
  'parse-failure': 'Could not read file. The file may be corrupted or in an unsupported format.',
  'timeout':       'Query timed out after 30 seconds. Try a more selective query.',
  'cancelled':     'Operation cancelled.',
  'internal':      'An unexpected error occurred. Please try again.',
};

export interface ResolvedTableParquet {
  parquetPaths: string[];
  tableName: string;
  totalDataFiles: number;
  accumulatedRecords: number;
  accumulatedBytes: number;
  isSampled: boolean;
  requestedLimit?: number;
  isSimpleScan: boolean;
}

// ---------------------------------------------------------------------------
// Webview ready gate — prevents dropped postMessage calls on fast error paths
// ---------------------------------------------------------------------------

/**
 * Wraps a WebviewPanel and buffers outbound messages until the webview JS
 * has posted a `webviewReady` signal.  VS Code webviews parse and execute
 * their inline script asynchronously after `panel.webview.html` is set;
 * messages posted before the `window.addEventListener('message', ...)` call
 * is reached are silently dropped.
 *
 * Usage:
 *  1. Create the gate before setting panel.webview.html.
 *  2. Use `gate.post(msg)` instead of `panel.webview.postMessage(msg)`.
 *  3. In `onDidReceiveMessage`, call `gate.onHostMessage(msg)` to detect the
 *     `webviewReady` signal and flush the queue.
 *  4. Every HTML shell must post `{ type: 'webviewReady' }` as its very first
 *     line of inline script (before attaching any other listeners).
 */
class WebviewReadyGate {
  private ready = false;
  private queue: unknown[] = [];
  private lastTerminalMessage: unknown | null = null;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly logger: ILogger,
    private readonly label: string,
  ) {}

  /**
   * Handle an incoming message from the webview.  Returns `true` if the
   * message was the `webviewReady` signal (caller should not process it
   * further); `false` otherwise.
   */
  onHostMessage(msg: unknown): boolean {
    if ((msg as { type?: string })?.type === 'webviewReady') {
      this.ready = true;
      if (this.lastTerminalMessage) {
        void this.panel.webview.postMessage(this.lastTerminalMessage);
      }
      for (const queued of this.queue) {
        void this.panel.webview.postMessage(queued);
      }
      this.queue = [];
      return true;
    }
    return false;
  }

  /** Post a message — buffers it if the webview isn't ready yet. */
  post(msg: unknown): void {
    const type = (msg as { type?: string })?.type;
    if (type && (type.startsWith('load') || (type === 'setState' && (msg as { state?: string }).state === 'error'))) {
      this.lastTerminalMessage = msg;
    }
    if (this.ready) {
      void this.panel.webview.postMessage(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Re-post the last terminal message if one exists. */
  repost(): void {
    if (this.lastTerminalMessage) {
      void this.panel.webview.postMessage(this.lastTerminalMessage);
    }
  }

  getTerminalMessage(): unknown | null {
    return this.lastTerminalMessage;
  }
}

// ---------------------------------------------------------------------------
// Internal panel record
// ---------------------------------------------------------------------------

/**
 * Associates an open panel with its resource path and the handles needed
 * for a retry (T-28).
 */
interface PanelRecord {
  panel: vscode.WebviewPanel;
  resourcePath: string;
  handle: ActiveConnectionHandle;
  adapter: StorageAdapter;
  /** Present for panels that use the WebviewReadyGate pattern. */
  gate?: WebviewReadyGate;
}

// ---------------------------------------------------------------------------
// WebviewPanelManager
// ---------------------------------------------------------------------------

export class WebviewPanelManager {
  /** One-panel-per-resource registry keyed by `panelType::resourcePath`. (AD-6) */
  private readonly registry = new Map<string, PanelRecord>();

  /**
   * Map from registry key → temp file path registered for that panel slot.
   * For metadata detail panels the value is always null (no temp file),
   * but the cleanup hook is wired per design.md §2.6 so future panel types
   * can register temp files without further scaffolding (T-15).
   */
  private readonly tempFiles = new Map<string, string | string[] | null>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storageAdapter: StorageAdapter,
    private readonly logger: ILogger,
    private readonly queryEngine?: QueryEngine,
    /** Optional callback to reveal a resource path in the tree view. */
    private readonly revealPath?: (resourcePath: string) => void | Promise<void>,
    /** Optional callback to retrieve saved connection configs. */
    private readonly getConnectionConfigs?: () => ConnectionConfig[],
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open (or reveal) the metadata detail panel for `resourcePath`.
   * Implements the one-panel-per-resource guard (FR-19, AD-6, T-16).
   */
  async openMetadataDetailPanel(
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter?: StorageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(resourcePath);
    }
    const effectiveAdapter = adapter ?? this.storageAdapter;
    const key = panelRegistryKey(PanelType.MetadataDetail, resourcePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(
        `Panel revealed (already open): type=metadataDetail resource=${resourcePath}`,
      );
      if (existing.gate?.getTerminalMessage()) {
        existing.gate.repost();
      } else if (existing.gate) {
        await this.loadMetadataPanel(existing.gate, resourcePath, handle, existing.adapter);
      }
      return;
    }

    // Create a new panel.
    const title = lastPathSegment(resourcePath);
    const panel = vscode.window.createWebviewPanel(
      PanelType.MetadataDetail,
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'metadataDetail');

    // Render the HTML shell immediately so the user sees a loading state.
    const nonce = generateNonce();
    panel.webview.html = getMetadataDetailHtml(nonce, panel.webview.cspSource);

    const record: PanelRecord = { panel, resourcePath, handle, adapter: effectiveAdapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(resourcePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMetadataWebviewMessage(msg, key, handle),
      undefined,
      this.context.subscriptions,
    );

    this.logger.info(
      `Panel opened: type=metadataDetail resource=${resourcePath}`,
    );

    await this.loadMetadataPanel(gate, resourcePath, handle, effectiveAdapter);
  }

  /**
   * Reveal an existing panel or call `createFn` to produce a new one.
   * Exposes the registry-guard as a reusable primitive for other panel types. (T-15)
   */
  revealOrCreate(
    panelType: PanelType,
    resourcePath: string,
    createFn: () => vscode.WebviewPanel,
  ): vscode.WebviewPanel {
    const key = panelRegistryKey(panelType, resourcePath);
    const existing = this.registry.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(
        `Panel revealed (already open): type=${panelType} resource=${resourcePath}`,
      );
      return existing.panel;
    }
    return createFn();
  }

  // ── Panel 1: Manifest List (FR-11) ─────────────────────────────────────────

  async openManifestListPanel(
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(resourcePath);
    }
    const key = panelRegistryKey(PanelType.ManifestList, resourcePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=manifestList resource=${resourcePath}`);
      if (existing.gate?.getTerminalMessage()) {
        existing.gate.repost();
      } else if (existing.gate) {
        void this.loadManifestListPanel(existing.gate, key, resourcePath, handle, adapter);
      }
      return;
    }

    const title = lastPathSegment(resourcePath);
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.ManifestList,
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'manifestList');

    const record: PanelRecord = { panel, resourcePath, handle, adapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(() => this.onPanelDispose(key), undefined, this.context.subscriptions);

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(resourcePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadManifestListPanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openManifestFile') {
          void this.openManifestFilePanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          void this._handleBreadcrumbNavigate(resourcePath, msg.segment, handle, adapter);
        }
      },
      undefined,
      this.context.subscriptions,
    );

    panel.webview.html = getManifestListHtml(nonce, panel.webview.cspSource, resourcePath);

    this.logger.info(`Panel opened: type=manifestList resource=${resourcePath}`);

    await this.loadManifestListPanel(gate, key, resourcePath, handle, adapter);
  }

  private async loadManifestListPanel(
    gate: WebviewReadyGate,
    key: string,
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    // Step 3: download to temp
    const fetchResult = await adapter.fetchFileToTemp(handle, resourcePath);
    if (isStorageError(fetchResult)) {
      const msg = ERROR_MESSAGES[fetchResult.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: fetchResult.class, message: msg });
      this.logger.error(`Panel error: type=manifestList resource=${resourcePath} errorClass=${fetchResult.class}`);
      return;
    }

    // Step 4: register temp file
    this.tempFiles.set(key, fetchResult);

    // Step 5: parse manifest list
    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: 'Query engine not available.' });
      void this.deleteTempFile(key, fetchResult);
      return;
    }

    const rows = await engine.parseManifestList(fetchResult);
    if (isQueryError(rows)) {
      void this.deleteTempFile(key, fetchResult);
      const msg = QUERY_ERROR_MESSAGES[rows.class] ?? QUERY_ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: rows.class, message: msg });
      this.logger.error(`Panel error: type=manifestList resource=${resourcePath} errorClass=${rows.class}`);
      return;
    }

    // Step 6: success — delete temp immediately and transition to loaded
    void this.deleteTempFile(key, fetchResult);
    gate.post({ type: 'loadManifestList', rows });
    this.logger.info(`Panel loaded: type=manifestList resource=${resourcePath} rows=${rows.length}`);
  }

  // ── Panel 2: Manifest File (FR-12) ─────────────────────────────────────────

  async openManifestFilePanel(
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(resourcePath);
    }
    const key = panelRegistryKey(PanelType.ManifestFile, resourcePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=manifestFile resource=${resourcePath}`);
      if (existing.gate?.getTerminalMessage()) {
        existing.gate.repost();
      } else if (existing.gate) {
        void this.loadManifestFilePanel(existing.gate, key, resourcePath, handle, adapter);
      }
      return;
    }

    const title = lastPathSegment(resourcePath);
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.ManifestFile,
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'manifestFile');

    const record: PanelRecord = { panel, resourcePath, handle, adapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(() => this.onPanelDispose(key), undefined, this.context.subscriptions);

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(resourcePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadManifestFilePanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openParquetPreview') {
          void this.openParquetPreviewPanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          void this._handleBreadcrumbNavigate(resourcePath, msg.segment, handle, adapter);
        }
      },
      undefined,
      this.context.subscriptions,
    );

    panel.webview.html = getManifestFileHtml(nonce, panel.webview.cspSource, resourcePath);

    this.logger.info(`Panel opened: type=manifestFile resource=${resourcePath}`);

    await this.loadManifestFilePanel(gate, key, resourcePath, handle, adapter);
  }

  private async loadManifestFilePanel(
    gate: WebviewReadyGate,
    key: string,
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    const fetchResult = await adapter.fetchFileToTemp(handle, resourcePath);
    if (isStorageError(fetchResult)) {
      const msg = ERROR_MESSAGES[fetchResult.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: fetchResult.class, message: msg });
      this.logger.error(`Panel error: type=manifestFile resource=${resourcePath} errorClass=${fetchResult.class}`);
      return;
    }

    this.tempFiles.set(key, fetchResult);

    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: 'Query engine not available.' });
      void this.deleteTempFile(key, fetchResult);
      return;
    }

    const rows = await engine.parseManifestFile(fetchResult);
    if (isQueryError(rows)) {
      void this.deleteTempFile(key, fetchResult);
      const msg = QUERY_ERROR_MESSAGES[rows.class] ?? QUERY_ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: rows.class, message: msg });
      this.logger.error(`Panel error: type=manifestFile resource=${resourcePath} errorClass=${rows.class}`);
      return;
    }

    void this.deleteTempFile(key, fetchResult);
    gate.post({ type: 'loadManifestFile', rows });
    this.logger.info(`Panel loaded: type=manifestFile resource=${resourcePath} rows=${rows.length}`);
  }

  // ── Panel 3: Parquet Preview (FR-13, NFR-3) ────────────────────────────────

  async openParquetPreviewPanel(
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(resourcePath);
    }
    const key = panelRegistryKey(PanelType.ParquetPreview, resourcePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=parquetPreview resource=${resourcePath}`);
      if (existing.gate?.getTerminalMessage()) {
        existing.gate.repost();
      } else if (existing.gate) {
        void this.loadParquetPreviewPanel(existing.gate, key, resourcePath, handle, adapter);
      }
      return;
    }

    const title = lastPathSegment(resourcePath);
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.ParquetPreview,
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'parquetPreview');

    const record: PanelRecord = { panel, resourcePath, handle, adapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(() => this.onPanelDispose(key), undefined, this.context.subscriptions);

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(resourcePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadParquetPreviewPanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openAdHocQuery') {
          void this.openAdHocQueryPanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          void this._handleBreadcrumbNavigate(resourcePath, msg.segment, handle, adapter);
        }
      },
      undefined,
      this.context.subscriptions,
    );

    panel.webview.html = getParquetPreviewHtml(nonce, panel.webview.cspSource, resourcePath);

    this.logger.info(`Panel opened: type=parquetPreview resource=${resourcePath}`);

    await this.loadParquetPreviewPanel(gate, key, resourcePath, handle, adapter);
  }

  private async loadParquetPreviewPanel(
    gate: WebviewReadyGate,
    key: string,
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    const fetchResult = await adapter.fetchFileToTemp(handle, resourcePath);
    if (isStorageError(fetchResult)) {
      const msg = ERROR_MESSAGES[fetchResult.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: fetchResult.class, message: msg });
      this.logger.error(`Panel error: type=parquetPreview resource=${resourcePath} errorClass=${fetchResult.class}`);
      return;
    }

    this.tempFiles.set(key, fetchResult);

    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: 'Query engine not available.' });
      void this.deleteTempFile(key, fetchResult);
      return;
    }

    try {
      const result = await engine.previewParquet(fetchResult);
      if (isQueryError(result)) {
        void this.deleteTempFile(key, fetchResult);
        const msg = QUERY_ERROR_MESSAGES[result.class] ?? QUERY_ERROR_MESSAGES['internal'];
        gate.post({ type: 'setState', state: 'error', errorClass: result.class, message: msg });
        this.logger.error(`Panel error: type=parquetPreview resource=${resourcePath} errorClass=${result.class}`);
        return;
      }

      void this.deleteTempFile(key, fetchResult);
      gate.post({ type: 'loadPreview', result });
      if (result.wasCapped) {
        gate.post({ type: 'showCapBanner', message: 'Showing first 100 rows.' });
      }
      this.logger.info(`Panel loaded: type=parquetPreview resource=${resourcePath} rows=${result.rowCount} capped=${result.wasCapped}`);
    } catch (err: unknown) {
      void this.deleteTempFile(key, fetchResult);
      const errMsg = err instanceof Error ? err.message : String(err);
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: `Failed to preview parquet file: ${errMsg}` });
      this.logger.error(`Panel error: type=parquetPreview resource=${resourcePath} errorClass=internal error=${errMsg}`);
    }
  }

  // ── Panel 4: Ad-hoc Query (FR-14–FR-17) ────────────────────────────────────

  async openAdHocQueryPanel(
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter = this.storageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(resourcePath);
    }
    const key = panelRegistryKey(PanelType.AdHocQuery, resourcePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=adHocQuery resource=${resourcePath}`);
      if (existing.gate?.getTerminalMessage()) {
        existing.gate.repost();
      }
      return;
    }

    const title = lastPathSegment(resourcePath);
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.AdHocQuery,
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    // Start in idle state
    const gate = new WebviewReadyGate(panel, this.logger, 'adHocQuery');

    const record: PanelRecord = { panel, resourcePath, handle, adapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(() => this.onPanelDispose(key), undefined, this.context.subscriptions);

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(resourcePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    let queryInFlight = false;

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'runQuery') {
          if (queryInFlight) { return; }
          queryInFlight = true;
          void (async () => {
            try {
              await this.executeAdHocQuery(gate, key, resourcePath, handle, adapter, msg.sql);
            } finally {
              queryInFlight = false;
            }
          })();
        } else if (msg.type === 'cancelQuery') {
          if (this.queryEngine) {
            this.queryEngine.cancelCurrentQuery();
          }
          // Delete any registered temp file
          const tempFile = this.tempFiles.get(key);
          if (tempFile) { void this.deleteTempFile(key, tempFile); }
          gate.post({ type: 'setState', state: 'idle' });
          this.logger.info(`Ad-hoc query cancelled: resource=${resourcePath}`);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          void this._handleBreadcrumbNavigate(resourcePath, msg.segment, handle, adapter);
        }
      },
      undefined,
      this.context.subscriptions,
    );

    panel.webview.html = getAdHocQueryHtml(nonce, panel.webview.cspSource, resourcePath);

    this.logger.info(`Panel opened: type=adHocQuery resource=${resourcePath}`);
  }

  private async executeAdHocQuery(
    gate: WebviewReadyGate,
    key: string,
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
    sql: string,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    // Delete any previously registered temp file for this panel slot
    const prevTemp = this.tempFiles.get(key);
    if (prevTemp) {
      void this.deleteTempFile(key, prevTemp);
    }

    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: 'Query engine not available.' });
      return;
    }

    // 1. Resolve Parquet file(s) to fetch
    let parquetPathsToFetch: string[];
    let tableName: string | undefined;
    let resolveDetails: ResolvedTableParquet | undefined;

    if (resourcePath.toLowerCase().endsWith('.parquet')) {
      parquetPathsToFetch = [resourcePath];
    } else {
      tableName = lastPathSegment(resourcePath).replace(/[^a-zA-Z0-9_]/g, '_');
      const resolveResult = await this.resolveTableParquetFiles(handle, resourcePath, adapter, sql);
      if (typeof resolveResult === 'string') {
        gate.post({
          type: 'setState',
          state: 'error',
          errorClass: 'not-found',
          message: resolveResult,
        });
        this.logger.error(`Panel error: type=adHocQuery resource=${resourcePath} error=${resolveResult}`);
        return;
      }
      parquetPathsToFetch = resolveResult.parquetPaths;
      if (resolveResult.tableName) {
        tableName = resolveResult.tableName;
      }
      resolveDetails = resolveResult;
    }

    // 2. Fetch Parquet files to temp in concurrent batches of 4
    const tempFilePaths: string[] = [];
    const BATCH_SIZE = 4;
    for (let i = 0; i < parquetPathsToFetch.length; i += BATCH_SIZE) {
      const batch = parquetPathsToFetch.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((p) => adapter.fetchFileToTemp(handle, p)),
      );
      for (let j = 0; j < batchResults.length; j++) {
        const fetchResult = batchResults[j];
        if (isStorageError(fetchResult)) {
          for (const t of tempFilePaths) {
            void adapter.deleteTemp(t);
          }
          const msg = ERROR_MESSAGES[fetchResult.class] ?? ERROR_MESSAGES['internal'];
          gate.post({ type: 'setState', state: 'error', errorClass: fetchResult.class, message: msg });
          this.logger.error(`Panel error: type=adHocQuery file=${batch[j]} errorClass=${fetchResult.class}`);
          return;
        }
        tempFilePaths.push(fetchResult);
      }
    }

    this.tempFiles.set(key, tempFilePaths);

    try {
      const result = await engine.runAdHocQuery(tempFilePaths, sql, tableName);
      void this.deleteTempFile(key, tempFilePaths);

      if (isQueryError(result)) {
        if (result.class === 'cancelled') {
          // cancelled → idle (design.md §2.3.2)
          gate.post({ type: 'setState', state: 'idle' });
          this.logger.info(`Ad-hoc query cancelled (engine): resource=${resourcePath}`);
        } else {
          const msg = result.message || (QUERY_ERROR_MESSAGES[result.class] ?? QUERY_ERROR_MESSAGES['internal']);
          gate.post({ type: 'setState', state: 'error', errorClass: result.class, message: msg });
          this.logger.error(`Panel error: type=adHocQuery resource=${resourcePath} errorClass=${result.class} error=${msg}`);
        }
        return;
      }

      gate.post({ type: 'loadQueryResult', result });
      if (result.wasCapped) {
        gate.post({ type: 'showCapBanner', message: 'Results capped at 10,000 rows.' });
      } else if (resolveDetails && resolveDetails.isSampled) {
        const sizeMb = (resolveDetails.accumulatedBytes / (1024 * 1024)).toFixed(1);
        const msg = resolveDetails.isSimpleScan && resolveDetails.requestedLimit
          ? `Read ${resolveDetails.parquetPaths.length} file(s) (${resolveDetails.accumulatedRecords.toLocaleString()} rows, ${sizeMb} MB) to satisfy LIMIT ${resolveDetails.requestedLimit}.`
          : `Query sampled ${resolveDetails.parquetPaths.length} of ${resolveDetails.totalDataFiles} data files (${resolveDetails.accumulatedRecords.toLocaleString()} rows, ${sizeMb} MB). Results capped at 10,000 rows.`;
        gate.post({ type: 'showCapBanner', message: msg });
      }
      this.logger.info(`Panel loaded: type=adHocQuery resource=${resourcePath} rows=${result.rowCount} capped=${result.wasCapped}`);
    } catch (err: unknown) {
      void this.deleteTempFile(key, tempFilePaths);
      const errMsg = err instanceof Error ? err.message : String(err);
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: `Failed to execute query: ${errMsg}` });
      this.logger.error(`Panel error: type=adHocQuery resource=${resourcePath} errorClass=internal error=${errMsg}`);
    }
  }

  /**
   * Resolves active Parquet data files for a table from its current metadata and manifests.
   * Uses SQL analysis, row-count targeting, and byte budgeting to prevent excessive S3 downloads.
   * If the path points to a namespace/database directory containing tables, it resolves
   * the child table automatically.
   */
  private async resolveTableParquetFiles(
    handle: ActiveConnectionHandle,
    tablePath: string,
    adapter: StorageAdapter,
    sql?: string,
  ): Promise<ResolvedTableParquet | string> {
    const engine = this.queryEngine;
    if (!engine) {
      return 'Query engine not available.';
    }

    // 1. Get metadata versions
    let effectivePath = tablePath;
    let versions = await adapter.listMetadataVersions(handle, effectivePath);
    if (isStorageError(versions)) {
      return `Could not list table metadata: ${versions.message}`;
    }
    if (versions.length === 0) {
      // Check if tablePath is a database/namespace directory containing tables
      const candidates = await adapter.listTables(handle, effectivePath);
      if (!isStorageError(candidates) && candidates.length > 0) {
        for (const cand of candidates) {
          if (await adapter.isTable(handle, cand)) {
            const candVersions = await adapter.listMetadataVersions(handle, cand);
            if (!isStorageError(candVersions) && candVersions.length > 0) {
              effectivePath = cand;
              versions = candVersions;
              this.logger.info(`Resolved child table ${cand} for directory ${tablePath}`);
              break;
            }
          }
        }
      }
    }
    if (versions.length === 0) {
      return `No metadata versions found for table at ${tablePath}. If this is a database or namespace, select a table inside it (e.g. ${tablePath}/<tableName>).`;
    }

    // Sort newest first
    const sorted = [...versions].sort((a, b) => b.sortKey - a.sortKey);
    const newest = sorted[0];

    // 2. Fetch metadata JSON
    const metaJson = await adapter.fetchMetadataJson(handle, newest.resourcePath);
    if (isStorageError(metaJson)) {
      return `Could not read table metadata: ${metaJson.message}`;
    }

    // 3. Find current snapshot
    const metaObj = metaJson as Record<string, unknown>;
    const currentSnapshotId = metaObj['current-snapshot-id'];
    const snapshots = (metaObj.snapshots ?? []) as Array<Record<string, unknown>>;
    const snapshot = snapshots.find(s => s['snapshot-id'] === currentSnapshotId) ?? snapshots[snapshots.length - 1];

    if (!snapshot || !snapshot['manifest-list']) {
      return 'Table has no active snapshots or manifest list.';
    }

    // 4. Fetch manifest list Avro to temp
    const manifestListPath = String(snapshot['manifest-list']);
    const listTemp = await adapter.fetchFileToTemp(handle, manifestListPath);
    if (isStorageError(listTemp)) {
      return `Could not fetch manifest list (${manifestListPath}): ${listTemp.message}`;
    }

    let manifestEntries: ManifestEntryRow[];
    try {
      const parsed = await engine.parseManifestList(listTemp);
      if (isQueryError(parsed)) {
        return `Could not parse manifest list: ${parsed.message}`;
      }
      manifestEntries = parsed;
    } finally {
      void adapter.deleteTemp(listTemp);
    }

    // 5. Filter for data manifests (content === 0 or undefined)
    const dataManifests = manifestEntries.filter(m => m.content === 0 || m.content == null);
    if (dataManifests.length === 0) {
      return `No data manifests found in snapshot ${snapshot['snapshot-id']}.`;
    }

    // 6. Parse manifests to collect active Parquet data files with budgeting
    const analysis = sql ? analyzeQuery(sql) : { isSimpleScan: true, hasFilterOrTransform: false, requestedLimit: 100 };
    const MAX_BYTES_BUDGET = 50 * 1024 * 1024; // 50 MB
    const MAX_FILES_CEILING = 25;
    const SINGLE_FILE_LIMIT = 50 * 1024 * 1024;
    const targetRecords = analysis.isSimpleScan
      ? (analysis.requestedLimit ?? 10_000)
      : Math.min(Math.max((analysis.requestedLimit ?? 10_000) * 5, 20_000), 100_000);

    let estimatedTotalDataFiles = 0;
    for (const dm of dataManifests) {
      const count = ((dm as any).addedDataFilesCount ?? (dm as any).addedFilesCount ?? 0) +
                    ((dm as any).existingDataFilesCount ?? (dm as any).existingFilesCount ?? 0);
      estimatedTotalDataFiles += count;
    }

    interface CandidateFile {
      filePath: string;
      recordCount: number;
      fileSizeBytes: number;
    }
    const candidateFiles: CandidateFile[] = [];
    let parsedActiveFilesCount = 0;

    for (const dm of dataManifests) {
      const manifestTemp = await adapter.fetchFileToTemp(handle, dm.manifestPath);
      if (isStorageError(manifestTemp)) {
        continue;
      }
      try {
        const parsed = await engine.parseManifestFile(manifestTemp);
        if (!isQueryError(parsed)) {
          for (const df of parsed) {
            // status: 0 = EXISTING, 1 = ADDED, 2 = DELETED
            if (df.filePath.toLowerCase().endsWith('.parquet') && df.status !== 2) {
              parsedActiveFilesCount++;
              candidateFiles.push({
                filePath: df.filePath,
                recordCount: df.recordCount ?? 0,
                fileSizeBytes: df.fileSizeBytes ?? 0,
              });
            }
          }
        }
      } finally {
        void adapter.deleteTemp(manifestTemp);
      }

      // Early stop if candidates already meet target records
      const totalCandidateRecords = candidateFiles.reduce((sum, f) => sum + f.recordCount, 0);
      if (totalCandidateRecords >= targetRecords && candidateFiles.length >= 1) {
        break;
      }
    }

    if (candidateFiles.length === 0) {
      return 'No active Parquet data files found for table.';
    }

    // For simple scans, sort candidate files by size ascending (smallest files first)
    // to minimize download bandwidth and avoid fetching large compaction files.
    const pool = [...candidateFiles];
    if (analysis.isSimpleScan) {
      pool.sort((a, b) => a.fileSizeBytes - b.fileSizeBytes);
    }

    const selectedFiles: CandidateFile[] = [];
    let accumulatedRecords = 0;
    let accumulatedBytes = 0;

    for (const file of pool) {
      // If a single file exceeds 50MB and we already have alternative selected files, skip it
      if (file.fileSizeBytes > SINGLE_FILE_LIMIT && selectedFiles.length > 0) {
        continue;
      }

      selectedFiles.push(file);
      accumulatedRecords += file.recordCount;
      accumulatedBytes += file.fileSizeBytes;

      if (
        (accumulatedRecords >= targetRecords && selectedFiles.length >= 1) ||
        accumulatedBytes >= MAX_BYTES_BUDGET ||
        selectedFiles.length >= MAX_FILES_CEILING
      ) {
        break;
      }
    }

    const totalCount = Math.max(estimatedTotalDataFiles, parsedActiveFilesCount, candidateFiles.length);
    const isSampled = selectedFiles.length < totalCount;

    return {
      parquetPaths: selectedFiles.map(f => f.filePath),
      tableName: lastPathSegment(effectivePath).replace(/[^a-zA-Z0-9_]/g, '_'),
      totalDataFiles: totalCount,
      accumulatedRecords,
      accumulatedBytes,
      isSampled,
      requestedLimit: analysis.requestedLimit,
      isSimpleScan: analysis.isSimpleScan,
    };
  }

  /**
   * Open (or reveal) the settings panel singleton. (FR-1, AC-1, FR-2, FR-3, FR-4, FR-5, FR-6c)
   *
   * The panel is keyed as settings::settings so at most one is ever open.
   * Callbacks are injected by extension.ts so this class stays independent
   * of the Connection Manager (architecture.md §4).
   */
  async openSettingsPanel(
    editConfig:         ConnectionConfig | undefined,
    saveConnection:     (config: ConnectionConfig, creds: { accessKey: string; secretKey: string }) => Promise<void>,
    activateConnection: (id: string) => Promise<ActiveConnectionHandle | StorageError>,
    deleteConnection:   (id: string) => Promise<void>,
    getExistingConfigs?: () => ConnectionConfig[],
    hasCredential?:     (id: string) => Promise<boolean>,
  ): Promise<void> {
    const key = panelRegistryKey(PanelType.Settings, 'settings');
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info('Panel revealed (already open): type=settings resource=settings');
      if (getExistingConfigs) {
        const currentConns = getExistingConfigs().map((c) => ({ id: c.id, label: c.label }));
        void existing.panel.webview.postMessage({
          type: 'setExistingConnections',
          connections: currentConns,
        });
      }
      // If an editConfig was provided, post the editConnection message to pre-fill
      if (editConfig) {
        const hasSavedCredentials = (editConfig.connectionType === 's3' || (editConfig.connectionType === 'gcs' && editConfig.gcsAuthType === 'serviceAccountKey')) && (hasCredential ? await hasCredential(editConfig.id) : true);
        void existing.panel.webview.postMessage({
          type: 'editConnection',
          config: {
            id: editConfig.id,
            label: editConfig.label,
            connectionType: editConfig.connectionType,
            warehousePath: editConfig.warehousePath,
            endpointUrl: editConfig.endpointUrl,
            region: editConfig.region,
            sslVerification: editConfig.sslVerification,
            gcsAuthType: editConfig.gcsAuthType,
            projectId: editConfig.projectId,
          },
          hasSavedCredentials,
        });
      }
      return;
    }

    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.Settings,
      'Iceberg Explorer — Settings',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    const initialConns = getExistingConfigs ? getExistingConfigs().map((c) => ({ id: c.id, label: c.label })) : [];
    panel.webview.html = getSettingsHtml(nonce, panel.webview.cspSource, initialConns);

    // Cast to PanelRecord — settings panels carry no resourcePath or handle;
    // use sentinel values to satisfy the interface without widening the type.
    const record: PanelRecord = {
      panel,
      resourcePath: 'settings',
      handle: { connectionType: 'local', warehousePath: '' },
      adapter: this.storageAdapter,
    };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    panel.webview.onDidReceiveMessage(
      async (msg: { type: string; [k: string]: unknown }) => {
        if (!msg?.type) { return; }

        switch (msg.type) {
          case 'saveConnection': {
            // NFR-7: never log credential values (design.md §2.8.3)
            this.logger.info(`Settings panel: saveConnection type=${String(msg.connectionType)}`);
            // If msg.id is provided the user is editing an existing connection;
            // otherwise generate a new id.
            const endpointUrlStr = msg.endpointUrl !== undefined ? String(msg.endpointUrl).trim() : undefined;
            const config: ConnectionConfig = {
              id: msg.id ? String(msg.id) : `conn-${Date.now()}`,
              label:          String(msg.label ?? '').trim(),
              connectionType: (msg.connectionType as 'local' | 's3' | 'gcs'),
              warehousePath:  String(msg.warehousePath ?? '').trim(),
              endpointUrl:    endpointUrlStr && endpointUrlStr !== '' ? endpointUrlStr : undefined,
              region:         msg.region      !== undefined ? String(msg.region).trim()      : undefined,
              sslVerification: Boolean(msg.sslVerification ?? true),
              savedAt: Date.now(),
              gcsAuthType:    msg.gcsAuthType !== undefined ? (String(msg.gcsAuthType) as 'adc' | 'serviceAccountKey') : undefined,
              projectId:      msg.projectId   !== undefined ? String(msg.projectId).trim() || undefined : undefined,
            };
            const creds = {
              accessKey: String(msg.accessKey ?? '').trim(),
              secretKey: String(msg.secretKey ?? '').trim(),
            };
            try {
              await saveConnection(config, creds);
              const currentConns = getExistingConfigs ? getExistingConfigs().map((c) => ({ id: c.id, label: c.label })) : undefined;
              void panel.webview.postMessage({ type: 'saveSuccess', connections: currentConns });
            } catch (err: unknown) {
              const message = isStorageError(err)
                ? err.message
                : (err instanceof Error ? err.message : 'Failed to save connection.');
              void panel.webview.postMessage({ type: 'saveError', message });
            }
            break;
          }

          case 'activateConnection': {
            // NFR-7: do not log the id (design.md §2.8.3)
            this.logger.info('Settings panel: activateConnection');
            const result = await activateConnection(String(msg.id ?? ''));
            if (isStorageError(result)) {
              void panel.webview.postMessage({ type: 'activateError', message: result.message });
            } else {
              void panel.webview.postMessage({ type: 'activateSuccess' });
            }
            break;
          }

          case 'deleteConnection': {
            this.logger.info('Settings panel: deleteConnection');
            try {
              const idToDelete = String(msg.id ?? '');
              await deleteConnection(idToDelete);
              void panel.webview.postMessage({ type: 'deleteSuccess', id: idToDelete });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Failed to delete connection.';
              void panel.webview.postMessage({ type: 'deleteError', message });
            }
            break;
          }

          case 'browseKeyFile': {
            try {
              const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'JSON Files': ['json'] },
                title: 'Select Google Cloud Service Account Key File',
              });
              if (uris && uris[0]) {
                void panel.webview.postMessage({
                  type: 'keyFileSelected',
                  filePath: uris[0].fsPath,
                });
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.error(`Settings panel: browseKeyFile failed: ${message}`);
            }
            break;
          }
        }
      },
      undefined,
      this.context.subscriptions,
    );

    // If an editConfig was provided, post the editConnection message to pre-fill the form.
    if (editConfig) {
      const hasSavedCredentials = (editConfig.connectionType === 's3' || (editConfig.connectionType === 'gcs' && editConfig.gcsAuthType === 'serviceAccountKey')) && (hasCredential ? await hasCredential(editConfig.id) : true);
      void panel.webview.postMessage({
        type: 'editConnection',
        config: {
          id: editConfig.id,
          label: editConfig.label,
          connectionType: editConfig.connectionType,
          warehousePath: editConfig.warehousePath,
          endpointUrl: editConfig.endpointUrl,
          region: editConfig.region,
          sslVerification: editConfig.sslVerification,
          gcsAuthType: editConfig.gcsAuthType,
          projectId: editConfig.projectId,
        },
        hasSavedCredentials,
      });
    }

    this.logger.info('Panel opened: type=settings resource=settings');
  }

  // ── Internal methods ────────────────────────────────────────────────────────

  /**
   * Fetch the metadata JSON via the Storage Layer and drive the webview
   * through loading → loaded | error states. (T-17)
   *
   * Uses WebviewReadyGate so messages are not dropped if the Storage Layer
   * responds before the webview JS listener has registered (MEDIUM-1).
   */
  async loadMetadataPanel(
    target: WebviewReadyGate | vscode.WebviewPanel | { post: (msg: unknown) => void },
    resourcePath: string,
    handle: ActiveConnectionHandle,
    adapter?: StorageAdapter,
  ): Promise<void> {
    const post = (msg: unknown) => {
      if ('post' in target && typeof target.post === 'function') {
        target.post(msg);
      } else if ('webview' in target && target.webview && typeof target.webview.postMessage === 'function') {
        void target.webview.postMessage(msg);
      }
    };

    post({ type: 'setState', state: 'loading' });

    const result = await (adapter ?? this.storageAdapter).fetchMetadataJson(handle, resourcePath);

    if (isStorageError(result)) {
      const errorClass = result.class;
      const message = ERROR_MESSAGES[errorClass] ?? ERROR_MESSAGES['internal'];
      post({
        type: 'setState',
        state: 'error',
        errorClass,
        message,
      });
      // Log — no raw exception text, no credential values (design.md §2.8.2, §2.8.3)
      this.logger.error(
        `Panel error: type=metadataDetail resource=${resourcePath} errorClass=${errorClass} message=${message}`,
      );
      return;
    }

    post({
      type: 'loadMetadata',
      payload: result,
      resourcePath,
    });
  }

  /**
   * Handle messages posted from the metadata detail webview script to the extension host.
   * (T-27 breadcrumb stub, T-28 retry, T-23 openManifestList)
   */
  private handleMetadataWebviewMessage(
    msg: WebviewMessage,
    key: string,
    handle: ActiveConnectionHandle,
  ): void {
    if (!msg?.type) { return; }

    const record = this.registry.get(key);

    // Forward webviewReady through the gate so queued messages are flushed.
    if (record?.gate?.onHostMessage(msg)) { return; }

    switch (msg.type) {
      case 'retry': {
        if (record?.gate) {
          void this.loadMetadataPanel(record.gate, record.resourcePath, record.handle, record.adapter);
        }
        break;
      }
      case 'breadcrumbNavigate': {
        const record = this.registry.get(key);
        const rp = record?.resourcePath ?? '';
        this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${rp}`);
        if (rp && record) { void this._handleBreadcrumbNavigate(rp, msg.segment, record.handle, record.adapter); }
        break;
      }
      case 'openManifestList': {
        // Step 0: replace T-23 stub — wire to real openManifestListPanel (T-31)
        // Use the adapter stored in the parent record, not this.storageAdapter (which is
        // only a placeholder localFsAdapter at construction time).
        const record = this.registry.get(key);
        const adapter = record?.adapter ?? this.storageAdapter;
        void this.openManifestListPanel(msg.resourcePath, handle, adapter);
        break;
      }
    }
  }

  /**
   * Called when a panel fires `onDidDispose`.
   * Removes the panel from the registry and cleans up any registered temp file.
   * (T-15, design.md §2.6)
   */
  private onPanelDispose(key: string): void {
    const tempFile = this.tempFiles.get(key);
    const record = this.registry.get(key);
    this.registry.delete(key);
    this.tempFiles.delete(key);

    if (tempFile) {
      const adapter = record?.adapter ?? this.storageAdapter;
      const files = Array.isArray(tempFile) ? tempFile : [tempFile];
      for (const f of files) {
        void adapter.deleteTemp(f).then(() => {
          this.logger.info(`Temp file deleted: ${f}`);
        }).catch(() => {
          this.logger.warn(`Temp file deletion failed (already absent): ${f}`);
        });
      }
    }
  }

  private _getConnectionConfig(handle?: ActiveConnectionHandle, targetPath?: string): ConnectionConfig | undefined {
    let config: ConnectionConfig | undefined;
    if (this.getConnectionConfigs) {
      const configs = this.getConnectionConfigs();
      const norm = (p: string | undefined) => (p ? p.replace(/\\/g, '/').replace(/\/$/, '') : '');
      const handleNorm = handle ? norm(handle.warehousePath) : '';
      const targetNorm = targetPath ? norm(targetPath) : '';
      config = (handleNorm ? configs.find((c) => norm(c.warehousePath) === handleNorm) : undefined)
        || (targetNorm ? configs.find((c) => norm(c.warehousePath) === targetNorm || targetNorm.startsWith(norm(c.warehousePath) + '/') || norm(c.warehousePath).startsWith(targetNorm + '/')) : undefined)
        || configs[0];
    }
    if (!config && handle) {
      const wp = handle.warehousePath || targetPath || 'warehouse';
      config = {
        id: wp,
        label: lastPathSegment(wp) || 'Warehouse',
        connectionType: handle.connectionType || 'local',
        warehousePath: wp,
        sslVerification: true,
        savedAt: Date.now(),
      };
    }
    return config;
  }

  /**
   * Resolve the clicked breadcrumb segment to a resource path, reveal the tree node,
   * and navigate the webview to the corresponding overview/table panel.
   */
  private async _handleBreadcrumbNavigate(
    resourcePath: string,
    segmentIndex: number,
    handle?: ActiveConnectionHandle,
    adapter?: StorageAdapter,
  ): Promise<void> {
    const effectiveAdapter = adapter ?? this.storageAdapter;
    const breadcrumbs = resourcePathToBreadcrumbs(resourcePath);
    // Last segment is the file itself (never clickable); guard anyway.
    if (segmentIndex >= breadcrumbs.length - 1) { return; }

    // Normalise Hadoop variants and split into real path components.
    const normalised = resourcePath.replace(/\\/g, '/').replace(/^s3[an]:\/\//, 's3://').replace(/^gcs:\/\//, 'gs://');
    const isS3 = normalised.startsWith('s3://');
    const isGcs = normalised.startsWith('gs://');

    let parts: string[];
    if (isS3) {
      parts = normalised.slice('s3://'.length).split('/').filter(Boolean);
    } else if (isGcs) {
      parts = normalised.slice('gs://'.length).split('/').filter(Boolean);
    } else {
      parts = normalised.split('/').filter(Boolean);
    }

    const metaIdx = parts.lastIndexOf('metadata');
    const folderIdx = metaIdx >= 0 ? metaIdx : parts.lastIndexOf('data');
    const n = breadcrumbs.length;

    let endPartIndex: number;

    if (folderIdx >= 0 && n === 4) {
      // Standard metadata/data path pattern — mirror resourcePathToBreadcrumbs exactly.
      if (segmentIndex === 0) {
        endPartIndex = folderIdx - 3;         // last part of root prefix
      } else if (segmentIndex === 1) {
        endPartIndex = folderIdx - 2;         // schema
      } else {
        endPartIndex = folderIdx - 1;         // table (segmentIndex === 2)
      }
    } else {
      // Fallback / data-path / table-path pattern: root absorbs leading parts,
      // all other segments map 1:1.
      const rootPartCount = parts.length - (n - 1);
      if (segmentIndex === 0) {
        endPartIndex = rootPartCount - 1;
      } else {
        endPartIndex = rootPartCount + segmentIndex - 1;
      }
    }

    if (endPartIndex < 0 || endPartIndex >= parts.length) { return; }

    const targetParts = parts.slice(0, endPartIndex + 1);
    const targetPath = isS3
      ? 's3://' + targetParts.join('/')
      : isGcs
      ? 'gs://' + targetParts.join('/')
      : '/' + targetParts.join('/');

    this.logger.info(`Breadcrumb navigate → resolved path: ${targetPath}`);
    if (this.revealPath) {
      void this.revealPath(targetPath);
    }

    if (segmentIndex === 0) {
      // Top-most overview page (bucket name / warehouse root)
      const config = this._getConnectionConfig(handle, targetPath);
      if (config && handle) {
        await this.openConnectionDashboardPanel(config, handle, effectiveAdapter, '');
      } else {
        void vscode.commands.executeCommand('icebergExplorer.openConnectionDashboard', undefined, '');
      }
    } else if (folderIdx >= 0 && n === 4 && segmentIndex === 2) {
      // Table segment clicked from a child metadata/data panel
      if (handle) {
        await this.openTableOverviewPanel(targetPath, handle, effectiveAdapter);
      } else {
        void vscode.commands.executeCommand('icebergExplorer.openTableOverview', targetPath);
      }
    } else if (segmentIndex === 1) {
      // Schema container segment
      const schemaName = breadcrumbs[1];
      if (handle) {
        await this.openSchemaOverviewPanel(targetPath, handle, effectiveAdapter, schemaName);
      } else {
        void vscode.commands.executeCommand('icebergExplorer.openSchemaOverview', targetPath, schemaName);
      }
    } else {
      // Fallback: check if target is a table
      let isTab = false;
      if (handle) {
        try {
          const res = await effectiveAdapter.isTable(handle, targetPath);
          isTab = res === true;
        } catch {
          isTab = false;
        }
      }
      if (isTab && handle) {
        await this.openTableOverviewPanel(targetPath, handle, effectiveAdapter);
      } else {
        const segName = breadcrumbs[segmentIndex];
        const config = this._getConnectionConfig(handle, targetPath);
        if (config && handle) {
          await this.openConnectionDashboardPanel(config, handle, effectiveAdapter, segName);
        }
      }
    }
  }

  /**
   * Open or reveal the Table Overview panel for a table. (Phase 1 & 3)
   */
  async openTableOverviewPanel(
    tablePath: string,
    handle: ActiveConnectionHandle,
    adapter?: StorageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(tablePath);
    }
    const effectiveAdapter = adapter ?? this.storageAdapter;
    const key = panelRegistryKey(PanelType.TableOverview, tablePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=tableOverview resource=${tablePath}`);
      if (existing.gate) {
        existing.gate.repost();
      }
      return;
    }

    const title = lastPathSegment(tablePath);
    const panel = vscode.window.createWebviewPanel(
      PanelType.TableOverview,
      `${title} — Overview`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'tableOverview');
    const nonce = generateNonce();
    panel.webview.html = getTableOverviewHtml(nonce, panel.webview.cspSource, tablePath);

    const record: PanelRecord = { panel, resourcePath: tablePath, handle, adapter: effectiveAdapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(tablePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        if (!msg?.type) { return; }
        if (gate.onHostMessage(msg)) { return; }

        switch (msg.type) {
          case 'retry':
            void this.loadTableOverview(gate, tablePath, handle, effectiveAdapter);
            break;
          case 'breadcrumbNavigate':
            void this._handleBreadcrumbNavigate(tablePath, msg.segment, handle, effectiveAdapter);
            break;
          case 'openAdHocQuery':
            void this.openAdHocQueryPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'openMetadataPanel':
            void this.openMetadataDetailPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'openMetadataArchitecture':
            void this.openMetadataArchitecturePanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'fetchDataPreview':
            void this.loadDataPreview(gate, msg.tablePath, handle, effectiveAdapter);
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.logger.info(`Panel opened: type=tableOverview resource=${tablePath}`);
    await this.loadTableOverview(gate, tablePath, handle, effectiveAdapter);
  }

  /**
   * Open or reveal the Connection Dashboard panel. (Phase 2)
   */
  async openConnectionDashboardPanel(
    config: ConnectionConfig,
    handle: ActiveConnectionHandle,
    adapter?: StorageAdapter,
    initialFilter?: string,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(config.warehousePath || config.id);
    }
    const effectiveAdapter = adapter ?? this.storageAdapter;
    const key = panelRegistryKey(PanelType.ConnectionDashboard, config.id);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=connectionDashboard resource=${config.id}`);
      if (initialFilter !== undefined && existing.gate) {
        existing.gate.post({ type: 'setFilter', filter: initialFilter });
      } else if (existing.gate) {
        existing.gate.repost();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PanelType.ConnectionDashboard,
      `${config.label} — Dashboard`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'connectionDashboard');
    const nonce = generateNonce();
    panel.webview.html = getConnectionDashboardHtml(nonce, panel.webview.cspSource);

    const record: PanelRecord = { panel, resourcePath: config.id, handle, adapter: effectiveAdapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(config.warehousePath || config.id);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage | { type: 'editConnection'; connectionId?: string }) => {
        if (!msg?.type) { return; }
        if (gate.onHostMessage(msg)) { return; }

        switch (msg.type) {
          case 'retry':
            void this.loadConnectionDashboard(gate, config, handle, effectiveAdapter, initialFilter);
            break;
          case 'openAdHocQuery':
            void this.openAdHocQueryPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'openTableOverview':
            void this.openTableOverviewPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'openSchemaOverview':
            void this.openSchemaOverviewPanel(msg.schemaPath, handle, effectiveAdapter, msg.schemaName);
            break;
          case 'editConnection':
            void vscode.commands.executeCommand('icebergExplorer.openSettings', config.id);
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.logger.info(`Panel opened: type=connectionDashboard resource=${config.id}`);
    await this.loadConnectionDashboard(gate, config, handle, effectiveAdapter, initialFilter);
  }

  /**
   * Open or reveal the Schema Overview panel.
   */
  async openSchemaOverviewPanel(
    schemaPath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
    schemaName?: string,
  ): Promise<vscode.WebviewPanel> {
    if (this.revealPath) {
      void this.revealPath(schemaPath);
    }
    const key = panelRegistryKey(PanelType.SchemaOverview, schemaPath);
    const existing = this.registry.get(key);
    if (existing) {
      this.logger.info(`Panel revealed (already open): type=schemaOverview resource=${schemaPath}`);
      existing.panel.reveal();
      return existing.panel;
    }

    const displayName = schemaName ?? lastPathSegment(schemaPath);
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      PanelType.SchemaOverview,
      `${displayName} — Schema`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
    );

    const effectiveAdapter = adapter ?? this.storageAdapter;
    const gate = new WebviewReadyGate(panel, this.logger, 'schemaOverview');
    panel.webview.html = getSchemaOverviewHtml(nonce, panel.webview.cspSource, schemaPath);

    const record: PanelRecord = { panel, resourcePath: schemaPath, handle, adapter: effectiveAdapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(schemaPath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        if (!msg?.type) { return; }
        if (gate.onHostMessage(msg)) { return; }

        switch (msg.type) {
          case 'retry':
            void this.loadSchemaOverview(gate, schemaPath, handle, effectiveAdapter, schemaName);
            break;
          case 'breadcrumbNavigate':
            void this._handleBreadcrumbNavigate(schemaPath, msg.segment, handle, effectiveAdapter);
            break;
          case 'openConnectionDashboard': {
            const config = this._getConnectionConfig(handle, schemaPath);
            if (config) {
              void this.openConnectionDashboardPanel(config, handle, effectiveAdapter);
            }
            break;
          }
          case 'openTableOverview':
            void this.openTableOverviewPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'openAdHocQuery':
            void this.openAdHocQueryPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.logger.info(`Panel opened: type=schemaOverview resource=${schemaPath}`);
    await this.loadSchemaOverview(gate, schemaPath, handle, effectiveAdapter, schemaName);
    return panel;
  }

  /**
   * Open or reveal the Metadata Architecture DAG panel. (Phase 4)
   */
  async openMetadataArchitecturePanel(
    tablePath: string,
    handle: ActiveConnectionHandle,
    adapter?: StorageAdapter,
  ): Promise<void> {
    if (this.revealPath) {
      void this.revealPath(tablePath);
    }
    const effectiveAdapter = adapter ?? this.storageAdapter;
    const key = panelRegistryKey(PanelType.MetadataArchitecture, tablePath);
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info(`Panel revealed (already open): type=metadataArchitecture resource=${tablePath}`);
      if (existing.gate) {
        existing.gate.repost();
      }
      return;
    }

    const title = lastPathSegment(tablePath);
    const panel = vscode.window.createWebviewPanel(
      PanelType.MetadataArchitecture,
      `${title} — Architecture DAG`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const gate = new WebviewReadyGate(panel, this.logger, 'metadataArchitecture');
    const nonce = generateNonce();
    panel.webview.html = getMetadataArchitectureHtml(nonce, panel.webview.cspSource, tablePath);

    const record: PanelRecord = { panel, resourcePath: tablePath, handle, adapter: effectiveAdapter, gate };
    this.registry.set(key, record);
    this.tempFiles.set(key, null);

    panel.onDidDispose(
      () => this.onPanelDispose(key),
      undefined,
      this.context.subscriptions,
    );

    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(
        (e) => {
          if (e.webviewPanel.active && this.revealPath) {
            void this.revealPath(tablePath);
          }
        },
        undefined,
        this.context.subscriptions,
      );
    }

    panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        if (!msg?.type) { return; }
        if (gate.onHostMessage(msg)) { return; }

        switch (msg.type) {
          case 'retry':
            void this.loadMetadataArchitecture(gate, tablePath, handle, effectiveAdapter);
            break;
          case 'breadcrumbNavigate':
            void this._handleBreadcrumbNavigate(tablePath, msg.segment, handle, effectiveAdapter);
            break;
          case 'openTableOverview':
            void this.openTableOverviewPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
          case 'selectArchitectureSnapshot':
            void this.loadMetadataArchitecture(gate, msg.tablePath, handle, effectiveAdapter, msg.snapshotId);
            break;
          case 'fetchManifestDataFiles':
            void this.loadManifestDataFiles(gate, msg.manifestPath, handle, effectiveAdapter);
            break;
          case 'openParquetPreview':
            void this.openParquetPreviewPanel(msg.resourcePath, handle, effectiveAdapter);
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.logger.info(`Panel opened: type=metadataArchitecture resource=${tablePath}`);
    await this.loadMetadataArchitecture(gate, tablePath, handle, effectiveAdapter);
  }

  // ── Helper loading methods ──────────────────────────────────────────────────

  private async loadTableOverview(
    gate: WebviewReadyGate,
    tablePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    let effectiveTablePath = tablePath;
    let versions = await adapter.listMetadataVersions(handle, effectiveTablePath);
    if (isStorageError(versions)) {
      const msg = ERROR_MESSAGES[versions.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: versions.class, message: msg });
      return;
    }
    if (versions.length === 0) {
      // Check if tablePath is a database/namespace directory containing tables
      const candidates = await adapter.listTables(handle, effectiveTablePath);
      if (!isStorageError(candidates) && candidates.length > 0) {
        for (const cand of candidates) {
          if (await adapter.isTable(handle, cand)) {
            const candVersions = await adapter.listMetadataVersions(handle, cand);
            if (!isStorageError(candVersions) && candVersions.length > 0) {
              effectiveTablePath = cand;
              versions = candVersions;
              this.logger.info(`Resolved child table ${cand} for directory ${tablePath}`);
              break;
            }
          }
        }
      }
    }
    if (versions.length === 0) {
      gate.post({
        type: 'setState',
        state: 'error',
        errorClass: 'not-found',
        message: `No metadata versions found for table at ${tablePath}. If this is a database or namespace, select a table inside it (e.g. ${tablePath}/<tableName>).`,
      });
      return;
    }

    const latest = versions[0];
    const raw = await adapter.fetchMetadataJson(handle, latest.resourcePath);
    if (isStorageError(raw)) {
      const msg = ERROR_MESSAGES[raw.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: raw.class, message: msg });
      return;
    }

    const meta = raw as Record<string, any>;
    const formatVersion = Number(meta['format-version'] ?? 1);
    const tableUuid = String(meta['table-uuid'] ?? '');
    const location = String(meta['location'] ?? tablePath);
    const currentSnapshotId = meta['current-snapshot-id'] !== undefined ? String(meta['current-snapshot-id']) : null;
    const lastUpdatedMs = meta['last-updated-ms'] ? Number(meta['last-updated-ms']) : null;
    const properties: Record<string, string> = meta['properties'] ?? {};

    // Columns
    const currentSchemaId = meta['current-schema-id'];
    const schemas = Array.isArray(meta['schemas']) ? meta['schemas'] : [];
    const currentSchema = schemas.find((s: any) => s['schema-id'] === currentSchemaId) ?? meta['schema'] ?? schemas[0];
    const fields = Array.isArray(currentSchema?.fields) ? currentSchema.fields : [];
    const columns: TableColumnSummary[] = fields.map((f: any) => ({
      id: Number(f.id ?? 0),
      name: String(f.name ?? ''),
      type: typeof f.type === 'string' ? f.type : JSON.stringify(f.type),
      required: Boolean(f.required),
      doc: f.doc ? String(f.doc) : undefined,
    }));

    // Partition Spec
    const defaultSpecId = meta['default-spec-id'];
    const specs = Array.isArray(meta['partition-specs']) ? meta['partition-specs'] : [];
    const defaultSpec = specs.find((s: any) => s['spec-id'] === defaultSpecId) ?? specs[0];
    const partitionFields = Array.isArray(defaultSpec?.fields) ? defaultSpec.fields : [];
    const partitionSpec: TablePartitionField[] = partitionFields.map((p: any) => ({
      sourceId: Number(p['source-id'] ?? 0),
      fieldId: Number(p['field-id'] ?? 0),
      name: String(p.name ?? ''),
      transform: String(p.transform ?? 'identity'),
    }));

    // Snapshots
    const rawSnaps = Array.isArray(meta['snapshots']) ? meta['snapshots'] : [];
    const snapshots: SnapshotSummaryItem[] = rawSnaps
      .slice()
      .sort((a: any, b: any) => Number(b['timestamp-ms'] ?? 0) - Number(a['timestamp-ms'] ?? 0))
      .map((s: any) => ({
        snapshotId: String(s['snapshot-id']),
        parentSnapshotId: s['parent-snapshot-id'] ? String(s['parent-snapshot-id']) : null,
        timestampMs: Number(s['timestamp-ms'] ?? 0),
        operation: String(s.summary?.operation ?? 'commit'),
        addedRecords: s.summary?.['added-records'] ? String(s.summary['added-records']) : undefined,
        deletedRecords: s.summary?.['deleted-records'] ? String(s.summary['deleted-records']) : undefined,
        addedFiles: s.summary?.['added-data-files'] ? String(s.summary['added-data-files']) : undefined,
        manifestList: s['manifest-list'] ? String(s['manifest-list']) : undefined,
      }));

    gate.post({
      type: 'loadTableOverview',
      tablePath,
      tableName: lastPathSegment(tablePath),
      formatVersion,
      tableUuid,
      location,
      currentSnapshotId,
      lastUpdatedMs,
      columns,
      partitionSpec,
      snapshotsCount: snapshots.length,
      properties,
      latestMetadataPath: latest.resourcePath,
      snapshots,
    });
  }

  private async loadDataPreview(
    gate: WebviewReadyGate,
    tablePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
  ): Promise<void> {
    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Query engine not available.' });
      return;
    }

    let effectiveTablePath = tablePath;
    let versions = await adapter.listMetadataVersions(handle, effectiveTablePath);
    if (!isStorageError(versions) && versions.length === 0) {
      const candidates = await adapter.listTables(handle, effectiveTablePath);
      if (!isStorageError(candidates) && candidates.length > 0) {
        for (const cand of candidates) {
          if (await adapter.isTable(handle, cand)) {
            const candVersions = await adapter.listMetadataVersions(handle, cand);
            if (!isStorageError(candVersions) && candVersions.length > 0) {
              effectiveTablePath = cand;
              versions = candVersions;
              this.logger.info(`Resolved child table ${cand} for directory ${tablePath}`);
              break;
            }
          }
        }
      }
    }
    if (isStorageError(versions) || versions.length === 0) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Could not find table metadata.' });
      return;
    }

    const meta = await adapter.fetchMetadataJson(handle, versions[0].resourcePath);
    if (isStorageError(meta)) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Could not read metadata JSON.' });
      return;
    }

    const rawMeta = meta as Record<string, any>;
    const currentSnapshotId = rawMeta['current-snapshot-id'];
    const snapshots = Array.isArray(rawMeta['snapshots']) ? rawMeta['snapshots'] : [];
    const currentSnap = snapshots.find((s: any) => s['snapshot-id'] === currentSnapshotId) ?? snapshots[snapshots.length - 1];
    const manifestListPath = currentSnap?.['manifest-list'];
    if (!manifestListPath) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'No snapshots or manifests found.' });
      return;
    }

    const listTemp = await adapter.fetchFileToTemp(handle, manifestListPath);
    if (isStorageError(listTemp)) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Could not fetch manifest list.' });
      return;
    }

    let manifestEntries: ManifestEntryRow[];
    try {
      const parsed = await engine.parseManifestList(listTemp);
      if (isQueryError(parsed)) {
        gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: parsed.message });
        return;
      }
      manifestEntries = parsed;
    } finally {
      void adapter.deleteTemp(listTemp);
    }

    const dataManifest = manifestEntries.find(m => m.content === 0) ?? manifestEntries[0];
    if (!dataManifest) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'No data manifest found.' });
      return;
    }

    const manifestTemp = await adapter.fetchFileToTemp(handle, dataManifest.manifestPath);
    if (isStorageError(manifestTemp)) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Could not fetch manifest file.' });
      return;
    }

    let dataFiles: DataFileRow[];
    try {
      const parsed = await engine.parseManifestFile(manifestTemp);
      if (isQueryError(parsed)) {
        gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: parsed.message });
        return;
      }
      dataFiles = parsed;
    } finally {
      void adapter.deleteTemp(manifestTemp);
    }

    const sampleFile = dataFiles.find(f => f.filePath.endsWith('.parquet') && f.status !== 2);
    if (!sampleFile) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'No active Parquet data files found.' });
      return;
    }

    const parquetTemp = await adapter.fetchFileToTemp(handle, sampleFile.filePath);
    if (isStorageError(parquetTemp)) {
      gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: 'Could not fetch Parquet data file.' });
      return;
    }

    try {
      const previewResult = await engine.previewParquet(parquetTemp);
      if (isQueryError(previewResult)) {
        gate.post({ type: 'loadDataPreview', columns: [], rows: [], rowCount: 0, error: previewResult.message });
        return;
      }

      const rows = previewResult.rows.slice(0, 50);
      gate.post({
        type: 'loadDataPreview',
        columns: previewResult.columnNames,
        rows,
        rowCount: rows.length,
      });
    } finally {
      void adapter.deleteTemp(parquetTemp);
    }
  }

  private async loadConnectionDashboard(
    gate: WebviewReadyGate,
    config: ConnectionConfig,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
    initialFilter?: string,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    const schemasResult = await adapter.listSchemas(handle);
    if (isStorageError(schemasResult)) {
      const msg = ERROR_MESSAGES[schemasResult.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: schemasResult.class, message: msg });
      return;
    }

    const tables: DiscoveredTableItem[] = [];

    const exploreDirectory = async (
      dirPath: string,
      parentNamespace?: string,
      depth = 0,
    ): Promise<void> => {
      if (depth > 3) return; // Prevent excessive recursion beyond predictable warehouse hierarchy

      const isTab = await adapter.isTable(handle, dirPath);
      if (isTab === true) {
        tables.push({
          name: lastPathSegment(dirPath),
          path: dirPath,
          schema: parentNamespace ?? 'default',
        });
        return;
      }

      // If not a table, treat as a schema / namespace folder
      const nsName = lastPathSegment(dirPath);
      const currentNamespace = parentNamespace ? `${parentNamespace}.${nsName}` : nsName;

      const subEntries = await adapter.listTables(handle, dirPath);
      if (!isStorageError(subEntries)) {
        for (const child of subEntries) {
          await exploreDirectory(child, currentNamespace, depth + 1);
        }
      }
    };

    const schemas: DiscoveredSchemaItem[] = [];

    for (const s of schemasResult) {
      const isTab = await adapter.isTable(handle, s);
      if (isTab === true) {
        tables.push({
          name: lastPathSegment(s),
          path: s,
          schema: 'default',
        });
      } else {
        const initialTableCount = tables.length;
        const schemaName = lastPathSegment(s);
        const subEntries = await adapter.listTables(handle, s);
        if (!isStorageError(subEntries)) {
          for (const child of subEntries) {
            await exploreDirectory(child, schemaName, 1);
          }
        }
        schemas.push({
          name: schemaName,
          path: s,
          tableCount: tables.length - initialTableCount,
        });
      }
    }

    gate.post({
      type: 'loadConnectionDashboard',
      connectionLabel: config.label,
      connectionType: config.connectionType,
      warehousePath: config.warehousePath,
      region: config.region,
      endpointUrl: config.endpointUrl,
      schemasCount: schemas.length,
      tablesCount: tables.length,
      schemas,
      tables,
      initialFilter: initialFilter ?? '',
    });
  }

  private async loadSchemaOverview(
    gate: WebviewReadyGate,
    schemaPath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
    schemaNameHint?: string,
    initialFilter?: string,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    const displaySchemaName = schemaNameHint ?? lastPathSegment(schemaPath);
    const tables: DiscoveredTableItem[] = [];

    const exploreDirectory = async (
      dirPath: string,
      parentNamespace?: string,
      depth = 0,
    ): Promise<void> => {
      if (depth > 3) return;

      const isTab = await adapter.isTable(handle, dirPath);
      if (isTab === true) {
        tables.push({
          name: lastPathSegment(dirPath),
          path: dirPath,
          schema: parentNamespace ?? displaySchemaName,
        });
        return;
      }

      const nsName = lastPathSegment(dirPath);
      const currentNamespace = parentNamespace ? `${parentNamespace}.${nsName}` : nsName;

      const subEntries = await adapter.listTables(handle, dirPath);
      if (!isStorageError(subEntries)) {
        for (const child of subEntries) {
          await exploreDirectory(child, currentNamespace, depth + 1);
        }
      }
    };

    const isDirectTable = await adapter.isTable(handle, schemaPath);
    if (isDirectTable === true) {
      tables.push({
        name: lastPathSegment(schemaPath),
        path: schemaPath,
        schema: displaySchemaName,
      });
    } else {
      const entries = await adapter.listTables(handle, schemaPath);
      if (isStorageError(entries)) {
        const msg = ERROR_MESSAGES[entries.class] ?? ERROR_MESSAGES['internal'];
        gate.post({ type: 'setState', state: 'error', errorClass: entries.class, message: msg });
        return;
      }
      for (const child of entries) {
        await exploreDirectory(child, displaySchemaName, 1);
      }
    }

    const config = this._getConnectionConfig(handle, schemaPath);

    gate.post({
      type: 'loadSchemaOverview',
      schemaName: displaySchemaName,
      schemaPath,
      warehouseLabel: config?.label,
      warehousePath: config?.warehousePath ?? handle.warehousePath,
      tablesCount: tables.length,
      tables,
      initialFilter: initialFilter ?? '',
    });
  }

  private async loadMetadataArchitecture(
    gate: WebviewReadyGate,
    tablePath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
    targetSnapshotId?: string,
  ): Promise<void> {
    gate.post({ type: 'setState', state: 'loading' });

    let effectiveTablePath = tablePath;
    let versions = await adapter.listMetadataVersions(handle, effectiveTablePath);
    if (!isStorageError(versions) && versions.length === 0) {
      const candidates = await adapter.listTables(handle, effectiveTablePath);
      if (!isStorageError(candidates) && candidates.length > 0) {
        for (const cand of candidates) {
          if (await adapter.isTable(handle, cand)) {
            const candVersions = await adapter.listMetadataVersions(handle, cand);
            if (!isStorageError(candVersions) && candVersions.length > 0) {
              effectiveTablePath = cand;
              versions = candVersions;
              this.logger.info(`Resolved child table ${cand} for directory ${tablePath}`);
              break;
            }
          }
        }
      }
    }
    if (isStorageError(versions) || versions.length === 0) {
      const errClass = isStorageError(versions) ? versions.class : 'not-found';
      gate.post({
        type: 'setState',
        state: 'error',
        errorClass: errClass,
        message: `Could not find metadata versions for table at ${tablePath}. If this is a database or namespace, select a table inside it (e.g. ${tablePath}/<tableName>).`,
      });
      return;
    }

    const latest = versions[0];
    const meta = await adapter.fetchMetadataJson(handle, latest.resourcePath);
    if (isStorageError(meta)) {
      const msg = ERROR_MESSAGES[meta.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: meta.class, message: msg });
      return;
    }

    const rawMeta = meta as Record<string, any>;
    const rawSnaps = Array.isArray(rawMeta['snapshots']) ? rawMeta['snapshots'] : [];
    const snapshots: SnapshotSummaryItem[] = rawSnaps
      .slice()
      .sort((a: any, b: any) => Number(b['timestamp-ms'] ?? 0) - Number(a['timestamp-ms'] ?? 0))
      .map((s: any) => ({
        snapshotId: String(s['snapshot-id']),
        parentSnapshotId: s['parent-snapshot-id'] ? String(s['parent-snapshot-id']) : null,
        timestampMs: Number(s['timestamp-ms'] ?? 0),
        operation: String(s.summary?.operation ?? 'commit'),
        addedRecords: s.summary?.['added-records'] ? String(s.summary['added-records']) : undefined,
        deletedRecords: s.summary?.['deleted-records'] ? String(s.summary['deleted-records']) : undefined,
        addedFiles: s.summary?.['added-data-files'] ? String(s.summary['added-data-files']) : undefined,
        manifestList: s['manifest-list'] ? String(s['manifest-list']) : undefined,
      }));

    const currentSnapshotId = rawMeta['current-snapshot-id'] !== undefined ? String(rawMeta['current-snapshot-id']) : null;
    const activeSnapId = targetSnapshotId ?? currentSnapshotId ?? (snapshots.length > 0 ? snapshots[0].snapshotId : null);
    const activeSnapObj = rawSnaps.find((s: any) => String(s['snapshot-id']) === activeSnapId) ?? (rawSnaps.length > 0 ? rawSnaps[rawSnaps.length - 1] : null);

    let activeSnapshotData: { snapshotId: string; manifestList: string; manifests: ManifestArchitectureCard[] } | null = null;

    if (activeSnapObj && activeSnapObj['manifest-list'] && this.queryEngine) {
      const mlPath = String(activeSnapObj['manifest-list']);
      const mlTemp = await adapter.fetchFileToTemp(handle, mlPath);
      if (!isStorageError(mlTemp)) {
        try {
          const rows = await this.queryEngine.parseManifestList(mlTemp);
          if (!isQueryError(rows)) {
            const manifests: ManifestArchitectureCard[] = rows.map(r => ({
              path: r.manifestPath,
              partitionSpecId: r.partitionSpecId,
              addedFiles: r.addedFilesCount ?? 0,
              existingFiles: r.existingFilesCount ?? 0,
              deletedFiles: r.deletedFilesCount ?? 0,
              partitionSummary: `Partition spec #${r.partitionSpecId}`,
            }));
            activeSnapshotData = {
              snapshotId: String(activeSnapObj['snapshot-id']),
              manifestList: mlPath,
              manifests,
            };
          }
        } finally {
          void adapter.deleteTemp(mlTemp);
        }
      }
    }

    gate.post({
      type: 'loadMetadataArchitecture',
      tablePath,
      metadataFile: latest.resourcePath,
      currentSnapshotId,
      snapshots,
      activeSnapshot: activeSnapshotData,
    });
  }

  private async loadManifestDataFiles(
    gate: WebviewReadyGate,
    manifestPath: string,
    handle: ActiveConnectionHandle,
    adapter: StorageAdapter,
  ): Promise<void> {
    const engine = this.queryEngine;
    if (!engine) {
      gate.post({ type: 'loadManifestDataFiles', manifestPath, files: [], error: 'Query engine not available.' });
      return;
    }

    const manifestTemp = await adapter.fetchFileToTemp(handle, manifestPath);
    if (isStorageError(manifestTemp)) {
      gate.post({ type: 'loadManifestDataFiles', manifestPath, files: [], error: 'Could not fetch manifest file.' });
      return;
    }

    try {
      const parsed = await engine.parseManifestFile(manifestTemp);
      if (isQueryError(parsed)) {
        gate.post({ type: 'loadManifestDataFiles', manifestPath, files: [], error: parsed.message });
        return;
      }

      const statusMap = (s: number) => (s === 1 ? 'ADDED' : s === 2 ? 'DELETED' : 'EXISTING');
      const files: ManifestDataFileEntry[] = parsed.map(f => ({
        path: f.filePath,
        status: statusMap(f.status),
        recordCount: f.recordCount,
        fileSizeInBytes: f.fileSizeBytes,
      }));

      gate.post({ type: 'loadManifestDataFiles', manifestPath, files });
    } finally {
      void adapter.deleteTemp(manifestTemp);
    }
  }

  /**
   * Delete a registered temp file (or array of temp files) and clear the registry entry.
   * Called on success, error, and cancel paths (design.md §2.6).
   */
  private async deleteTempFile(key: string, tempFile: string | string[]): Promise<void> {
    this.tempFiles.set(key, null);
    const files = Array.isArray(tempFile) ? tempFile : [tempFile];
    for (const f of files) {
      try {
        await this.storageAdapter.deleteTemp(f);
        this.logger.info(`Temp file deleted: ${f}`);
      } catch {
        this.logger.warn(`Temp file deletion failed (already absent): ${f}`);
      }
    }
  }
}
