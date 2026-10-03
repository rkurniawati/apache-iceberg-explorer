/**
 * Metadata Detail Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  T-18  HTML shell with CSP nonce and theme variables  (NFR-8, NFR-9)
 *  T-19  Table Identity & Versioning section            (FR-10a, FR-10i)
 *  T-20  Schema Information section                     (FR-10b)
 *  T-21  Partitioning section                           (FR-10c)
 *  T-22  Sort Orders section                            (FR-10d)
 *  T-23  Snapshots section                              (FR-10e)
 *  T-24  Refs section                                   (FR-10f)
 *  T-25  Table Properties section                       (FR-10g)
 *  T-26  format-version–aware field omission            (FR-10h, A-8)
 *  T-27  Breadcrumb bar                                 (FR-18)
 *  T-28  Panel state machine and error surface          (FR-20, design.md §2.3)
 */
import * as crypto from 'node:crypto';

/**
 * Generate a cryptographically random nonce for the CSP header.
 * A fresh value is produced on every call (T-18, NFR-8).
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Produce the static HTML shell for the metadata detail panel.
 *
 * @param nonce      Per-load CSP nonce (applied to every <script> tag).
 * @param cspSource  Value of webview.cspSource (for img-src).
 *
 * NFR-8: CSP nonce on all scripts; no external CDN URLs.
 * NFR-9: All colours use --vscode-* variables; zero hardcoded hex/RGB values.
 */
export function getMetadataDetailHtml(
  nonce: string,
  cspSource: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Detail</title>
  <style>
    /* All colours reference VS Code CSS custom properties — no hardcoded values. (NFR-9) */
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0 1rem 2rem;
    }

    /* ── Breadcrumb ─────────────────────────────────────────────────────── */
    #breadcrumb {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      margin-bottom: 0.75rem;
      font-size: 0.9em;
      color: var(--vscode-editor-foreground);
    }
    .breadcrumb-sep {
      color: var(--vscode-editor-foreground);
      opacity: 0.5;
    }
    .breadcrumb-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
    }
    .breadcrumb-link:hover { opacity: 0.8; }
    .breadcrumb-current { color: var(--vscode-editor-foreground); font-weight: 600; }

    /* ── Format-version badge ───────────────────────────────────────────── */
    #format-version-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.2rem 0.6rem;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      font-size: 0.85em;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }

    /* ── Sections ───────────────────────────────────────────────────────── */
    .section {
      margin-bottom: 1.5rem;
    }
    .section-heading {
      font-size: 1em;
      font-weight: 700;
      margin: 0 0 0.5rem;
      padding-bottom: 0.25rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      color: var(--vscode-editor-foreground);
    }
    .section-heading .badge-active {
      display: inline-block;
      margin-left: 0.5rem;
      padding: 0.1em 0.4em;
      font-size: 0.78em;
      font-weight: 600;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      vertical-align: middle;
    }

    /* ── Key-value list (identity fields) ─────────────────────────────── */
    .kv-list {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.2rem 1rem;
      margin: 0;
    }
    .kv-key {
      font-weight: 600;
      white-space: nowrap;
      color: var(--vscode-editor-foreground);
    }
    .kv-value {
      word-break: break-all;
      color: var(--vscode-editor-foreground);
    }

    /* ── Tables ─────────────────────────────────────────────────────────── */
    .data-table {
      border-collapse: collapse;
      width: 100%;
      font-size: 0.9em;
    }
    .data-table th {
      text-align: left;
      padding: 0.3rem 0.5rem;
      border-bottom: 2px solid var(--vscode-editorWidget-border);
      font-weight: 700;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      white-space: nowrap;
    }
    .data-table td {
      padding: 0.25rem 0.5rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      vertical-align: top;
      word-break: break-word;
      color: var(--vscode-editor-foreground);
    }
    .data-table tr:last-child td { border-bottom: none; }

    /* ── Manifest-list link (T-23) ──────────────────────────────────────── */
    .manifest-list-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      text-align: left;
    }
    .manifest-list-link:hover { opacity: 0.8; }

    /* Nested summary sub-table */
    .sub-table { margin: 0.25rem 0 0.25rem 1rem; }

    /* Scrollable properties table wrapper */
    .table-scroll { overflow-x: auto; }

    /* ── Loading indicator ──────────────────────────────────────────────── */
    #loading-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 1rem 0;
      color: var(--vscode-editor-foreground);
    }
    .spinner {
      width: 1rem;
      height: 1rem;
      border: 2px solid var(--vscode-editorWidget-border);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Error area ─────────────────────────────────────────────────────── */
    #error-area {
      display: none;
      padding: 1rem;
      border: 1px solid var(--vscode-errorForeground);
      border-radius: 4px;
      color: var(--vscode-errorForeground);
      margin: 1rem 0;
    }
    #error-area p { margin: 0 0 0.5rem; }
    #error-retry-btn {
      padding: 0.3rem 0.8rem;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    #error-retry-btn:hover { opacity: 0.85; }

    /* ── Content area ───────────────────────────────────────────────────── */
    #content-area { display: none; }

    .empty-msg {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
      font-style: italic;
    }
  </style>
