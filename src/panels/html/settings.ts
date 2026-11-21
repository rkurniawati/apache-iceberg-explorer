/**
 * Settings Panel — HTML shell and client-side form for connection configuration.
 *
 * FR-1  Clicking ⚙ opens this panel.
 * FR-2  S3 fields: endpoint URL, region, access key, secret key, SSL toggle.
 * FR-2b SSL-verification toggle.
 * FR-3  Credentials handled by extension host only — webview sends them in a
 *        message and never stores them.
 * FR-4  Custom S3-compatible endpoint (MinIO, IBM COS) using path-style addressing.
 * FR-5  When connection type is "local", S3 fields are visually disabled.
 *
 * The "Saved Connections" section has been removed — connections are now shown
 * as first-class nodes in the Explorer tree view (saved-connections-tree-view-plan.md).
 *
 * NFR-8  CSP nonce on all scripts; no external CDN URLs.
 * NFR-9  All colours use --vscode-* variables.
 *
 * Client-side script is located in src/webviews/settings.ts
 * and bundled to out/webviews/settings.js.
 */

export interface SettingsStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export type SettingsUris = SettingsStyleUris;

/**
 * Produces the settings panel HTML.
 *
 * @param nonce                      Per-load CSP nonce.
 * @param cspSource                  webview.cspSource value (for img-src and script-src).
 * @param initialConnections         Array of existing connection configs.
 * @param styleUris                  Resource URIs for CSS and bundled webview JS.
 * @param initialActiveConnectionId  ID of currently active connection, if any.
 */
