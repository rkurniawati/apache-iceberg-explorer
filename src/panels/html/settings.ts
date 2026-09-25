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
export function getSettingsHtml(
  nonce: string,
  cspSource: string,
  initialConnections: Array<{ id: string; label: string }> = [],
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Iceberg Explorer — Settings</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 1rem 1.25rem 2rem;
      max-width: 640px;
    }
    h1 { font-size: 1.1em; font-weight: 700; margin: 0 0 1rem; }
    h2 { font-size: 0.95em; font-weight: 700; margin: 1.25rem 0 0.5rem;
         border-bottom: 1px solid var(--vscode-editorWidget-border); padding-bottom: 0.25rem; }

    /* Form layout */
    .field { margin-bottom: 0.75rem; }
    label  { display: block; font-weight: 600; margin-bottom: 0.2rem; }
    input[type="text"],
    input[type="password"],
    select {
      width: 100%;
      padding: 0.3rem 0.5rem;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
      border-radius: 2px;
      font: inherit;
    }
    input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    input:disabled, select:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* Toggle row */
    .toggle-row { display: flex; align-items: center; gap: 0.5rem; }
    .toggle-row input[type="checkbox"] { width: auto; cursor: pointer; }
    .toggle-row label { font-weight: 400; margin: 0; cursor: pointer; }

    /* Inline field error */
    .field-error { color: var(--vscode-errorForeground); font-size: 0.88em; margin-top: 0.2rem; display: none; }
    .field-error.visible { display: block; }

    /* Edit credentials note */
    .creds-note {
      font-size: 0.88em;
      opacity: 0.7;
      font-style: italic;
      margin-bottom: 0.4rem;
    }

    /* Buttons */
    .btn-row { margin-top: 1rem; display: flex; gap: 0.5rem; }
    button.primary {
      padding: 0.35rem 1rem;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 2px; cursor: pointer; font: inherit; font-weight: 600;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      padding: 0.35rem 1rem;
      background: var(--vscode-button-secondaryBackground, var(--vscode-badge-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
      border: none; border-radius: 2px; cursor: pointer; font: inherit;
    }
    button.secondary:hover { opacity: 0.85; }

    /* Status banner */
    #status-banner {
      display: none;
      padding: 0.5rem 0.75rem;
      border-radius: 3px;
      margin-bottom: 0.75rem;
    }
    #status-banner.success {
      display: block;
      background: var(--vscode-notificationsInfoBackground, var(--vscode-badge-background));
      color: var(--vscode-notificationsInfoForeground, var(--vscode-badge-foreground));
      border: 1px solid var(--vscode-editorWidget-border);
    }
    #status-banner.error {
      display: block;
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-errorForeground);
    }
  </style>
</head>
<body>

<h1>Iceberg Explorer — Connection Settings</h1>