</head>
<body>

  <!-- FR-18: Breadcrumb bar — populated by webview script once resourcePath is known -->
  <div id="breadcrumb" aria-label="Navigation breadcrumb"></div>

  <!-- FR-10i: Format-version badge — prominently placed above all sections -->
  <div id="format-version-badge" style="display:none"></div>

  <!-- Loading / error / content states (design.md §2.3) -->
  <div id="loading-indicator" aria-live="polite">
    <div class="spinner" role="status" aria-label="Loading\u2026"></div>
    <span>Loading metadata\u2026</span>
  </div>

  <!-- FR-20: Error area — static message strings, no raw exception text -->
  <div id="error-area" role="alert">
    <p id="error-message"></p>
    <button id="error-retry-btn" type="button">Retry</button>
  </div>

  <!-- Populated by section renderers when state transitions to 'loaded' -->
    <div id="section-identity"      class="section"></div>
    <div id="section-view-sql"      class="section" style="display:none;"></div>
    <div id="section-view-versions" class="section" style="display:none;"></div>
    <div id="section-schemas"       class="section"></div>
    <div id="section-partitioning"  class="section"></div>
    <div id="section-sort-orders"   class="section"></div>
    <div id="section-snapshots"     class="section"></div>
    <div id="section-refs"          class="section"></div>
    <div id="section-properties"    class="section"></div>
  </div>

