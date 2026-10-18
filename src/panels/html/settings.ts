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
 */

/**
 * Produces the settings panel HTML.
 *
 * @param nonce      Per-load CSP nonce.
 * @param cspSource  webview.cspSource value (for img-src).
 */
export interface SettingsStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

export function getSettingsHtml(
  nonce: string,
  cspSource: string,
  initialConnections: Array<{ id: string; label: string }> = [],
  styleUris?: SettingsStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/settings.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Iceberg Explorer — Settings</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>

<h1>Iceberg Explorer — Connection Settings</h1>

<div id="status-banner">
  <span id="status-banner-text"></span>
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
      <label for="access-key">Access key</label>
      <input id="access-key" type="password" autocomplete="new-password">
      <div class="field-error" id="err-access-key"></div>
    </div>
    <div class="field">
      <label for="secret-key">Secret key</label>
      <input id="secret-key" type="password" autocomplete="new-password">
      <div class="field-error" id="err-secret-key"></div>
    </div>
    <div class="field">
      <div class="toggle-row">
        <input id="ssl-verify" type="checkbox" checked>
        <label for="ssl-verify">Verify SSL certificate</label>
      </div>
    </div>
  </div>

  <!-- GCS-only fields -->
  <div id="gcs-fields" style="display:none;">
    <div class="field">
      <label for="gcs-auth-type">Authentication method</label>
      <select id="gcs-auth-type">
        <option value="adc">Application Default Credentials (ADC) / gcloud CLI</option>
        <option value="serviceAccountKey">Service Account Key (JSON or file path)</option>
      </select>
    </div>
    <div class="field" id="gcs-key-row" style="display:none;">
      <p id="gcs-creds-note" class="creds-note" style="display:none;">
        Existing service account key is saved. Enter a new value only to update credentials.
      </p>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
        <label style="margin: 0;">Service account key</label>
        <div class="key-mode-tabs">
          <button type="button" class="key-mode-btn active" id="key-mode-file">Key File (.json)</button>
          <button type="button" class="key-mode-btn" id="key-mode-paste">Paste JSON</button>
        </div>
      </div>

      <!-- File Mode -->
      <div id="gcs-file-container">
        <div style="display: flex; gap: 0.5rem;">
          <input id="gcs-key-file" type="text" placeholder="/path/to/key.json or ~/key.json" autocomplete="off" style="flex: 1;">
          <button class="secondary" id="browse-key-btn" type="button" style="white-space: nowrap;">Browse…</button>
        </div>
      </div>

      <!-- Paste JSON Mode -->
      <div id="gcs-json-container" style="display: none;">
        <textarea id="gcs-key-json" rows="6" placeholder='Paste Google Cloud Service Account JSON:&#10;{&#10;  "type": "service_account",&#10;  "project_id": "...",&#10;  "private_key": "-----BEGIN PRIVATE KEY-----\n...",&#10;  "client_email": "..."&#10;}' spellcheck="false" style="font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; resize: vertical;"></textarea>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.25rem;">
          <span id="gcs-json-status" style="font-size: 0.85em; color: var(--vscode-descriptionForeground);"></span>
          <button class="secondary" id="format-json-btn" type="button" style="font-size: 0.85em; padding: 0.2rem 0.6rem;">Format / Validate JSON</button>
        </div>
      </div>

      <div class="field-error" id="err-gcs-key"></div>
    </div>
    <div class="field">
      <label for="gcs-project-id">GCP Project ID (optional)</label>
      <input id="gcs-project-id" type="text" placeholder="e.g. my-gcp-project" autocomplete="off">
      <div class="field-error" id="err-gcs-project"></div>
    </div>
  </div>

  <!-- Warehouse path (local) / S3 URI (S3) / GCS URI (GCS) -->
  <div class="field">
    <label for="warehouse-path" id="warehouse-path-label">Warehouse path</label>
    <div style="display: flex; gap: 0.5rem; align-items: stretch;">
      <input id="warehouse-path" type="text" placeholder="/absolute/path/to/warehouse" autocomplete="off" style="flex: 1;">
      <button class="secondary" id="browse-warehouse-btn" type="button" title="Browse bucket or folder" style="white-space: nowrap;">Browse…</button>
      <button class="secondary" id="detect-warehouse-btn" type="button" title="Auto-detect Iceberg warehouse root" style="white-space: nowrap;">Detect</button>
    </div>
    <p id="warehouse-path-note" class="creds-note" style="display:none; margin-top:0.3rem;">
      Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>s3://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.
    </p>
    <div class="field-error" id="err-path"></div>
    <div id="path-suggestion" class="suggestion-banner" style="display: none;">
      <span class="suggestion-text">💡 Detected warehouse: <strong id="path-suggestion-value"></strong></span>
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
    <button class="secondary" id="clear-btn" type="button">Clear</button>
  </div>
</section>

<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // Existing connections for duplicate name validation
  var existingConnections = ${JSON.stringify(initialConnections.map((c) => ({ id: c.id, label: c.label }))).replace(/</g, '\\u003c')};

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const connType     = /** @type {HTMLSelectElement}   */ (document.getElementById('conn-type'));
  const connLabel    = /** @type {HTMLInputElement}    */ (document.getElementById('conn-label'));
  const warehousePath= /** @type {HTMLInputElement}    */ (document.getElementById('warehouse-path'));
  const pathLabel    = document.getElementById('warehouse-path-label');
  const s3Fields     = document.getElementById('s3-fields');
  const endpointUrl  = /** @type {HTMLInputElement}    */ (document.getElementById('endpoint-url'));
  const region       = /** @type {HTMLInputElement}    */ (document.getElementById('region'));
  const accessKey    = /** @type {HTMLInputElement}    */ (document.getElementById('access-key'));
  const secretKey    = /** @type {HTMLInputElement}    */ (document.getElementById('secret-key'));
  const sslVerify    = /** @type {HTMLInputElement}    */ (document.getElementById('ssl-verify'));
  const gcsFields    = document.getElementById('gcs-fields');
  const gcsAuthType    = /** @type {HTMLSelectElement}   */ (document.getElementById('gcs-auth-type'));
  const gcsKeyRow      = document.getElementById('gcs-key-row');
  const gcsKeyFile     = /** @type {HTMLInputElement}    */ (document.getElementById('gcs-key-file'));
  const gcsKeyJson     = /** @type {HTMLTextAreaElement} */ (document.getElementById('gcs-key-json'));
  const keyModeFileBtn = document.getElementById('key-mode-file');
  const keyModePasteBtn= document.getElementById('key-mode-paste');
  const gcsFileContainer = document.getElementById('gcs-file-container');
  const gcsJsonContainer = document.getElementById('gcs-json-container');
  const browseKeyBtn   = document.getElementById('browse-key-btn');
  const formatJsonBtn  = document.getElementById('format-json-btn');
  const gcsJsonStatus  = document.getElementById('gcs-json-status');
  const gcsCredsNote   = document.getElementById('gcs-creds-note');
  const gcsProjectId   = /** @type {HTMLInputElement}    */ (document.getElementById('gcs-project-id'));
  const connId         = /** @type {HTMLInputElement}    */ (document.getElementById('conn-id'));
  const formHeading    = document.getElementById('form-heading');
  const credsNote      = document.getElementById('creds-note');
  const saveBtn          = document.getElementById('save-btn');
  const clearBtn         = document.getElementById('clear-btn');
  const statusBanner     = document.getElementById('status-banner');
  const statusBannerText = document.getElementById('status-banner-text');
  const bannerConnectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('banner-connect-btn'));
  const browseWarehouseBtn   = document.getElementById('browse-warehouse-btn');
  const detectWarehouseBtn   = document.getElementById('detect-warehouse-btn');
  const pathSuggestion       = document.getElementById('path-suggestion');
  const pathSuggestionValue   = document.getElementById('path-suggestion-value');
  const applySuggestionBtn   = document.getElementById('apply-suggestion-btn');
  const warehouseBrowser     = document.getElementById('warehouse-browser');
  const browserCloseBtn      = document.getElementById('browser-close-btn');
  const browserUpBtn         = /** @type {HTMLButtonElement} */ (document.getElementById('browser-up-btn'));
  const browserRefreshBtn    = document.getElementById('browser-refresh-btn');
  const browserLocalPickerBtn= document.getElementById('browser-local-picker-btn');
  const browserCurrentPath   = document.getElementById('browser-current-path');
  const browserStatus        = document.getElementById('browser-status');
  const browserList          = document.getElementById('browser-list');
  const browserSelectedText  = document.getElementById('browser-selected-text');
  const browserSelectBtn     = /** @type {HTMLButtonElement} */ (document.getElementById('browser-select-btn'));

  var currentBrowsedPath = '';
  var currentParentPath = null;
  var currentSelectedPath = '';
  var currentSuggestion = '';

  function showSuggestion(path) {
    currentSuggestion = path;
    if (pathSuggestionValue) pathSuggestionValue.textContent = path;
    if (pathSuggestion) pathSuggestion.style.display = 'flex';
  }

  function hideSuggestion() {
    currentSuggestion = '';
    if (pathSuggestion) pathSuggestion.style.display = 'none';
    if (pathSuggestionValue) pathSuggestionValue.textContent = '';
  }

  function setBrowserStatus(msg, isError) {
    if (!browserStatus) return;
    if (!msg) {
      browserStatus.style.display = 'none';
      browserStatus.textContent = '';
      browserStatus.className = 'browser-status';
      return;
    }
    browserStatus.textContent = msg;
    browserStatus.className = isError ? 'browser-status error' : 'browser-status';
    browserStatus.style.display = 'block';
  }

  function setSelectedPath(path) {
    currentSelectedPath = path;
    if (browserSelectedText) browserSelectedText.textContent = path || 'None';
    if (browserSelectBtn) browserSelectBtn.disabled = !path;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function requestBrowse(targetPath) {
    if (!warehouseBrowser) return;
    warehouseBrowser.style.display = 'block';
    setBrowserStatus('Loading directory contents...', false);
    if (browserSelectBtn) browserSelectBtn.disabled = true;

    var reqPath = targetPath !== undefined ? targetPath : warehousePath.value.trim();

    vscode.postMessage({
      type: 'browseDirectory',
      id: connId.value || undefined,
      connectionType: connType.value,
      warehousePath: reqPath,
      dirPath: reqPath,
      endpointUrl: connType.value === 's3' && endpointUrl.value.trim() ? endpointUrl.value.trim() : undefined,
      region: connType.value === 's3' ? region.value.trim() : undefined,
      accessKey: connType.value === 's3' ? accessKey.value.trim() : undefined,
      secretKey: connType.value === 's3' ? secretKey.value.trim() : (connType.value === 'gcs' ? getEffectiveGcsKey() : undefined),
      sslVerification: connType.value === 's3' ? sslVerify.checked : true,
      gcsAuthType: connType.value === 'gcs' && gcsAuthType ? gcsAuthType.value : undefined,
      projectId: connType.value === 'gcs' && gcsProjectId ? gcsProjectId.value.trim() : undefined,
    });
  }

  function requestDetect(targetPath) {
    var p = targetPath || warehousePath.value.trim();
    if (!p) {
      showError('err-path', 'Please enter a bucket or directory path to detect warehouses.');
      return;
    }
    clearErrors();
    hideSuggestion();
    showBanner('Scanning for Iceberg tables...', false);

    vscode.postMessage({
      type: 'detectWarehouse',
      id: connId.value || undefined,
      connectionType: connType.value,
      warehousePath: p,
      searchPath: p,
      endpointUrl: connType.value === 's3' && endpointUrl.value.trim() ? endpointUrl.value.trim() : undefined,
      region: connType.value === 's3' ? region.value.trim() : undefined,
      accessKey: connType.value === 's3' ? accessKey.value.trim() : undefined,
      secretKey: connType.value === 's3' ? secretKey.value.trim() : (connType.value === 'gcs' ? getEffectiveGcsKey() : undefined),
      sslVerification: connType.value === 's3' ? sslVerify.checked : true,
      gcsAuthType: connType.value === 'gcs' && gcsAuthType ? gcsAuthType.value : undefined,
      projectId: connType.value === 'gcs' && gcsProjectId ? gcsProjectId.value.trim() : undefined,
    });
  }

  var gcsKeyMode = 'file'; // 'file' | 'paste'

  function setGcsKeyMode(mode) {
    gcsKeyMode = mode;
    if (mode === 'file') {
      if (keyModeFileBtn) keyModeFileBtn.classList.add('active');
      if (keyModePasteBtn) keyModePasteBtn.classList.remove('active');
      if (gcsFileContainer) gcsFileContainer.style.display = 'block';
      if (gcsJsonContainer) gcsJsonContainer.style.display = 'none';
    } else {
      if (keyModeFileBtn) keyModeFileBtn.classList.remove('active');
      if (keyModePasteBtn) keyModePasteBtn.classList.add('active');
      if (gcsFileContainer) gcsFileContainer.style.display = 'none';
      if (gcsJsonContainer) gcsJsonContainer.style.display = 'block';
    }
  }

  if (keyModeFileBtn) keyModeFileBtn.addEventListener('click', function() { setGcsKeyMode('file'); });
  if (keyModePasteBtn) keyModePasteBtn.addEventListener('click', function() { setGcsKeyMode('paste'); });

  if (browseKeyBtn) {
    browseKeyBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'browseKeyFile' });
    });
  }

  function getEffectiveGcsKey() {
    if (gcsKeyMode === 'paste') {
      return (gcsKeyJson ? gcsKeyJson.value.trim() : '') || (gcsKeyFile ? gcsKeyFile.value.trim() : '');
    }
    return (gcsKeyFile ? gcsKeyFile.value.trim() : '') || (gcsKeyJson ? gcsKeyJson.value.trim() : '');
  }

  function clearGcsKeyError() {
    var el = document.getElementById('err-gcs-key');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  }

  function formatOrValidateJson() {
    if (!gcsKeyJson) return;
    var raw = gcsKeyJson.value.trim();
    if (!raw) {
      if (gcsJsonStatus) gcsJsonStatus.textContent = '';
      return;
    }
    if (raw.startsWith('\`\`\`')) {
      raw = raw.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '').trim();
    }
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1).trim();
    }
    try {
      var parsed = JSON.parse(raw);
      gcsKeyJson.value = JSON.stringify(parsed, null, 2);
      if (gcsJsonStatus) {
        gcsJsonStatus.textContent = parsed.client_email ? '✓ Service Account: ' + parsed.client_email : '✓ Valid JSON';
        gcsJsonStatus.style.color = 'var(--vscode-charts-green, #4ec9b0)';
      }
      clearGcsKeyError();
    } catch (err) {
      try {
        var relaxed = raw.replace(/"private_key"\s*:\s*"([^"]*)"/gs, function(_m, keyVal) {
          return '"private_key": "' + keyVal.replace(/\\r?\\n/g, '\\\\n') + '"';
        });
        var parsed2 = JSON.parse(relaxed);
        gcsKeyJson.value = JSON.stringify(parsed2, null, 2);
        if (gcsJsonStatus) {
          gcsJsonStatus.textContent = parsed2.client_email ? '✓ Repaired & formatted for ' + parsed2.client_email : '✓ Valid JSON';
          gcsJsonStatus.style.color = 'var(--vscode-charts-green, #4ec9b0)';
        }
        clearGcsKeyError();
      } catch (err2) {
        if (gcsJsonStatus) {
          gcsJsonStatus.textContent = '⚠ ' + err.message;
          gcsJsonStatus.style.color = 'var(--vscode-errorForeground)';
        }
      }
    }
  }
  if (formatJsonBtn) formatJsonBtn.addEventListener('click', formatOrValidateJson);

  // ── Connection type switch (FR-2, FR-5) ─────────────────────────────────
  function applyGcsAuthType() {
    var isGcs = connType.value === 'gcs';
    var isKey = isGcs && gcsAuthType && gcsAuthType.value === 'serviceAccountKey';
    if (gcsKeyRow) {
      gcsKeyRow.style.display = isKey ? 'block' : 'none';
    }
    if (gcsKeyFile) {
      gcsKeyFile.disabled = !isKey;
    }
    if (gcsKeyJson) {
      gcsKeyJson.disabled = !isKey;
    }
    if (browseKeyBtn) {
      browseKeyBtn.disabled = !isKey;
    }
  }

  function applyType() {
    var isS3 = connType.value === 's3';
    var isGcs = connType.value === 'gcs';

    // Update placeholder and label for warehouse path
    if (isS3) {
      warehousePath.placeholder = 's3://bucket/warehouse-path';
      if (pathLabel) pathLabel.textContent = 'Warehouse path (S3 URI)';
    } else if (isGcs) {
      warehousePath.placeholder = 'gs://bucket/warehouse-path';
      if (pathLabel) pathLabel.textContent = 'Warehouse path (GCS URI)';
    } else {
      warehousePath.placeholder = '/absolute/path/to/warehouse';
      if (pathLabel) pathLabel.textContent = 'Warehouse path';
    }

    var pathNote = document.getElementById('warehouse-path-note');
    if (pathNote) {
      if (isS3) {
        pathNote.innerHTML = 'Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>s3://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.';
        pathNote.style.display = 'block';
      } else if (isGcs) {
        pathNote.innerHTML = 'Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>gs://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.';
        pathNote.style.display = 'block';
      } else {
        pathNote.style.display = 'none';
      }
    }

    // Toggle S3 fields
    if (s3Fields) {
      s3Fields.style.display = isS3 ? 'block' : 'none';
      var s3Inputs = s3Fields.querySelectorAll('input, select');
      s3Inputs.forEach(function(el) {
        el.disabled = !isS3;
      });
    }
    if (credsNote && !isS3) {
      credsNote.style.display = 'none';
    }

    // Toggle GCS fields
    if (gcsFields) {
      gcsFields.style.display = isGcs ? 'block' : 'none';
      var gcsInputs = gcsFields.querySelectorAll('input, select');
      gcsInputs.forEach(function(el) {
        el.disabled = !isGcs;
      });
    }
    applyGcsAuthType();
    if (browserLocalPickerBtn) {
      browserLocalPickerBtn.style.display = connType.value === 'local' ? 'inline-block' : 'none';
    }
    if (warehouseBrowser) {
      warehouseBrowser.style.display = 'none';
    }
    hideSuggestion();
  }

  connType.addEventListener('change', applyType);
  if (gcsAuthType) {
    gcsAuthType.addEventListener('change', applyGcsAuthType);
  }
  applyType(); // apply on load

  // ── Clear button ─────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', function () {
    connId.value       = '';
    connLabel.value    = '';
    warehousePath.value= '';
    endpointUrl.value  = '';
    region.value       = '';
    accessKey.value    = '';
    secretKey.value    = '';
    sslVerify.checked  = true;
    if (gcsAuthType) gcsAuthType.value = 'adc';
    if (gcsKeyFile) gcsKeyFile.value = '';
    if (gcsKeyJson) gcsKeyJson.value = '';
    if (gcsJsonStatus) gcsJsonStatus.textContent = '';
    setGcsKeyMode('file');
    if (gcsProjectId) gcsProjectId.value = '';
    if (gcsCredsNote) gcsCredsNote.style.display = 'none';
    if (formHeading) formHeading.textContent = 'New Connection';
    if (credsNote) {
      credsNote.textContent = '';
      credsNote.style.display = 'none';
    }
    applyGcsAuthType();
    clearErrors();
    hideBanner();
    hideSuggestion();
    if (warehouseBrowser) {
      warehouseBrowser.style.display = 'none';
    }
  });

  if (browseWarehouseBtn) {
    browseWarehouseBtn.addEventListener('click', function() {
      var isS3 = connType.value === 's3';
      var isGcs = connType.value === 'gcs';
      var currentVal = warehousePath.value.trim();

      if (isS3 && (!currentVal || !new RegExp('^s3[an]?://[^/]+', 'i').test(currentVal))) {
        showError('err-path', 'Please enter at least an S3 bucket (e.g. s3://my-bucket) to browse.');
        warehousePath.focus();
        return;
      }
      if (isGcs && (!currentVal || !new RegExp('^(?:gs|gcs)://[^/]+', 'i').test(currentVal))) {
        showError('err-path', 'Please enter at least a GCS bucket (e.g. gs://my-bucket) to browse.');
        warehousePath.focus();
        return;
      }

      clearErrors();
      requestBrowse(currentVal);
    });
  }

  if (detectWarehouseBtn) {
    detectWarehouseBtn.addEventListener('click', function() {
      requestDetect(warehousePath.value.trim());
    });
  }

  if (applySuggestionBtn) {
    applySuggestionBtn.addEventListener('click', function() {
      if (currentSuggestion) {
        warehousePath.value = currentSuggestion;
        hideSuggestion();
        clearErrors();
        hideBanner();
      }
    });
  }

  if (browserCloseBtn) {
    browserCloseBtn.addEventListener('click', function() {
      if (warehouseBrowser) warehouseBrowser.style.display = 'none';
    });
  }

  if (browserUpBtn) {
    browserUpBtn.addEventListener('click', function() {
      if (currentParentPath) {
        requestBrowse(currentParentPath);
      }
    });
  }

  if (browserRefreshBtn) {
    browserRefreshBtn.addEventListener('click', function() {
      requestBrowse(currentBrowsedPath || warehousePath.value.trim());
    });
  }

  if (browserLocalPickerBtn) {
    browserLocalPickerBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'browseWarehouseFolderDialog' });
    });
  }

  if (browserSelectBtn) {
    browserSelectBtn.addEventListener('click', function() {
      if (currentSelectedPath) {
        warehousePath.value = currentSelectedPath;
        if (warehouseBrowser) warehouseBrowser.style.display = 'none';
        clearErrors();
        hideSuggestion();
      }
    });
  }

  // ── Validation helpers ────────────────────────────────────────────────────
  function showError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
  }
  function clearErrors() {
    document.querySelectorAll('.field-error').forEach(function(el) {
      el.textContent = '';
      el.classList.remove('visible');
    });
  }
  function showBanner(msg, isError, connectId) {
    if (statusBannerText) {
      statusBannerText.textContent = msg;
    } else if (statusBanner) {
      statusBanner.textContent = msg;
    }
    if (statusBanner) {
      statusBanner.className = isError ? 'error' : 'success';
    }
    if (bannerConnectBtn) {
      if (!isError && connectId) {
        bannerConnectBtn.dataset.connId = connectId;
        bannerConnectBtn.style.display = 'inline-block';
        bannerConnectBtn.disabled = false;
        bannerConnectBtn.textContent = 'Connect';
      } else {
        bannerConnectBtn.style.display = 'none';
        delete bannerConnectBtn.dataset.connId;
      }
    }
    if (statusBanner) {
      statusBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  function hideBanner() {
    if (statusBanner) statusBanner.className = '';
    if (statusBannerText) statusBannerText.textContent = '';
    if (bannerConnectBtn) {
      bannerConnectBtn.style.display = 'none';
      delete bannerConnectBtn.dataset.connId;
    }
  }

  if (bannerConnectBtn) {
    bannerConnectBtn.addEventListener('click', function () {
      var idToConnect = bannerConnectBtn.dataset.connId;
      if (idToConnect) {
        bannerConnectBtn.disabled = true;
        bannerConnectBtn.textContent = 'Connecting...';
        vscode.postMessage({
          type: 'activateConnection',
          id: idToConnect,
        });
      }
    });
  }

  // ── Save Connection ────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', function () {
    clearErrors();
    hideBanner();

    var isS3  = connType.value === 's3';
    var isGcs = connType.value === 'gcs';
    var label = connLabel.value.trim();
    var path  = warehousePath.value.trim();
    var valid = true;

    if (!label) {
      showError('err-label', 'Connection name is required.');
      valid = false;
    } else {
      var currentId = connId.value || '';
      var isDuplicate = existingConnections.some(function(c) {
        return c.id !== currentId && c.label.trim().toLowerCase() === label.toLowerCase();
      });
      if (isDuplicate) {
        showError('err-label', 'A connection with the name "' + label + '" already exists.');
        valid = false;
      }
    }
    if (!path) {
      showError('err-path', isS3 ? 'Warehouse path (S3 URI) is required.' : isGcs ? 'Warehouse path (GCS URI) is required.' : 'Warehouse path is required.');
      valid = false;
    } else if (!isS3 && !isGcs && !(path.startsWith('/') || (path.length >= 3 && /^[a-zA-Z]$/.test(path[0]) && path[1] === ':' && (path[2] === '/' || path[2] === '\\\\')) || path.startsWith('\\\\\\\\'))) {
      showError('err-path', 'Warehouse path must be an absolute path (starting with / or a drive letter like C:\\\\).');
      valid = false;
    } else if (isS3 && !new RegExp('^s3[an]?://[^/]+', 'i').test(path)) {
      showError('err-path', 'Warehouse path must be a valid S3 URI (e.g. s3://bucket/warehouse-path).');
      valid = false;
    } else if (isGcs && !new RegExp('^(?:gs|gcs)://[^/]+', 'i').test(path)) {
      showError('err-path', 'Warehouse path must be a valid GCS URI (e.g. gs://bucket/warehouse-path).');
      valid = false;
    }

    if (isS3) {
      var ep = endpointUrl.value.trim();
      if (ep) {
        try {
          var parsedUrl = new URL(ep);
          if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
            showError('err-endpoint', 'Endpoint URL must use https or http scheme.');
            valid = false;
          }
        } catch (e) {
          showError('err-endpoint', 'Endpoint URL is not a valid URL.');
          valid = false;
        }
      }
      if (!region.value.trim()) {
        showError('err-region', 'Region is required for S3 connections.');
        valid = false;
      }
      if (!accessKey.value.trim()) {
        showError('err-access-key', 'Access key is required for S3 connections.');
        valid = false;
      }
      if (!secretKey.value.trim()) {
        showError('err-secret-key', 'Secret key is required for S3 connections.');
        valid = false;
      }
    }

    if (isGcs) {
      if (gcsAuthType && gcsAuthType.value === 'serviceAccountKey') {
        var keyVal = getEffectiveGcsKey();
        if (!keyVal) {
          showError('err-gcs-key', 'Service account key JSON or file path is required.');
          valid = false;
        }
      }
    }

    if (!valid) return;

    var gcsSecret = isGcs && gcsAuthType && gcsAuthType.value === 'serviceAccountKey' ? getEffectiveGcsKey() : undefined;

    // Send to extension host — credentials travel only in this message and are
    // immediately stored in SecretStorage by ConnectionManager (FR-3, NFR-7).
    vscode.postMessage({
      type: 'saveConnection',
      id:              connId.value || undefined,
      connectionType:  connType.value,
      label:           label,
      warehousePath:   path,
      endpointUrl:     isS3 && endpointUrl.value.trim() ? endpointUrl.value.trim() : undefined,
      region:          isS3 ? region.value.trim() : undefined,
      accessKey:       isS3 ? accessKey.value.trim() : undefined,
      secretKey:       isS3 ? secretKey.value.trim() : gcsSecret,
      sslVerification: isS3 ? sslVerify.checked : true,
      gcsAuthType:     isGcs && gcsAuthType ? gcsAuthType.value : undefined,
      projectId:       isGcs && gcsProjectId && gcsProjectId.value.trim() ? gcsProjectId.value.trim() : undefined,
    });

    // Note: Credential fields are kept until saveSuccess to prevent losing input on errors.
  });

  const MASK_VALUE = '••••••••';
  function handleMaskFocus(el) {
    if (el.value === MASK_VALUE || el.value === '********') {
      el.select();
    }
  }
  accessKey.addEventListener('focus', function () { handleMaskFocus(accessKey); });
  secretKey.addEventListener('focus', function () { handleMaskFocus(secretKey); });
  if (gcsKeyFile) {
    gcsKeyFile.addEventListener('focus', function () { handleMaskFocus(gcsKeyFile); });
    gcsKeyFile.addEventListener('input', function () {
      var val = gcsKeyFile.value.trim();
      if (val.startsWith('{')) {
        if (gcsKeyJson) gcsKeyJson.value = gcsKeyFile.value;
        gcsKeyFile.value = '';
        setGcsKeyMode('paste');
        formatOrValidateJson();
      }
      clearGcsKeyError();
    });
  }
  if (gcsKeyJson) {
    gcsKeyJson.addEventListener('input', function () {
      var val = gcsKeyJson.value.trim();
      if ((val.startsWith('/') || val.startsWith('~/')) && !val.includes('\\n')) {
        if (gcsKeyFile) gcsKeyFile.value = val;
        gcsKeyJson.value = '';
        setGcsKeyMode('file');
      }
      clearGcsKeyError();
    });
  }
  if (gcsProjectId) {
    gcsProjectId.addEventListener('input', function () {
      var el = document.getElementById('err-gcs-project');
      if (el) {
        el.textContent = '';
        el.classList.remove('visible');
      }
    });
  }

  // Clear field errors when the user types
  connLabel.addEventListener('input', function () {
    var el = document.getElementById('err-label');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });
  warehousePath.addEventListener('input', function () {
    var el = document.getElementById('err-path');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });
  endpointUrl.addEventListener('input', function () {
    var el = document.getElementById('err-endpoint');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });
  region.addEventListener('input', function () {
    var el = document.getElementById('err-region');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });
  accessKey.addEventListener('input', function () {
    var el = document.getElementById('err-access-key');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });
  secretKey.addEventListener('input', function () {
    var el = document.getElementById('err-secret-key');
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
  });

  // ── Messages from extension host ─────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'setExistingConnections':
        if (Array.isArray(msg.connections)) {
          existingConnections = msg.connections;
        }
        break;
      case 'keyFileSelected':
        if (gcsKeyFile && msg.filePath) {
          gcsKeyFile.value = msg.filePath;
          setGcsKeyMode('file');
          clearGcsKeyError();
        }
        break;
      case 'saveSuccess':
        showBanner('Connection saved.', false, msg.connectionId);
        if (Array.isArray(msg.connections)) {
          existingConnections = msg.connections;
        }
        // Reset form to "New Connection" state after a successful save
        connId.value = '';
        accessKey.value = '';
        secretKey.value = '';
        if (gcsKeyFile) gcsKeyFile.value = '';
        if (gcsKeyJson) gcsKeyJson.value = '';
        if (gcsJsonStatus) gcsJsonStatus.textContent = '';
        setGcsKeyMode('file');
        if (formHeading) formHeading.textContent = 'New Connection';
        if (credsNote) {
          credsNote.textContent = '';
          credsNote.style.display = 'none';
        }
        if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        break;
      case 'saveError':
        showBanner(msg.message || 'Failed to save connection.', true);
        if (connId.value && connType.value === 's3' && !accessKey.value && !secretKey.value) {
          accessKey.value = MASK_VALUE;
          secretKey.value = MASK_VALUE;
        }
        if (msg.suggestedWarehousePath) {
          showSuggestion(msg.suggestedWarehousePath);
        }
        if (msg.message && (msg.message.includes('label:') || msg.message.toLowerCase().includes('already exists'))) {
          var labelMsg = msg.message;
          if (labelMsg.includes('label:')) {
            labelMsg = labelMsg.split('label:')[1].trim();
          } else if (labelMsg.startsWith('Validation failed:')) {
            labelMsg = labelMsg.replace('Validation failed:', '').trim();
          }
          showError('err-label', labelMsg);
        }
        if (msg.message && (msg.message.includes('warehousePath:') || msg.message.toLowerCase().includes('warehouse path'))) {
          var pathMsg = msg.message;
          if (pathMsg.includes('warehousePath:')) {
            pathMsg = pathMsg.split('warehousePath:')[1].trim();
          } else if (pathMsg.startsWith('Validation failed:')) {
            pathMsg = pathMsg.replace('Validation failed:', '').trim();
          }
          showError('err-path', pathMsg);
        }
        if (msg.message && (msg.message.toLowerCase().includes('service account') || msg.message.toLowerCase().includes('key file') || msg.message.toLowerCase().includes('json') || msg.message.includes('secretKey:'))) {
          showError('err-gcs-key', msg.message);
        }
        break;

      case 'browseDirectoryResult':
        if (msg.error) {
          setBrowserStatus(msg.error, true);
          if (browserList) {
            browserList.innerHTML = '<div class="browser-list-empty">' + escapeHtml(msg.error) + '</div>';
          }
        } else {
          setBrowserStatus('', false);
          currentBrowsedPath = msg.currentPath || '';
          currentParentPath = msg.parentPath || null;
          if (browserCurrentPath) {
            browserCurrentPath.textContent = currentBrowsedPath;
            browserCurrentPath.title = currentBrowsedPath;
          }
          if (browserUpBtn) {
            browserUpBtn.disabled = !currentParentPath;
          }
          setSelectedPath(currentBrowsedPath);

          if (browserList) {
            browserList.innerHTML = '';
            var items = Array.isArray(msg.items) ? msg.items : [];
            if (items.length === 0) {
              browserList.innerHTML = '<div class="browser-list-empty">No subdirectories found in this path.</div>';
            } else {
              items.forEach(function(item) {
                var row = document.createElement('div');
                row.className = 'browser-item';

                var left = document.createElement('div');
                left.className = 'browser-item-left';

                var icon = document.createElement('span');
                icon.className = 'browser-item-icon';
                icon.textContent = item.isTable ? '🧊' : (item.isSchema ? '🗄️' : '📁');
                left.appendChild(icon);

                var name = document.createElement('span');
                name.className = 'browser-item-name';
                name.textContent = item.name + '/';
                left.appendChild(name);

                row.appendChild(left);

                var right = document.createElement('div');
                right.className = 'browser-item-right';

                if (item.isTable) {
                  var badge = document.createElement('span');
                  badge.className = 'browser-item-badge browser-badge-table';
                  badge.textContent = 'Table';
                  right.appendChild(badge);
                } else if (item.isSchema) {
                  var badge2 = document.createElement('span');
                  badge2.className = 'browser-item-badge browser-badge-schema';
                  badge2.textContent = 'Schema';
                  right.appendChild(badge2);
                }

                var drillBtn = document.createElement('button');
                drillBtn.type = 'button';
                drillBtn.className = 'secondary browser-drill-btn';
                drillBtn.textContent = 'Open →';
                drillBtn.title = 'Explore inside ' + item.name;
                drillBtn.addEventListener('click', function(e) {
                  e.stopPropagation();
                  requestBrowse(item.path);
                });
                right.appendChild(drillBtn);

                row.appendChild(right);

                row.addEventListener('click', function() {
                  document.querySelectorAll('.browser-item').forEach(function(el) {
                    el.classList.remove('selected');
                  });
                  row.classList.add('selected');
                  setSelectedPath(item.path);
                });

                row.addEventListener('dblclick', function() {
                  requestBrowse(item.path);
                });

                browserList.appendChild(row);
              });
            }
          }
        }
        break;

      case 'detectWarehouseResult':
        if (msg.error) {
          showBanner(msg.error, true);
        } else if (Array.isArray(msg.suggestedPaths) && msg.suggestedPaths.length > 0) {
          showSuggestion(msg.suggestedPaths[0]);
          showBanner('Detected Iceberg warehouse: ' + msg.suggestedPaths[0], false);
        } else {
          showBanner('No Iceberg tables detected under this path. Use Browse to navigate.', true);
        }
        break;

      case 'warehousePathSelected':
        if (warehousePath && msg.path) {
          warehousePath.value = msg.path;
          clearErrors();
          hideSuggestion();
          if (warehouseBrowser) warehouseBrowser.style.display = 'none';
        }
        break;
      case 'activateSuccess':
        if (bannerConnectBtn) {
          bannerConnectBtn.disabled = false;
          bannerConnectBtn.textContent = 'Connect';
        }
        showBanner('Connection activated.', false);
        break;
      case 'activateError':
        if (bannerConnectBtn) {
          bannerConnectBtn.disabled = false;
          bannerConnectBtn.textContent = 'Connect';
        }
        showBanner(msg.message || 'Could not activate connection.', true);
        break;
      case 'deleteSuccess':
        showBanner('Connection deleted.', false);
        if (msg.id) {
          existingConnections = existingConnections.filter(function(c) { return c.id !== msg.id; });
        }
        break;
      case 'deleteError':
        showBanner(msg.message || 'Could not delete connection.', true);
        break;
      case 'editConnection':
        // Pre-fill form fields from msg.config
        connType.value         = msg.config.connectionType;
        connLabel.value        = msg.config.label;
        warehousePath.value    = msg.config.warehousePath;
        endpointUrl.value      = msg.config.endpointUrl || '';
        region.value           = msg.config.region || '';
        connId.value           = msg.config.id;
        if (sslVerify && msg.config.sslVerification !== undefined) {
          sslVerify.checked    = msg.config.sslVerification !== false;
        }
        if (formHeading) formHeading.textContent = 'Edit Connection';
        if (msg.config.connectionType === 's3' && msg.hasSavedCredentials) {
          accessKey.value = MASK_VALUE;
          secretKey.value = MASK_VALUE;
          if (credsNote) {
            credsNote.textContent = 'Existing credentials are saved. Enter new values only to update credentials.';
            credsNote.style.display = 'block';
          }
          if (gcsKeyFile) gcsKeyFile.value = '';
          if (gcsKeyJson) gcsKeyJson.value = '';
          if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        } else if (msg.config.connectionType === 'gcs') {
          accessKey.value = '';
          secretKey.value = '';
          if (credsNote) credsNote.style.display = 'none';
          if (gcsAuthType) {
            gcsAuthType.value = msg.config.gcsAuthType || 'adc';
          }
          if (gcsProjectId) {
            gcsProjectId.value = msg.config.projectId || '';
          }
          if (msg.config.gcsAuthType === 'serviceAccountKey' && msg.hasSavedCredentials) {
            if (gcsKeyFile) gcsKeyFile.value = MASK_VALUE;
            if (gcsKeyJson) gcsKeyJson.value = '';
            setGcsKeyMode('file');
            if (gcsCredsNote) {
              gcsCredsNote.textContent = 'Existing service account key is saved. Enter a new value only to update credentials.';
              gcsCredsNote.style.display = 'block';
            }
          } else {
            if (gcsKeyFile) gcsKeyFile.value = '';
            if (gcsKeyJson) gcsKeyJson.value = '';
            if (gcsCredsNote) gcsCredsNote.style.display = 'none';
          }
        } else {
          accessKey.value = '';
          secretKey.value = '';
          if (credsNote) {
            credsNote.textContent = '';
            credsNote.style.display = 'none';
          }
          if (gcsKeyFile) gcsKeyFile.value = '';
          if (gcsKeyJson) gcsKeyJson.value = '';
          if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        }
        applyType();
        break;
    }
  });

}());
</script>
</body>
</html>`;
}
