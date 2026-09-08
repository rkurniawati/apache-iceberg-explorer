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
import { lastPathSegment, resourcePathToBreadcrumbs } from './utils.js';
import type { QueryEngine } from '../query/index.js';
import { isQueryError } from '../query/index.js';

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
  private readonly tempFiles = new Map<string, string | null>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storageAdapter: StorageAdapter,
    private readonly logger: ILogger,
    private readonly queryEngine?: QueryEngine,
    /** Optional callback to reveal a resource path in the tree view. */
    private readonly revealPath?: (resourcePath: string) => void,
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

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadManifestListPanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openManifestFile') {
          void this.openManifestFilePanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          this._handleBreadcrumbNavigate(resourcePath, msg.segment);
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

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadManifestFilePanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openParquetPreview') {
          void this.openParquetPreviewPanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          this._handleBreadcrumbNavigate(resourcePath, msg.segment);
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

    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (gate.onHostMessage(msg)) { return; }
        if (msg.type === 'retry') {
          void this.loadParquetPreviewPanel(gate, key, resourcePath, handle, adapter);
        } else if (msg.type === 'openAdHocQuery') {
          void this.openAdHocQueryPanel(msg.resourcePath, handle, adapter);
        } else if (msg.type === 'breadcrumbNavigate') {
          this.logger.info(`Breadcrumb navigate: segment=${msg.segment} resource=${resourcePath}`);
          this._handleBreadcrumbNavigate(resourcePath, msg.segment);
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
          this._handleBreadcrumbNavigate(resourcePath, msg.segment);
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

    const fetchResult = await adapter.fetchFileToTemp(handle, resourcePath);
    if (isStorageError(fetchResult)) {
      const msg = ERROR_MESSAGES[fetchResult.class] ?? ERROR_MESSAGES['internal'];
      gate.post({ type: 'setState', state: 'error', errorClass: fetchResult.class, message: msg });
      this.logger.error(`Panel error: type=adHocQuery resource=${resourcePath} errorClass=${fetchResult.class}`);
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
      const result = await engine.runAdHocQuery(fetchResult, sql);
      if (isQueryError(result)) {
        void this.deleteTempFile(key, fetchResult);
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

      void this.deleteTempFile(key, fetchResult);
      gate.post({ type: 'loadQueryResult', result });
      if (result.wasCapped) {
        gate.post({ type: 'showCapBanner', message: 'Results capped at 10,000 rows.' });
      }
      this.logger.info(`Panel loaded: type=adHocQuery resource=${resourcePath} rows=${result.rowCount} capped=${result.wasCapped}`);
    } catch (err: unknown) {
      void this.deleteTempFile(key, fetchResult);
      const errMsg = err instanceof Error ? err.message : String(err);
      gate.post({ type: 'setState', state: 'error', errorClass: 'internal', message: `Failed to execute query: ${errMsg}` });
      this.logger.error(`Panel error: type=adHocQuery resource=${resourcePath} errorClass=internal error=${errMsg}`);
    }
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
  ): Promise<void> {
    const key = panelRegistryKey(PanelType.Settings, 'settings');
    const existing = this.registry.get(key);

    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      this.logger.info('Panel revealed (already open): type=settings resource=settings');
      // If an editConfig was provided, post the editConnection message to pre-fill
      if (editConfig) {
        void existing.panel.webview.postMessage({
          type: 'editConnection',
          config: { id: editConfig.id, label: editConfig.label, connectionType: editConfig.connectionType, warehousePath: editConfig.warehousePath, endpointUrl: editConfig.endpointUrl, region: editConfig.region },
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

    panel.webview.html = getSettingsHtml(nonce, panel.webview.cspSource);

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
              connectionType: (msg.connectionType as 'local' | 's3'),
              warehousePath:  String(msg.warehousePath ?? '').trim(),
              endpointUrl:    endpointUrlStr && endpointUrlStr !== '' ? endpointUrlStr : undefined,
              region:         msg.region      !== undefined ? String(msg.region).trim()      : undefined,
              sslVerification: Boolean(msg.sslVerification ?? true),
              savedAt: Date.now(),
            };
            const creds = {
              accessKey: String(msg.accessKey ?? '').trim(),
              secretKey: String(msg.secretKey ?? '').trim(),
            };
            try {
              await saveConnection(config, creds);
              void panel.webview.postMessage({ type: 'saveSuccess' });
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
              await deleteConnection(String(msg.id ?? ''));
              void panel.webview.postMessage({ type: 'deleteSuccess' });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Failed to delete connection.';
              void panel.webview.postMessage({ type: 'deleteError', message });
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
      void panel.webview.postMessage({
        type: 'editConnection',
        config: { id: editConfig.id, label: editConfig.label, connectionType: editConfig.connectionType, warehousePath: editConfig.warehousePath, endpointUrl: editConfig.endpointUrl, region: editConfig.region },
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
        if (rp) { this._handleBreadcrumbNavigate(rp, msg.segment); }
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
    this.registry.delete(key);
    this.tempFiles.delete(key);

    if (tempFile) {
      void this.storageAdapter.deleteTemp(tempFile).then(() => {
        this.logger.info(`Temp file deleted: ${tempFile}`);
      }).catch(() => {
        this.logger.warn(`Temp file deletion failed (already absent): ${tempFile}`);
      });
    }
  }

  /**
   * Resolve the clicked breadcrumb segment to a resource path and call
   * revealPath so the tree view scrolls to that node.
   *
   * resourcePathToBreadcrumbs produces 4 segments for the "metadata" path
   * pattern: [root, schema, table, file].  The "metadata" directory component
   * sits between table and file in the real path but is omitted from the
   * breadcrumbs.  We mirror the same index arithmetic used by that function so
   * that each breadcrumb segment maps to the correct real path prefix.
   */
  private _handleBreadcrumbNavigate(resourcePath: string, segmentIndex: number): void {
    if (!this.revealPath) { return; }

    const breadcrumbs = resourcePathToBreadcrumbs(resourcePath);
    // Last segment is the file itself (never clickable); guard anyway.
    if (segmentIndex >= breadcrumbs.length - 1) { return; }

    // Normalise Hadoop variants and split into real path components.
    const normalised = resourcePath.replace(/\\/g, '/').replace(/^s3[an]:\/\//, 's3://');
    const isS3 = normalised.startsWith('s3://');

    let parts: string[];
    if (isS3) {
      parts = normalised.slice('s3://'.length).split('/').filter(Boolean);
    } else {
      parts = normalised.split('/').filter(Boolean);
    }

    // Find where each breadcrumb segment sits in `parts`, using the same
    // rules as resourcePathToBreadcrumbs.
    //
    // For the metadata path pattern (metaIdx found):
    //   parts = [...root..., schema, table, 'metadata', file]
    //   segment 0 (root)   → parts[0..metaIdx-3]  → endIdx = metaIdx - 3
    //   segment 1 (schema) → parts[metaIdx-2]      → endIdx = metaIdx - 2
    //   segment 2 (table)  → parts[metaIdx-1]      → endIdx = metaIdx - 1
    //   segment 3 (file)   → not clickable
    //
    // For the data path / fallback pattern (last-4 tail, no metadata dir):
    //   Every breadcrumb segment maps 1-to-1 to a real part; the only
    //   compression is the root segment absorbing leading parts.
    const metaIdx = parts.lastIndexOf('metadata');
    const n = breadcrumbs.length;

    let endPartIndex: number;

    if (metaIdx >= 0 && n === 4) {
      // Standard metadata path pattern — mirror resourcePathToBreadcrumbs exactly.
      if (segmentIndex === 0) {
        endPartIndex = metaIdx - 3;         // last part of root prefix
      } else if (segmentIndex === 1) {
        endPartIndex = metaIdx - 2;         // schema
      } else {
        endPartIndex = metaIdx - 1;         // table (segmentIndex === 2)
      }
    } else {
      // Fallback / data-path pattern: root absorbs leading parts,
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
      : '/' + targetParts.join('/');

    this.logger.info(`Breadcrumb navigate → resolved path: ${targetPath}`);
    this.revealPath(targetPath);
  }

  /**
   * Delete a registered temp file and clear the registry entry.
   * Called on success, error, and cancel paths (design.md §2.6).
   */
  private deleteTempFile(key: string, tempFile: string): Promise<void> {
    this.tempFiles.set(key, null);
    return this.storageAdapter.deleteTemp(tempFile).then(() => {
      this.logger.info(`Temp file deleted: ${tempFile}`);
    }).catch(() => {
      this.logger.warn(`Temp file deletion failed (already absent): ${tempFile}`);
    });
  }
}
