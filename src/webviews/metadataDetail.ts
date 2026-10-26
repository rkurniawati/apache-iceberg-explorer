/**
 * Metadata Detail Webview Client Script
 *
 * Implements client-side state machine, tabs, breadcrumbs, JSON formatting,
 * and section rendering for Iceberg table and view metadata.
 */
(function () {
  'use strict';

  // ── VS Code API ──────────────────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── State machine ────────────────────────────────────────────────────────
  // Valid states: idle | loading | loaded | error | cancelled  (design.md §2.3.1)
  let currentState = 'idle';
  let isRawView = false;
  let currentRawJsonStr = '';

  const elLoading      = document.getElementById('loading-indicator');
  const elError        = document.getElementById('error-area');
  const elContent      = document.getElementById('content-area');
  const elErrorMsg     = document.getElementById('error-message');
  const elRetryBtn     = document.getElementById('error-retry-btn');
  const elFmtBadge     = document.getElementById('format-version-badge');
  const elBreadcrumb   = document.getElementById('breadcrumb');
  const elTopBar       = document.getElementById('top-bar');
  const elViewActions  = document.getElementById('view-actions');
  const elToggleBtn    = document.getElementById('toggle-raw-json-btn');
  const elToggleIcon   = document.getElementById('toggle-raw-icon');
  const elToggleLabel  = document.getElementById('toggle-raw-label');
  const elCopyBtn      = document.getElementById('copy-raw-json-btn');
  const elRawContainer = document.getElementById('raw-json-container');
  const elRawPre       = document.getElementById('raw-json-pre');
  const elRawCode      = document.getElementById('raw-json-code');
  const elRawStats     = document.getElementById('raw-json-stats');

  // Map error classes to the exact static strings from design.md §2.5.2
  const ERROR_MESSAGES: Record<string, string> = {
    'access-denied': 'Access denied. Check your connection credentials and permissions.',
    'not-found':     'File not found. The resource may have been deleted or moved.',
    'parse-failure': 'Could not read file. The file may be corrupted or in an unsupported format.',
    'timeout':       'Query timed out after 30 seconds. Try a more specific query or a smaller file.',
    'cancelled':     'Operation cancelled.',
    'internal':      'An unexpected error occurred. Please try again.',
  };

  function updateViewDisplay() {
    if (currentState !== 'loaded') {
      if (elContent) elContent.style.display = 'none';
      if (elRawContainer) elRawContainer.style.display = 'none';
      return;
    }
    if (isRawView) {
      if (elContent) elContent.style.display = 'none';
      if (elRawContainer) elRawContainer.style.display = 'block';
      if (elToggleBtn) {
        elToggleBtn.classList.add('btn-active');
        elToggleBtn.setAttribute('aria-pressed', 'true');
      }
      if (elToggleIcon) elToggleIcon.textContent = '📄';
      if (elToggleLabel) elToggleLabel.textContent = 'Structured View';
      if (elCopyBtn) elCopyBtn.style.display = 'inline-flex';
    } else {
      if (elContent) elContent.style.display = 'block';
      if (elRawContainer) elRawContainer.style.display = 'none';
      if (elToggleBtn) {
        elToggleBtn.classList.remove('btn-active');
        elToggleBtn.setAttribute('aria-pressed', 'false');
      }
      if (elToggleIcon) elToggleIcon.textContent = '{ }';
      if (elToggleLabel) elToggleLabel.textContent = 'Raw JSON';
      if (elCopyBtn) elCopyBtn.style.display = 'none';
    }
  }

  function setState(state: string) {
    currentState = state;
    if (elLoading) elLoading.style.display = state === 'loading' ? 'flex'  : 'none';
    if (elError)   elError.style.display   = state === 'error'   ? 'block' : 'none';
    if (elViewActions) elViewActions.style.display = state === 'loaded' ? 'inline-flex' : 'none';
    updateViewDisplay();
  }

  // Toggle button toggles between structured and raw JSON views
  if (elToggleBtn) {
    elToggleBtn.addEventListener('click', function () {
      isRawView = !isRawView;
      updateViewDisplay();
      const cur = (vscode.getState() as any) || {};
      vscode.setState(Object.assign({}, cur, { isRawView: isRawView }));
    });
  }

  // Copy button copies human-formatted raw JSON to clipboard
  if (elCopyBtn) {
    elCopyBtn.addEventListener('click', function () {
      if (!currentRawJsonStr) { return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentRawJsonStr).catch(function () {});
      }
      const origText = elCopyBtn.textContent;
      elCopyBtn.textContent = '✓ Copied!';
      setTimeout(function () {
        elCopyBtn.textContent = origText;
      }, 2000);
    });
  }

  // Retry button posts a 'retry' message to the host (T-28)
  if (elRetryBtn) {
    elRetryBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'retry' });
    });
  }

  // Manifest-list link in Snapshots table → open manifest list panel (T-23)
  const snapshotsEl = document.getElementById('section-snapshots');
  if (snapshotsEl) {
    snapshotsEl.addEventListener('click', function (e) {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest('.manifest-list-link') as HTMLElement | null;
      if (btn && btn.dataset.path) {
        vscode.postMessage({ type: 'openManifestList', resourcePath: btn.dataset.path });
      }
    });
  }

  const previousState = vscode.getState() as any;
  if (previousState?.type === 'loadMetadata' && previousState.payload) {
    if (previousState.isRawView) {
      isRawView = true;
    }
    try {
      renderAll(previousState.payload, previousState.resourcePath);
      setState('loaded');
    } catch (_) {}
  } else if (previousState?.type === 'setState' && previousState.state === 'error') {
    if (elErrorMsg) elErrorMsg.textContent = ERROR_MESSAGES[previousState.errorClass] || ERROR_MESSAGES['internal'];
    setState('error');
  }

  // ── Message listener ─────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || !msg.type) { return; }

    switch (msg.type) {
      case 'setState':
        if (msg.state === 'loading') {
          const st = vscode.getState() as any;
          if (!st || st.type !== 'loadMetadata') {
            setState('loading');
          }
        } else if (msg.state === 'error') {
          vscode.setState(msg);
          if (elErrorMsg) elErrorMsg.textContent = ERROR_MESSAGES[msg.errorClass] || ERROR_MESSAGES['internal'];
          setState('error');
        }
        break;

      case 'loadMetadata':
        vscode.setState({
          type: 'loadMetadata',
          payload: msg.payload,
          resourcePath: msg.resourcePath,
          isRawView: isRawView,
        });
        try {
          renderAll(msg.payload, msg.resourcePath);
          setState('loaded');
        } catch (err) {
          console.error('Failed to render metadata detail:', err);
          if (elErrorMsg) elErrorMsg.textContent = 'Failed to display metadata details.';
          setState('error');
        }
        break;
    }
  });

  // Signal readiness now that the message listener is registered (MEDIUM-1)
  vscode.postMessage({ type: 'webviewReady' });

  // ── Breadcrumb rendering (FR-18, T-27) ──────────────────────────────────

  function renderBreadcrumb(resourcePath?: string) {
    if (!resourcePath || !elBreadcrumb) { return; }
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

  function resourcePathToBreadcrumbs(resourcePath: string): string[] {
    const normalised = resourcePath.split('\\').join('/').replace(new RegExp('^s3[an]?://', 'i'), 's3://').replace(new RegExp('^gcs://', 'i'), 'gs://');
    let parts: string[];
    if (normalised.startsWith('s3://') || normalised.startsWith('gs://')) {
      const schemeLen = normalised.startsWith('s3://') ? 's3://'.length : 'gs://'.length;
      const withoutScheme = normalised.slice(schemeLen);
      parts = withoutScheme.split('/').filter(Boolean);
      const metaIdx = parts.lastIndexOf('metadata');
      if (metaIdx >= 3) {
        return [
          parts.slice(0, metaIdx - 2).join('/'),
          parts[metaIdx - 2],
          parts[metaIdx - 1],
          parts[parts.length - 1],
        ];
      }
      const tail = parts.slice(-4);
      return tail.length === 4 ? tail : parts;
    }
    parts = normalised.split('/').filter(Boolean);
    const metaIdx2 = parts.lastIndexOf('metadata');
    if (metaIdx2 >= 2) {
      return [
        '/' + parts.slice(0, metaIdx2 - 2).join('/'),
        parts[metaIdx2 - 2],
        parts[metaIdx2 - 1],
        parts[parts.length - 1],
      ];
    }
    const t = parts.slice(-4);
    const rootParts = parts.slice(0, parts.length - t.length);
    const root = rootParts.length > 0 ? '/' + rootParts.join('/') : '/';
    return t.length >= 2 ? [root].concat(t.slice(-3)) : [root].concat(t);
  }

  // ── Master render coordinator ────────────────────────────────────────────

  function renderAll(payload: any, resourcePath?: string) {
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
    renderRawJson(payload);
    updateViewDisplay();
  }

  // ── Raw JSON formatter & syntax highlighter ──────────────────────────────

  function highlightJson(str: string): string {
    try {
      let lastIdx = 0;
      let html = '';
      const regex = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\\-]?\d+)?/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(str)) !== null) {
        if (m.index > lastIdx) {
          html += esc(str.substring(lastIdx, m.index));
        }
        lastIdx = regex.lastIndex;
        if (m[1]) {
          if (m[2]) {
            html += '<span class="json-key">' + esc(m[1]) + '</span>' + esc(m[2]);
          } else {
            html += '<span class="json-string">' + esc(m[1]) + '</span>';
          }
        } else if (m[3]) {
          const cls = m[3] === 'null' ? 'json-null' : 'json-boolean';
          html += '<span class="' + cls + '">' + m[3] + '</span>';
        } else {
          html += '<span class="json-number">' + esc(m[0]) + '</span>';
        }
      }
      if (lastIdx < str.length) {
        html += esc(str.substring(lastIdx));
      }
      return html;
    } catch (_) {
      return esc(str);
    }
  }

  function renderRawJson(payload: any) {
    let parsed = payload;
    if (typeof payload === 'string') {
      try { parsed = JSON.parse(payload); } catch (_) {}
    }
    const str = JSON.stringify(parsed, null, 2);
    currentRawJsonStr = str;

    const lines = str.split(/\r?\n/).length;
    const bytes = typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(str).length
      : str.length;
    const sizeStr = bytes < 1024
      ? bytes + ' B'
      : (bytes / 1024).toFixed(1) + ' KB';

    if (elRawStats) {
      elRawStats.textContent = '(' + lines.toLocaleString() + ' lines, ' + sizeStr + ')';
    }

    if (elRawCode) {
      elRawCode.innerHTML = highlightJson(str);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(str: any): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMs(ms: any): string {
    try { return new Date(ms).toLocaleString(); }
    catch (_) { return String(ms); }
  }

  function sectionHeading(title: string, isActive?: boolean, activeLabel?: string): string {
    const badge = (isActive && activeLabel)
      ? '<span class="badge-active">' + esc(activeLabel) + '</span>'
      : '';
    return '<h2 class="section-heading">' + esc(title) + badge + '</h2>';
  }

  function emptyMsg(text: string): string {
    return '<p class="empty-msg">' + esc(text) + '</p>';
  }

  function manifestListCell(path: any): string {
    if (path === undefined || path === null) { return '\u2014'; }
    const basename = String(path).split('/').pop() || String(path);
    return '<button class="manifest-list-link" type="button"'
      + ' data-path="' + esc(path) + '"'
      + ' title="' + esc(path) + '">'
      + esc(basename)
      + '</button>';
  }

  function tableHeader(cols: string[]): string {
    return '<table class="data-table"><thead><tr>'
      + cols.map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('')
      + '</tr></thead><tbody>';
  }

  function tableClose(): string { return '</tbody></table>'; }

  /**
   * Encryption key suppression rule (T-25, FR-10g, design.md §2.8.3).
   */
  const ENCRYPTED_VALUE = '[encryption key reference \u2014 value not displayed]';
  const KEY_ID_RE = /(?:^|\.)key-id$/i;

  function suppressEncryptionValue(key: string, value: any): any {
    if (KEY_ID_RE.test(key)) { return ENCRYPTED_VALUE; }
    if (typeof value === 'string' && value.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      return ENCRYPTED_VALUE;
    }
    return value;
  }

  // ── T-19: Table Identity & Versioning ───────────────────────────────────

  function isView(payload: any): boolean {
    return Boolean(
      (typeof payload['view-uuid'] === 'string' && payload['view-uuid']) ||
      (Array.isArray(payload.versions) && !payload['table-uuid'] && !payload.snapshots)
    );
  }

  function renderFormatVersionBadge(payload: any) {
    if (!elFmtBadge) return;
    const fv = payload['format-version'];
    if (fv === undefined || fv === null) {
      elFmtBadge.style.display = 'none';
      return;
    }
    elFmtBadge.textContent = isView(payload) ? ('Format version: ' + fv + ' (View)') : ('Format version: ' + fv);
    elFmtBadge.style.display = 'inline-flex';
  }

  function renderIdentity(payload: any) {
    const el = document.getElementById('section-identity');
    if (!el) return;
    const isV = isView(payload);
    const fields: Array<{ key: string; label: string; fmt?: (v: any) => string }> = isV ? [
      { key: 'view-uuid',          label: 'View UUID' },
      { key: 'location',           label: 'Location' },
      { key: 'current-version-id', label: 'Current Version ID' },
    ] : [
      { key: 'table-uuid',           label: 'Table UUID' },
      { key: 'location',             label: 'Location' },
      { key: 'last-updated-ms',      label: 'Last updated', fmt: formatMs },
      { key: 'last-sequence-number', label: 'Last sequence number' },
    ];

    let rows = '';
    fields.forEach(function (f) {
      const v = payload[f.key];
      if (v === undefined || v === null) { return; }
      const display = f.fmt ? f.fmt(v) : String(v);
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

  function renderViewSql(payload: any) {
    const el = document.getElementById('section-view-sql');
    if (!el) return;
    if (!isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const versions = Array.isArray(payload.versions) ? payload.versions : [];
    const currentVerId = payload['current-version-id'];
    const currentVer = versions.find(function(v: any) { return v['version-id'] === currentVerId; }) || versions[versions.length - 1];
    const reps = Array.isArray(currentVer?.representations) ? currentVer.representations : [];
    const sqlRep = reps.find(function(r: any) { return r.type === 'sql'; }) || reps[0];

    const dialect = (sqlRep && sqlRep.dialect) ? sqlRep.dialect : 'trino';
    const sql = (sqlRep && sqlRep.sql) ? sqlRep.sql : '';
    const defaultCatalog = currentVer ? currentVer['default-catalog'] : undefined;
    const defaultNs = (currentVer && Array.isArray(currentVer['default-namespace'])) ? currentVer['default-namespace'].join('.') : '';

    let infoHtml = '<div style="margin-bottom: 0.75rem; color: var(--vscode-descriptionForeground); font-size: 0.85rem;">';
    infoHtml += '<strong>Dialect:</strong> <span class="badge-active" style="margin-right: 1rem;">' + esc(dialect.toUpperCase()) + '</span>';
    if (defaultCatalog) {
      infoHtml += '<strong>Catalog:</strong> ' + esc(defaultCatalog) + ' &nbsp;|&nbsp; ';
    }
    if (defaultNs) {
      infoHtml += '<strong>Namespace:</strong> ' + esc(defaultNs);
    }
    infoHtml += '</div>';

    const sqlBox = '<pre style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); padding: 0.8rem; border-radius: 3px; overflow: auto; max-height: 400px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5;"><code>'
      + esc(sql)
      + '</code></pre>';

    el.innerHTML = sectionHeading('View SQL Definition') + infoHtml + sqlBox;
  }

  function renderViewVersions(payload: any) {
    const el = document.getElementById('section-view-versions');
    if (!el) return;
    if (!isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const versions = Array.isArray(payload.versions) ? payload.versions : [];
    if (versions.length === 0) {
      el.innerHTML = sectionHeading('View Versions') + emptyMsg('No version history.');
      return;
    }

    const currentVerId = payload['current-version-id'];
    let html = sectionHeading('View Versions')
      + '<div class="table-scroll">'
      + tableHeader(['Version ID', 'Timestamp', 'Schema ID', 'Dialect', 'Iceberg Version / Summary']);

    versions.forEach(function (v: any) {
      const vid = v['version-id'];
      const isCurrent = (vid === currentVerId);
      const reps = Array.isArray(v.representations) ? v.representations : [];
      const dialect = reps.map(function(r: any) { return r.dialect || r.type; }).join(', ') || 'trino';
      const summaryStr = (v.summary && v.summary['iceberg-version']) ? v.summary['iceberg-version'] : JSON.stringify(v.summary || {});

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

  function renderSchemas(payload: any) {
    const el = document.getElementById('section-schemas');
    if (!el) return;
    const schemas = payload['schemas'];
    const currentId = payload['current-schema-id'];

    if (!Array.isArray(schemas) || schemas.length === 0) {
      el.innerHTML = sectionHeading('Schemas') + emptyMsg('No schema information available.');
      return;
    }

    let html = sectionHeading('Schemas');
    schemas.forEach(function (schema: any) {
      const sid = schema['schema-id'];
      const isActive = (sid !== undefined && sid === currentId);
      const fields = Array.isArray(schema['fields']) ? schema['fields'] : [];

      html += sectionHeading('Schema ' + (sid !== undefined ? sid : '?'), isActive, 'Current schema');

      if (fields.length === 0) {
        html += emptyMsg('No fields.');
        return;
      }

      const hasDoc     = fields.some(function(f: any) { return f['doc'] !== undefined && f['doc'] !== null; });
      const hasInitDef = fields.some(function(f: any) { return f['initial-default'] !== undefined && f['initial-default'] !== null; });
      const hasWrDef   = fields.some(function(f: any) { return f['write-default'] !== undefined && f['write-default'] !== null; });

      const cols = ['Column ID', 'Name', 'Type', 'Required/Optional'];
      if (hasDoc)     { cols.push('Doc'); }
      if (hasInitDef) { cols.push('Initial Default'); }
      if (hasWrDef)   { cols.push('Write Default'); }

      html += '<div class="table-scroll">' + tableHeader(cols);
      fields.forEach(function (f: any) {
        const typeVal = f['type'];
        const typeStr = (typeof typeVal === 'string') ? typeVal : JSON.stringify(typeVal);
        const req = (f['required'] === true) ? 'Required' : 'Optional';
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

  function renderPartitioning(payload: any) {
    const el = document.getElementById('section-partitioning');
    if (!el) return;
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const specs      = payload['partition-specs'];
    const legacySpec = payload['partition-spec'];
    const defaultId  = payload['default-spec-id'];

    if ((!Array.isArray(specs) || specs.length === 0) && !legacySpec) {
      el.innerHTML = sectionHeading('Partitioning') + emptyMsg('Unpartitioned');
      return;
    }

    let html = sectionHeading('Partitioning');

    if (Array.isArray(specs) && specs.length > 0) {
      specs.forEach(function (spec: any) {
        const sid = spec['spec-id'];
        const isActive = (defaultId !== undefined && sid !== undefined && sid === defaultId);
        html += sectionHeading('Spec ' + (sid !== undefined ? sid : '?'), isActive, 'Active spec');
        html += renderPartitionFields(spec['fields'] || []);
      });
    } else if (legacySpec) {
      html += '<h3 class="section-heading">Partition Spec</h3>';
      html += renderPartitionFields(Array.isArray(legacySpec) ? legacySpec : (legacySpec['fields'] || []));
    }

    el.innerHTML = html;
  }

  function renderPartitionFields(fields: any[]) {
    if (!fields.length) { return emptyMsg('No partition fields.'); }
    let html = '<div class="table-scroll">' + tableHeader(['Field Name', 'Source Column ID', 'Transform']);
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

  function renderSortOrders(payload: any) {
    const el = document.getElementById('section-sort-orders');
    if (!el) return;
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const orders    = payload['sort-orders'];
    const defaultId = payload['default-sort-order-id'];

    // V1: key absent — section silently omitted (A-8, FR-10h)
    if (orders === undefined || orders === null) {
      el.innerHTML = '';
      return;
    }

    const nonEmpty = orders.filter(function(o: any) {
      return Array.isArray(o['fields']) && o['fields'].length > 0;
    });

    if (nonEmpty.length === 0) {
      el.innerHTML = sectionHeading('Sort Orders') + emptyMsg('Unsorted');
      return;
    }

    let html = sectionHeading('Sort Orders');
    orders.forEach(function (order: any) {
      const oid = order['order-id'];
      const isActive = (defaultId !== undefined && oid !== undefined && oid === defaultId);
      html += sectionHeading('Order ' + (oid !== undefined ? oid : '?'), isActive, 'Active sort order');
      const fields = Array.isArray(order['fields']) ? order['fields'] : [];
      if (!fields.length) {
        html += emptyMsg('No sort fields.');
        return;
      }
      html += '<div class="table-scroll">' + tableHeader(['Transform', 'Source Column ID', 'Direction', 'Null Ordering']);
      fields.forEach(function (f: any) {
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

  function renderSnapshots(payload: any) {
    const el = document.getElementById('section-snapshots');
    if (!el) return;
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const snapshots = payload['snapshots'];

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      el.innerHTML = sectionHeading('Snapshots') + emptyMsg('No snapshots.');
      return;
    }

    let html = sectionHeading('Snapshots')
      + '<div class="table-scroll">'
      + tableHeader(['Snapshot ID', 'Parent Snapshot ID', 'Timestamp', 'Schema ID', 'Sequence Number', 'Manifest List URI']);

    snapshots.forEach(function (snap: any) {
      const summary = snap['summary'] || {};
      html += '<tr>'
        + '<td>' + esc(snap['snapshot-id'] !== undefined ? snap['snapshot-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['parent-snapshot-id'] !== undefined ? snap['parent-snapshot-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['timestamp-ms'] !== undefined ? formatMs(snap['timestamp-ms']) : '\u2014') + '</td>'
        + '<td>' + esc(snap['schema-id'] !== undefined ? snap['schema-id'] : '\u2014') + '</td>'
        + '<td>' + esc(snap['sequence-number'] !== undefined ? snap['sequence-number'] : '\u2014') + '</td>'
        + '<td>' + manifestListCell(snap['manifest-list']) + '</td>'
        + '</tr>';

      const summaryKeys = Object.keys(summary);
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

  function renderRefs(payload: any) {
    const el = document.getElementById('section-refs');
    if (!el) return;
    if (isView(payload)) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const refs = payload['refs'];

    // V1: key absent — section silently omitted (A-8, FR-10h)
    if (refs === undefined || refs === null) {
      el.innerHTML = '';
      return;
    }

    const keys = Object.keys(refs);
    if (keys.length === 0) {
      el.innerHTML = sectionHeading('Refs') + emptyMsg('No refs defined.');
      return;
    }

    let html = sectionHeading('Refs')
      + '<div class="table-scroll">'
      + tableHeader(['Ref Name', 'Type', 'Target Snapshot ID', 'Max Ref Age (ms)', 'Min Snapshots to Keep', 'Max Snapshot Age (ms)']);

    keys.forEach(function (name) {
      const r = refs[name];
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

  function renderProperties(payload: any) {
    const el = document.getElementById('section-properties');
    if (!el) return;
    const props = payload['properties'];

    if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
      el.innerHTML = sectionHeading('Table Properties') + emptyMsg('No properties defined.');
      return;
    }

    let html = sectionHeading('Table Properties')
      + '<div class="table-scroll">'
      + tableHeader(['Key', 'Value']);

    Object.keys(props).forEach(function (k) {
      const displayVal = suppressEncryptionValue(k, props[k]);
      html += '<tr>'
        + '<td>' + esc(k) + '</td>'
        + '<td>' + esc(String(displayVal)) + '</td>'
        + '</tr>';
    });

    html += tableClose() + '</div>';
    el.innerHTML = html;
  }

}());