<div id="status-banner"></div>

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
    </select>
  </div>

  <!-- Label -->
  <div class="field">
    <label for="conn-label">Connection name</label>
    <input id="conn-label" type="text" placeholder="e.g. My Warehouse" autocomplete="off">
    <div class="field-error" id="err-label"></div>
  </div>

  <!-- Warehouse path (local) / S3 URI (S3) -->
  <div class="field">
    <label for="warehouse-path" id="warehouse-path-label">Warehouse path</label>
    <input id="warehouse-path" type="text" placeholder="/absolute/path/to/warehouse" autocomplete="off">
    <p id="warehouse-path-note" class="creds-note" style="display:none; margin-top:0.3rem;">
      Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>s3://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.
    </p>
    <div class="field-error" id="err-path"></div>
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

  <div class="btn-row">
    <button class="primary" id="save-btn" type="button">Save &amp; Connect</button>
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
  const connId       = /** @type {HTMLInputElement}    */ (document.getElementById('conn-id'));
  const formHeading  = document.getElementById('form-heading');
  const credsNote    = document.getElementById('creds-note');
  const saveBtn      = document.getElementById('save-btn');
  const clearBtn     = document.getElementById('clear-btn');
  const statusBanner = document.getElementById('status-banner');

  // ── Connection type switch (FR-2, FR-5) ─────────────────────────────────
  function applyType() {
    var isS3 = connType.value === 's3';
    // Update placeholder and label for warehouse path
    warehousePath.placeholder = isS3 ? 's3://bucket/warehouse-path' : '/absolute/path/to/warehouse';
    if (pathLabel) pathLabel.textContent = isS3 ? 'Warehouse path (S3 URI)' : 'Warehouse path';
    var pathNote = document.getElementById('warehouse-path-note');
    if (pathNote) {
      pathNote.style.display = isS3 ? 'block' : 'none';
    }
    // Disable S3 inputs when not in S3 mode (FR-5)
    var inputs = s3Fields ? s3Fields.querySelectorAll('input, select') : [];
    inputs.forEach(function(el) {
      el.disabled = !isS3;
    });
    if (credsNote && !isS3) {
      credsNote.style.display = 'none';
    }
  }

  connType.addEventListener('change', applyType);
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
    if (formHeading) formHeading.textContent = 'New Connection';
    if (credsNote) {
      credsNote.textContent = '';
      credsNote.style.display = 'none';
    }
    clearErrors();
    hideBanner();
  });

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
  function showBanner(msg, isError) {
    statusBanner.textContent = msg;
    statusBanner.className   = isError ? 'error' : 'success';
    statusBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideBanner() {
    statusBanner.className = '';
    statusBanner.textContent = '';
  }

  // ── Save & Connect ────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', function () {
    clearErrors();
    hideBanner();

    var isS3  = connType.value === 's3';
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
      showError('err-path', isS3 ? 'Warehouse path (S3 URI) is required.' : 'Warehouse path is required.');
      valid = false;
    } else if (!isS3 && !path.startsWith('/')) {
      showError('err-path', 'Warehouse path must be an absolute path (starting with /).');
      valid = false;
    } else if (isS3 && !new RegExp('^s3[an]?://[^/]+', 'i').test(path)) {
      showError('err-path', 'Warehouse path must be a valid S3 URI (e.g. s3://bucket/warehouse-path).');
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

    if (!valid) return;

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
      secretKey:       isS3 ? secretKey.value.trim() : undefined,
      sslVerification: isS3 ? sslVerify.checked : true,
    });

    // Wipe credential fields immediately after sending (FR-3)
    accessKey.value = '';
    secretKey.value = '';
  });

  const MASK_VALUE = '••••••••';
  function handleMaskFocus(el) {
    if (el.value === MASK_VALUE || el.value === '********') {
      el.select();
    }
  }
  accessKey.addEventListener('focus', function () { handleMaskFocus(accessKey); });
  secretKey.addEventListener('focus', function () { handleMaskFocus(secretKey); });

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
      case 'saveSuccess':
        showBanner('Connection saved and activated.', false);
        if (Array.isArray(msg.connections)) {
          existingConnections = msg.connections;
        }
        // Reset form to "New Connection" state after a successful save
        connId.value = '';
        accessKey.value = '';
        secretKey.value = '';
        if (formHeading) formHeading.textContent = 'New Connection';
        if (credsNote) {
          credsNote.textContent = '';
          credsNote.style.display = 'none';
        }
        break;
      case 'saveError':
        showBanner(msg.message || 'Failed to save connection.', true);
        if (connId.value && connType.value === 's3' && !accessKey.value && !secretKey.value) {
          accessKey.value = MASK_VALUE;
          secretKey.value = MASK_VALUE;
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
        break;
      case 'activateSuccess':
        showBanner('Connection activated.', false);
        break;
      case 'activateError':
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
        } else {
          accessKey.value = '';
          secretKey.value = '';
          if (credsNote) {
            credsNote.textContent = '';
            credsNote.style.display = 'none';
          }
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