export function getSettingsHtml(
  nonce: string,
  cspSource: string,
  initialConnections: Array<{ id: string; label: string }> = [],
  styleUris?: SettingsStyleUris,
  initialActiveConnectionId: string | null = null,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/settings.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/settings.js';

  const settingsData = {
    initialConnections: initialConnections.map((c) => ({ id: c.id, label: c.label })),
    initialActiveConnectionId: initialActiveConnectionId || null,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Iceberg Explorer — Settings</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>

<h1>Iceberg Explorer — Connection Settings</h1>

<div id="status-banner" role="status" aria-live="polite">
  <div id="status-banner-content">
    <span id="status-banner-icon" aria-hidden="true" style="display: none;"></span>
    <span id="status-banner-text"></span>
  </div>
  <button class="primary" id="banner-connect-btn" type="button" style="display: none;">Connect</button>
</div>

<section id="form-section">
  <h2 id="form-heading">New Connection</h2>

  <!-- Hidden id field — populated when editing an existing connection -->
  <input id="conn-id" type="hidden" value="">

  <!-- Connection type selector (FR-2, FR-5) -->
  <div class="field">
    <label for="conn-type">Connection type</label>
    <select id="conn-type">
      <option value="local">Local file system</option>
      <option value="s3">S3 / S3-compatible</option>
      <option value="gcs">Google Cloud Storage (GCS)</option>
    </select>
  </div>

  <!-- Label -->
  <div class="field">
    <label for="conn-label">Connection name</label>
    <input id="conn-label" type="text" placeholder="e.g. My Warehouse" autocomplete="off">
    <div class="field-error" id="err-label"></div>
  </div>

  <!-- S3-only fields — disabled when connection type is local (FR-5) -->
  <div id="s3-fields">
    <div class="field">
      <label for="endpoint-url">Endpoint URL</label>
      <input id="endpoint-url" type="text" placeholder="https://s3.amazonaws.com (optional for AWS)" autocomplete="off">
      <div class="field-error" id="err-endpoint"></div>
    </div>
    <div class="field">
      <label for="region">Region</label>
      <input id="region" type="text" placeholder="us-east-1" autocomplete="off">
      <div class="field-error" id="err-region"></div>
    </div>
    <p id="creds-note" class="creds-note" style="display:none;">
      Existing credentials are saved. Enter new values only to update credentials.
    </p>
    <div class="field">
      <label for="access-key">Access key ID</label>
      <input id="access-key" type="password" placeholder="AKIA..." autocomplete="off">
      <div class="field-error" id="err-access-key"></div>
    </div>
    <div class="field">
      <label for="secret-key">Secret access key</label>
      <input id="secret-key" type="password" placeholder="wJalr..." autocomplete="off">
      <div class="field-error" id="err-secret-key"></div>
    </div>
    <div class="field checkbox-field">
      <label>
        <input id="ssl-verify" type="checkbox" checked>
        Validate SSL certificates
      </label>
      <p class="field-hint">Uncheck for self-signed development endpoints (MinIO, LocalStack).</p>
    </div>
  </div>

  <!-- GCS-only fields (hidden unless connection type is gcs) -->
  <div id="gcs-fields" style="display: none;">
    <div class="field">
      <label for="gcs-auth-type">Authentication Method</label>
      <select id="gcs-auth-type">
        <option value="adc">Google Application Default Credentials (ADC)</option>
        <option value="serviceAccountKey">Service Account Key (JSON / File)</option>
      </select>
      <p class="field-hint">Use ADC for gcloud CLI or compute environments; use Service Account Key to upload or paste a service account JSON credentials file.</p>
    </div>
    <div class="field" id="gcs-key-row" style="display: none;">
      <label>Service Account Credentials</label>
      <div class="tab-mode-selector">
        <button class="tab-mode-btn active" id="key-mode-file" type="button">Local File Path</button>
        <button class="tab-mode-btn" id="key-mode-paste" type="button">Paste JSON Content</button>
      </div>
      <div id="gcs-file-container">
        <div class="file-picker-row">
          <input id="gcs-key-file" type="text" placeholder="/path/to/service-account.json" autocomplete="off">
          <button class="secondary" id="browse-key-btn" type="button" title="Browse for service account key file">Browse…</button>
        </div>
      </div>
      <div id="gcs-json-container" style="display: none;">
        <textarea id="gcs-key-json" placeholder='{"type": "service_account", "project_id": "...", ...}' rows="5" spellcheck="false"></textarea>
        <div class="json-actions">
          <button class="secondary" id="format-json-btn" type="button">Format &amp; Validate JSON</button>
          <span class="json-status" id="gcs-json-status"></span>
        </div>
      </div>
      <p id="gcs-creds-note" class="creds-note" style="display: none;">
        Existing service account key is saved. Enter a new value only to update credentials.
      </p>
      <div class="field-error" id="err-gcs-key"></div>
    </div>
    <div class="field">
      <label for="gcs-project-id">GCP Project ID (Optional)</label>
      <input id="gcs-project-id" type="text" placeholder="e.g. my-gcp-project" autocomplete="off">
      <div class="field-error" id="err-gcs-project"></div>
      <p class="field-hint">Overrides default project for billing or requester-pays buckets if needed.</p>
    </div>
  </div>

  <!-- Warehouse path — S3 URI or local path depending on type -->
  <div class="field">
    <label for="warehouse-path" id="warehouse-path-label">Warehouse path</label>
    <div class="path-input-group">
      <input id="warehouse-path" type="text" placeholder="/path/to/warehouse" autocomplete="off">
      <button class="secondary" id="browse-warehouse-btn" type="button" title="Explore and navigate bucket contents">Browse…</button>
      <button class="secondary" id="detect-warehouse-btn" type="button" title="Scan bucket for existing Iceberg tables">Detect</button>
    </div>
    <p class="field-hint" id="warehouse-path-note" style="display: none;"></p>
    <div class="field-error" id="err-path"></div>
  </div>

  <!-- Auto-detected Warehouse Path Suggestion Banner -->
  <div id="path-suggestion" class="path-suggestion" style="display: none;">
    <div class="suggestion-content">
      <span class="suggestion-icon">💡</span>
      <span class="suggestion-label">Found Iceberg tables under:</span>
      <code class="suggestion-path" id="path-suggestion-value"></code>
      <button class="primary suggestion-btn" id="apply-suggestion-btn" type="button">Use this path</button>
    </div>
  </div>

  <!-- Inline Warehouse Browser Drawer -->
  <div id="warehouse-browser" class="warehouse-browser" style="display: none;">
    <div class="browser-header">
      <div class="browser-title-row">
        <span class="browser-title">Warehouse Explorer</span>
        <button class="browser-close-btn" id="browser-close-btn" type="button" title="Close browser">✕</button>
      </div>
      <div class="browser-toolbar">
        <button class="secondary browser-nav-btn" id="browser-up-btn" type="button" title="Go up one folder" disabled>▲ Up</button>
        <button class="secondary browser-nav-btn" id="browser-refresh-btn" type="button" title="Refresh">↻ Refresh</button>
        <button class="secondary browser-nav-btn" id="browser-local-picker-btn" type="button" style="display: none;" title="Open OS Folder Picker">📁 Choose Folder…</button>
        <div class="browser-path-display" id="browser-current-path" title="Current path"></div>
      </div>
    </div>
    <div class="browser-status" id="browser-status" style="display: none;"></div>
    <div class="browser-list-container" id="browser-list">
      <div class="browser-list-empty">Click "Browse…" to explore bucket or folder contents.</div>
    </div>
    <div class="browser-footer">
      <div class="browser-selection-info" id="browser-selected-info">
        Selected: <code id="browser-selected-text">None</code>
      </div>
      <button class="primary" id="browser-select-btn" type="button" disabled>Select as Warehouse Path</button>
    </div>
  </div>

  <div class="btn-row">
    <button class="primary" id="save-btn" type="button">Save Connection</button>
    <button class="secondary" id="connect-btn" type="button" style="display: none;">Connect</button>
    <button class="secondary" id="clear-btn" type="button">Clear</button>
  </div>
</section>

<script id="settings-data" type="application/json">${JSON.stringify(settingsData).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