<script nonce="${nonce}">
(function () {
  'use strict';

  // ── VS Code API ──────────────────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── State machine ────────────────────────────────────────────────────────
  // Valid states: idle | loading | loaded | error | cancelled  (design.md §2.3.1)
  let currentState = 'idle';

  const elLoading   = document.getElementById('loading-indicator');
  const elError     = document.getElementById('error-area');
  const elContent   = document.getElementById('content-area');
  const elErrorMsg  = document.getElementById('error-message');
  const elRetryBtn  = document.getElementById('error-retry-btn');
  const elFmtBadge  = document.getElementById('format-version-badge');
  const elBreadcrumb = document.getElementById('breadcrumb');

  // Map error classes to the exact static strings from design.md §2.5.2
  const ERROR_MESSAGES = {
    'access-denied': 'Access denied. Check your connection credentials and permissions.',
    'not-found':     'File not found. The resource may have been deleted or moved.',
    'parse-failure': 'Could not read file. The file may be corrupted or in an unsupported format.',
    'timeout':       'Query timed out after 30 seconds. Try a more specific query or a smaller file.',
    'cancelled':     'Operation cancelled.',
    'internal':      'An unexpected error occurred. Please try again.',
  };

  function setState(state) {
    currentState = state;
    elLoading.style.display = state === 'loading' ? 'flex'  : 'none';
    elError.style.display   = state === 'error'   ? 'block' : 'none';
    elContent.style.display = state === 'loaded'  ? 'block' : 'none';
  }

  // Retry button posts a 'retry' message to the host (T-28)
  elRetryBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'retry' });
  });

  // Manifest-list link in Snapshots table → open manifest list panel (T-23)
  document.getElementById('section-snapshots').addEventListener('click', function (e) {
    var btn = e.target.closest('.manifest-list-link');
    if (btn) {
      vscode.postMessage({ type: 'openManifestList', resourcePath: btn.dataset.path });
    }
  });

  const previousState = vscode.getState();
  if (previousState?.type === 'loadMetadata' && previousState.payload) {
    try {
      renderAll(previousState.payload, previousState.resourcePath);
      setState('loaded');
    } catch (_) {}
  } else if (previousState?.type === 'setState' && previousState.state === 'error') {
    elErrorMsg.textContent = ERROR_MESSAGES[previousState.errorClass] || ERROR_MESSAGES['internal'];
    setState('error');
  }

  // ── Message listener ─────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || !msg.type) { return; }

    switch (msg.type) {
      case 'setState':
        if (msg.state === 'loading') {
          if (!vscode.getState() || vscode.getState().type !== 'loadMetadata') {
            setState('loading');
          }
        } else if (msg.state === 'error') {
          vscode.setState(msg);
          elErrorMsg.textContent = ERROR_MESSAGES[msg.errorClass] || ERROR_MESSAGES['internal'];
          setState('error');
        }
        break;

      case 'loadMetadata':
        vscode.setState({ type: 'loadMetadata', payload: msg.payload, resourcePath: msg.resourcePath });
        try {
          renderAll(msg.payload, msg.resourcePath);
          setState('loaded');
        } catch (err) {
          console.error('Failed to render metadata detail:', err);
          elErrorMsg.textContent = 'Failed to display metadata details.';
          setState('error');
        }
        break;
    }
  });

  // Signal readiness now that the message listener is registered (MEDIUM-1)
  vscode.postMessage({ type: 'webviewReady' });

  // ── Breadcrumb rendering (FR-18, T-27) ──────────────────────────────────

  function renderBreadcrumb(resourcePath) {
    if (!resourcePath) { return; }
    const segments = resourcePathToBreadcrumbs(resourcePath);
    elBreadcrumb.innerHTML = '';
    segments.forEach(function (seg, idx) {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '\u203a';
        elBreadcrumb.appendChild(sep);
      }
      const isLast = idx === segments.length - 1;
      if (isLast) {
        const span = document.createElement('span');
        span.className = 'breadcrumb-current';
        span.textContent = seg;
        elBreadcrumb.appendChild(span);
      } else {
        const btn = document.createElement('button');
        btn.className = 'breadcrumb-link';
        btn.textContent = seg;
        btn.type = 'button';
        const capturedIdx = idx;
        btn.addEventListener('click', function () {
          vscode.postMessage({ type: 'breadcrumbNavigate', segment: capturedIdx });
        });
        elBreadcrumb.appendChild(btn);
      }
    });
  }

  function resourcePathToBreadcrumbs(resourcePath) {
    var normalised = resourcePath.split('\\\\').join('/').replace(new RegExp('^s3[an]?://', 'i'), 's3://').replace(new RegExp('^gcs://', 'i'), 'gs://');
    var parts;
    if (normalised.startsWith('s3://') || normalised.startsWith('gs://')) {
      var schemeLen = normalised.startsWith('s3://') ? 's3://'.length : 'gs://'.length;
      var withoutScheme = normalised.slice(schemeLen);
      parts = withoutScheme.split('/').filter(Boolean);
      var metaIdx = parts.lastIndexOf('metadata');
      if (metaIdx >= 3) {
        return [
          parts.slice(0, metaIdx - 2).join('/'),
          parts[metaIdx - 2],
          parts[metaIdx - 1],
          parts[parts.length - 1],
        ];
      }
      var tail = parts.slice(-4);
      return tail.length === 4 ? tail : parts;
    }
    parts = normalised.split('/').filter(Boolean);
    var metaIdx2 = parts.lastIndexOf('metadata');
    if (metaIdx2 >= 2) {
      return [
        '/' + parts.slice(0, metaIdx2 - 2).join('/'),
        parts[metaIdx2 - 2],
        parts[metaIdx2 - 1],
        parts[parts.length - 1],
      ];
    }
    var t = parts.slice(-4);
    var rootParts = parts.slice(0, parts.length - t.length);
    var root = rootParts.length > 0 ? '/' + rootParts.join('/') : '/';
    return t.length >= 2 ? [root].concat(t.slice(-3)) : [root].concat(t);
  }

  // ── Master render coordinator ────────────────────────────────────────────

  function renderAll(payload, resourcePath) {
    renderBreadcrumb(resourcePath);
    renderFormatVersionBadge(payload);
    renderIdentity(payload);
    renderViewSql(payload);
    renderViewVersions(payload);
    renderSchemas(payload);
    renderPartitioning(payload);
    renderSortOrders(payload);
    renderSnapshots(payload);
    renderRefs(payload);
    renderProperties(payload);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMs(ms) {
    try { return new Date(ms).toLocaleString(); }
    catch (_) { return String(ms); }
  }

  function sectionHeading(title, isActive, activeLabel) {
    var badge = (isActive && activeLabel)
      ? '<span class="badge-active">' + esc(activeLabel) + '</span>'
      : '';
    return '<h2 class="section-heading">' + esc(title) + badge + '</h2>';
  }

  function emptyMsg(text) {
    return '<p class="empty-msg">' + esc(text) + '</p>';
  }

  function manifestListCell(path) {
    if (path === undefined || path === null) { return '\u2014'; }
    var basename = String(path).split('/').pop() || String(path);
    return '<button class="manifest-list-link" type="button"'
      + ' data-path="' + esc(path) + '"'
      + ' title="' + esc(path) + '">'
      + esc(basename)
      + '</button>';
  }

  function tableHeader(cols) {
    return '<table class="data-table"><thead><tr>'
      + cols.map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('')
      + '</tr></thead><tbody>';
  }

  function tableClose() { return '</tbody></table>'; }

  /**
   * Encryption key suppression rule (T-25, FR-10g, design.md §2.8.3).
   */
  var ENCRYPTED_VALUE = '[encryption key reference \u2014 value not displayed]';
  var KEY_ID_RE = /(?:^|\\.)key-id$/i;

  function suppressEncryptionValue(key, value) {
    if (KEY_ID_RE.test(key)) { return ENCRYPTED_VALUE; }
    if (typeof value === 'string' && value.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      return ENCRYPTED_VALUE;
    }
    return value;
  }

  // ── T-19: Table Identity & Versioning ───────────────────────────────────

  function isView(payload) {
    return Boolean(
      (typeof payload['view-uuid'] === 'string' && payload['view-uuid']) ||
      (Array.isArray(payload.versions) && !payload['table-uuid'] && !payload.snapshots)
    );
  }

  function renderFormatVersionBadge(payload) {
    var fv = payload['format-version'];
    if (fv === undefined || fv === null) {
      elFmtBadge.style.display = 'none';
      return;
    }
    elFmtBadge.textContent = isView(payload) ? ('Format version: ' + fv + ' (View)') : ('Format version: ' + fv);
    elFmtBadge.style.display = 'inline-flex';
  }

  function renderIdentity(payload) {
    var el = document.getElementById('section-identity');
    var isV = isView(payload);
    var fields = isV ? [
      { key: 'view-uuid',          label: 'View UUID' },
      { key: 'location',           label: 'Location' },
      { key: 'current-version-id', label: 'Current Version ID' },
    ] : [
      { key: 'table-uuid',           label: 'Table UUID' },
      { key: 'location',             label: 'Location' },
      { key: 'last-updated-ms',      label: 'Last updated', fmt: formatMs },
      { key: 'last-sequence-number', label: 'Last sequence number' },
    ];

    var rows = '';
    fields.forEach(function (f) {
      var v = payload[f.key];
      if (v === undefined || v === null) { return; }
      var display = f.fmt ? f.fmt(v) : String(v);
      rows += '<dt class="kv-key">' + esc(f.label) + '</dt>'
            + '<dd class="kv-value">' + esc(display) + '</dd>';
    });

    if (!rows) {
      el.innerHTML = sectionHeading(isV ? 'View Identity' : 'Table Identity') + emptyMsg('No identity information available.');
      return;
    }
    el.innerHTML = sectionHeading(isV ? 'View Identity' : 'Table Identity')
      + '<dl class="kv-list">' + rows + '</dl>';
  }

  function renderViewSql(payload) {
    var el = document.getElementById('section-view-sql');
    if (!isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var versions = Array.isArray(payload.versions) ? payload.versions : [];
    var currentVerId = payload['current-version-id'];
    var currentVer = versions.find(function(v) { return v['version-id'] === currentVerId; }) || versions[versions.length - 1];
    var reps = Array.isArray(currentVer?.representations) ? currentVer.representations : [];
    var sqlRep = reps.find(function(r) { return r.type === 'sql'; }) || reps[0];

    var dialect = (sqlRep && sqlRep.dialect) ? sqlRep.dialect : 'trino';
    var sql = (sqlRep && sqlRep.sql) ? sqlRep.sql : '';
    var defaultCatalog = currentVer ? currentVer['default-catalog'] : undefined;
    var defaultNs = (currentVer && Array.isArray(currentVer['default-namespace'])) ? currentVer['default-namespace'].join('.') : '';

    var infoHtml = '<div style="margin-bottom: 0.75rem; color: var(--vscode-descriptionForeground); font-size: 0.85rem;">';
    infoHtml += '<strong>Dialect:</strong> <span class="badge-active" style="margin-right: 1rem;">' + esc(dialect.toUpperCase()) + '</span>';
    if (defaultCatalog) {
      infoHtml += '<strong>Catalog:</strong> ' + esc(defaultCatalog) + ' &nbsp;|&nbsp; ';
    }
    if (defaultNs) {
      infoHtml += '<strong>Namespace:</strong> ' + esc(defaultNs);
    }
    infoHtml += '</div>';

    var sqlBox = '<pre style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); padding: 0.8rem; border-radius: 3px; overflow: auto; max-height: 400px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5;"><code>'
      + esc(sql)
      + '</code></pre>';

    el.innerHTML = sectionHeading('View SQL Definition') + infoHtml + sqlBox;
  }

  function renderViewVersions(payload) {
    var el = document.getElementById('section-view-versions');
    if (!isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var versions = Array.isArray(payload.versions) ? payload.versions : [];
    if (versions.length === 0) {
      el.innerHTML = sectionHeading('View Versions') + emptyMsg('No version history.');
      return;
    }

    var currentVerId = payload['current-version-id'];
    var html = sectionHeading('View Versions')
      + '<div class="table-scroll">'
      + tableHeader(['Version ID', 'Timestamp', 'Schema ID', 'Dialect', 'Iceberg Version / Summary']);

    versions.forEach(function (v) {
      var vid = v['version-id'];
      var isCurrent = (vid === currentVerId);
      var reps = Array.isArray(v.representations) ? v.representations : [];
      var dialect = reps.map(function(r) { return r.dialect || r.type; }).join(', ') || 'trino';
      var summaryStr = (v.summary && v.summary['iceberg-version']) ? v.summary['iceberg-version'] : JSON.stringify(v.summary || {});

      html += '<tr>'
        + '<td><strong>v' + esc(vid) + '</strong>' + (isCurrent ? ' <span class="badge-active">Current</span>' : '') + '</td>'
        + '<td>' + esc(v['timestamp-ms'] ? formatMs(v['timestamp-ms']) : '\u2014') + '</td>'
        + '<td>' + esc(v['schema-id'] !== undefined ? v['schema-id'] : '\u2014') + '</td>'
        + '<td>' + esc(dialect) + '</td>'
        + '<td>' + esc(summaryStr) + '</td>'
        + '</tr>';
    });

    html += tableClose() + '</div>';
    el.innerHTML = html;
  }

  // ── T-20: Schema Information ─────────────────────────────────────────────

  function renderSchemas(payload) {
    var el = document.getElementById('section-schemas');
    var schemas = payload['schemas'];
    var currentId = payload['current-schema-id'];

    if (!Array.isArray(schemas) || schemas.length === 0) {
      el.innerHTML = sectionHeading('Schemas') + emptyMsg('No schema information available.');
      return;
    }

    var html = sectionHeading('Schemas');
    schemas.forEach(function (schema) {
      var sid = schema['schema-id'];
      var isActive = (sid !== undefined && sid === currentId);
      var fields = Array.isArray(schema['fields']) ? schema['fields'] : [];

      html += sectionHeading('Schema ' + (sid !== undefined ? sid : '?'), isActive, 'Current schema');

      if (fields.length === 0) {
        html += emptyMsg('No fields.');
        return;
      }

      var hasDoc     = fields.some(function(f) { return f['doc'] !== undefined && f['doc'] !== null; });
      var hasInitDef = fields.some(function(f) { return f['initial-default'] !== undefined && f['initial-default'] !== null; });
      var hasWrDef   = fields.some(function(f) { return f['write-default'] !== undefined && f['write-default'] !== null; });

      var cols = ['Column ID', 'Name', 'Type', 'Required/Optional'];
      if (hasDoc)     { cols.push('Doc'); }
      if (hasInitDef) { cols.push('Initial Default'); }
      if (hasWrDef)   { cols.push('Write Default'); }

      html += '<div class="table-scroll">' + tableHeader(cols);
      fields.forEach(function (f) {
        var typeVal = f['type'];
        var typeStr = (typeof typeVal === 'string') ? typeVal : JSON.stringify(typeVal);
        var req = (f['required'] === true) ? 'Required' : 'Optional';
        html += '<tr>'
          + '<td>' + esc(f['id'] !== undefined ? f['id'] : '\u2014') + '</td>'
          + '<td>' + esc(f['name'] !== undefined ? f['name'] : '\u2014') + '</td>'
          + '<td>' + esc(typeStr) + '</td>'
          + '<td>' + esc(req) + '</td>';
        if (hasDoc)     { html += '<td>' + esc(f['doc'] != null ? f['doc'] : '') + '</td>'; }
        if (hasInitDef) { html += '<td>' + esc(f['initial-default'] != null ? JSON.stringify(f['initial-default']) : '') + '</td>'; }
        if (hasWrDef)   { html += '<td>' + esc(f['write-default'] != null ? JSON.stringify(f['write-default']) : '') + '</td>'; }
        html += '</tr>';
      });
      html += tableClose() + '</div>';
    });

    el.innerHTML = html;
  }

  // ── T-21: Partitioning ───────────────────────────────────────────────────

  function renderPartitioning(payload) {
    var el = document.getElementById('section-partitioning');
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var specs      = payload['partition-specs'];
    var legacySpec = payload['partition-spec'];
    var defaultId  = payload['default-spec-id'];

    if ((!Array.isArray(specs) || specs.length === 0) && !legacySpec) {
      el.innerHTML = sectionHeading('Partitioning') + emptyMsg('Unpartitioned');
      return;
    }

    var html = sectionHeading('Partitioning');

    if (Array.isArray(specs) && specs.length > 0) {
      specs.forEach(function (spec) {
        var sid = spec['spec-id'];
        var isActive = (defaultId !== undefined && sid !== undefined && sid === defaultId);
        html += sectionHeading('Spec ' + (sid !== undefined ? sid : '?'), isActive, 'Active spec');
        html += renderPartitionFields(spec['fields'] || []);
      });
    } else if (legacySpec) {
      html += '<h3 class="section-heading">Partition Spec</h3>';
      html += renderPartitionFields(Array.isArray(legacySpec) ? legacySpec : (legacySpec['fields'] || []));
    }

    el.innerHTML = html;
  }

  function renderPartitionFields(fields) {
    if (!fields.length) { return emptyMsg('No partition fields.'); }
    var html = '<div class="table-scroll">' + tableHeader(['Field Name', 'Source Column ID', 'Transform']);
    fields.forEach(function (f) {
      html += '<tr>'
        + '<td>' + esc(f['name'] !== undefined ? f['name'] : '\u2014') + '</td>'
        + '<td>' + esc(f['source-id'] !== undefined ? f['source-id'] : '\u2014') + '</td>'
        + '<td>' + esc(f['transform'] !== undefined ? f['transform'] : '\u2014') + '</td>'
        + '</tr>';
    });
    html += tableClose() + '</div>';
    return html;
  }

  // ── T-22: Sort Orders ────────────────────────────────────────────────────

  function renderSortOrders(payload) {
    var el = document.getElementById('section-sort-orders');
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var orders    = payload['sort-orders'];
    var defaultId = payload['default-sort-order-id'];

    // V1: key absent — section silently omitted (A-8, FR-10h)
    if (orders === undefined || orders === null) {
      el.innerHTML = '';
      return;
    }

    var nonEmpty = orders.filter(function(o) {
      return Array.isArray(o['fields']) && o['fields'].length > 0;
    });

    if (nonEmpty.length === 0) {
      el.innerHTML = sectionHeading('Sort Orders') + emptyMsg('Unsorted');
      return;
    }

    var html = sectionHeading('Sort Orders');
    orders.forEach(function (order) {
      var oid = order['order-id'];
      var isActive = (defaultId !== undefined && oid !== undefined && oid === defaultId);
      html += sectionHeading('Order ' + (oid !== undefined ? oid : '?'), isActive, 'Active sort order');
      var fields = Array.isArray(order['fields']) ? order['fields'] : [];
      if (!fields.length) {
        html += emptyMsg('No sort fields.');
        return;
      }
      html += '<div class="table-scroll">' + tableHeader(['Transform', 'Source Column ID', 'Direction', 'Null Ordering']);
      fields.forEach(function (f) {
        html += '<tr>'
          + '<td>' + esc(f['transform'] !== undefined ? f['transform'] : '\u2014') + '</td>'
          + '<td>' + esc(f['source-id'] !== undefined ? f['source-id'] : '\u2014') + '</td>'
          + '<td>' + esc(f['direction'] !== undefined ? f['direction'] : '\u2014') + '</td>'
          + '<td>' + esc(f['null-order'] !== undefined ? f['null-order'] : '\u2014') + '</td>'
          + '</tr>';
      });
      html += tableClose() + '</div>';
    });
    el.innerHTML = html;
  }

  // ── T-23: Snapshots ──────────────────────────────────────────────────────

  function renderSnapshots(payload) {
    var el = document.getElementById('section-snapshots');
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var snapshots = payload['snapshots'];

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      el.innerHTML = sectionHeading('Snapshots') + emptyMsg('No snapshots.');
      return;
    }

    var html = sectionHeading('Snapshots')
      + '<div class="table-scroll">'
      + tableHeader(['Snapshot ID', 'Parent Snapshot ID', 'Timestamp', 'Schema ID', 'Sequence Number', 'Manifest List URI']);

    snapshots.forEach(function (snap) {
      var summary = snap['summary'] || {};
      html += '<tr>'
        + '<td>' + esc(snap['snapshot-id'] !== undefined ? snap['snapshot-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['parent-snapshot-id'] !== undefined ? snap['parent-snapshot-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['timestamp-ms'] !== undefined ? formatMs(snap['timestamp-ms']) : '\u2014') + '</td>'
        + '<td>' + esc(snap['schema-id'] !== undefined ? snap['schema-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['sequence-number'] !== undefined ? snap['sequence-number'] : '\u2014') + '</td>'
        + '<td>' + manifestListCell(snap['manifest-list']) + '</td>'
        + '</tr>';

      var summaryKeys = Object.keys(summary);
      if (summaryKeys.length > 0) {
        html += '<tr><td colspan="6"><div class="sub-table">'
          + '<table class="data-table"><thead><tr><th>Summary Key</th><th>Value</th></tr></thead><tbody>';
        summaryKeys.forEach(function (k) {
          html += '<tr><td>' + esc(k) + '</td><td>' + esc(String(summary[k])) + '</td></tr>';
        });
        html += '</tbody></table></div></td></tr>';
      }
    });

    html += tableClose() + '</div>';
    el.innerHTML = html;
  }

  // ── T-24: Refs ───────────────────────────────────────────────────────────

  function renderRefs(payload) {
    var el = document.getElementById('section-refs');
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var refs = payload['refs'];

    // V1: key absent — section silently omitted (A-8, FR-10h)
    if (refs === undefined || refs === null) {
      el.innerHTML = '';
      return;
    }

    var keys = Object.keys(refs);
    if (keys.length === 0) {
      el.innerHTML = sectionHeading('Refs') + emptyMsg('No refs defined.');
      return;
    }

    var html = sectionHeading('Refs')
      + '<div class="table-scroll">'
      + tableHeader(['Ref Name', 'Type', 'Target Snapshot ID', 'Max Ref Age (ms)', 'Min Snapshots to Keep', 'Max Snapshot Age (ms)']);

    keys.forEach(function (name) {
      var r = refs[name];
      html += '<tr>'
        + '<td>' + esc(name) + '</td>'
        + '<td>' + esc(r['type'] !== undefined ? r['type'] : '\u2014') + '</td>'
        + '<td>' + esc(r['snapshot-id'] !== undefined ? r['snapshot-id'] : '\u2014') + '</td>'
        + '<td>' + esc(r['max-ref-age-ms'] !== undefined ? r['max-ref-age-ms'] : '\u2014') + '</td>'
        + '<td>' + esc(r['min-snapshots-to-keep'] !== undefined ? r['min-snapshots-to-keep'] : '\u2014') + '</td>'
        + '<td>' + esc(r['max-snapshot-age-ms'] !== undefined ? r['max-snapshot-age-ms'] : '\u2014') + '</td>'
        + '</tr>';
    });

    html += tableClose() + '</div>';
    el.innerHTML = html;
  }

  // ── T-25: Table Properties ───────────────────────────────────────────────

  function renderProperties(payload) {
    var el = document.getElementById('section-properties');
    var props = payload['properties'];

    if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
      el.innerHTML = sectionHeading('Table Properties') + emptyMsg('No properties defined.');
      return;
    }

    var html = sectionHeading('Table Properties')
      + '<div class="table-scroll">'
      + tableHeader(['Key', 'Value']);

    Object.keys(props).forEach(function (k) {
      var displayVal = suppressEncryptionValue(k, props[k]);
      html += '<tr>'
        + '<td>' + esc(k) + '</td>'
        + '<td>' + esc(String(displayVal)) + '</td>'
        + '</tr>';
    });

    html += tableClose() + '</div>';
    el.innerHTML = html;
  }

}());
</script>
</body>
</html>`;
}
