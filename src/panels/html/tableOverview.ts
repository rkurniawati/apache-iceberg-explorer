/**
 * Table Overview Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Table Identity & Versioning header
 *  - Schema & Column types table
 *  - Partition specifications
 *  - Embedded Data Preview with DuckDB-WASM
 *  - Snapshots list with link to Architecture DAG
 */
import { escHtml, breadcrumbHtml, BREADCRUMB_CSS, TABLE_CSS } from './shared.js';
import type { LoadTableOverviewMessage, LoadDataPreviewMessage } from '../messages.js';

export function getTableOverviewHtml(
  nonce: string,
  cspSource: string,
  tablePath: string,
): string {
  const initialBreadcrumb = breadcrumbHtml(tablePath);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Table Overview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0 1.25rem 2rem;
    }

    ${BREADCRUMB_CSS}
    ${TABLE_CSS}

    /* ── Header ─────────────────────────────────────────────────────────── */
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      margin-bottom: 1.25rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .header-main { display: flex; flex-direction: column; gap: 0.35rem; }
    .title-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge-v1 { background: #3b82f6; color: #fff; }
    .badge-v2 { background: #10b981; color: #fff; }
    .badge-v3 { background: #8b5cf6; color: #fff; }

    .meta-details {
      display: flex;
      flex-wrap: wrap;
      gap: 1.2rem;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85rem;
    }
    .meta-item strong { color: var(--vscode-editor-foreground); }

    .actions-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    button.btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 0.4rem 0.8rem;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.82rem;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    button.btn:hover { background: var(--vscode-button-hoverBackground); }
    button.btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    button.btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* ── Tabs ───────────────────────────────────────────────────────────── */
    .tabs-bar {
      display: flex;
      gap: 0.25rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      margin-bottom: 1.25rem;
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0.6rem 1rem;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font: inherit;
      font-weight: 500;
      font-size: 0.9rem;
    }
    .tab-btn:hover { color: var(--vscode-editor-foreground); }
    .tab-btn.active {
      color: var(--vscode-editor-foreground);
      border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-textLink-foreground));
      font-weight: 600;
    }

    /* ── Partition Badges ────────────────────────────────────────────────── */
    .partition-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin: 0.75rem 0 1.25rem;
    }
    .chip {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 0.25rem 0.6rem;
      border-radius: 12px;
      font-size: 0.8rem;
      border: 1px solid var(--vscode-editorWidget-border);
    }

    /* ── Search & Filter Box ────────────────────────────────────────────── */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      gap: 0.5rem;
    }
    input.search-input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 0.35rem 0.6rem;
      border-radius: 2px;
      font: inherit;
      font-size: 0.85rem;
      width: 250px;
    }
    input.search-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    /* ── Snapshots Timeline ──────────────────────────────────────────────── */
    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }
    .timeline-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 0.75rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .timeline-left { display: flex; flex-direction: column; gap: 0.25rem; }
    .timeline-id { font-family: monospace; font-weight: 600; color: var(--vscode-textLink-foreground); }
    .timeline-meta { font-size: 0.8rem; color: var(--vscode-descriptionForeground); }
    .op-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .op-append { background: #065f46; color: #34d399; }
    .op-overwrite { background: #9a3412; color: #fdba74; }
    .op-replace { background: #3730a3; color: #a5b4fc; }
    .op-delete { background: #991b1b; color: #f87171; }

    /* ── Loading & Error states ─────────────────────────────────────────── */
    #loading {
      padding: 3rem 1rem;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid var(--vscode-editorWidget-border);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 0.75rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    #error {
      display: none;
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
      background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.1));
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-editor-foreground));
      border-radius: 3px;
    }

    .pagination-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 1rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }
  </style>
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div id="loading-msg">Loading Iceberg table overview…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to load table</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div class="header-main">
        <div class="title-row">
          <h1 id="table-name">Table</h1>
          <span class="badge" id="version-badge">v2</span>
        </div>
        <div class="meta-details">
          <span class="meta-item" id="item-location">Location: <strong id="table-location"></strong></span>
          <span class="meta-item" id="item-current-snapshot">Current Snapshot: <strong id="current-snapshot" style="font-family: monospace;"></strong></span>
          <span class="meta-item" id="item-view-uuid" style="display: none;">View UUID: <strong id="view-uuid" style="font-family: monospace;"></strong></span>
          <span class="meta-item" id="item-current-version" style="display: none;">Current Version: <strong id="current-version"></strong></span>
          <span class="meta-item" id="item-default-namespace" style="display: none;">Namespace: <strong id="default-namespace"></strong></span>
          <span class="meta-item" id="item-default-catalog" style="display: none;">Catalog: <strong id="default-catalog"></strong></span>
          <span class="meta-item" id="item-updated">Updated: <strong id="table-updated"></strong></span>
        </div>
      </div>
      <div class="actions-bar">
        <button class="btn" id="query-btn">🔍 Query SQL</button>
        <button class="btn btn-secondary" id="view-metadata-btn">📄 Metadata JSON</button>
        <button class="btn btn-secondary" id="view-dag-btn">🏗️ Architecture DAG</button>
      </div>
    </div>

    <div class="tabs-bar">
      <button class="tab-btn active" data-tab="schema" id="tab-btn-schema">Schema & Columns</button>
      <button class="tab-btn" data-tab="sql" id="tab-btn-sql" style="display: none;">View SQL</button>
      <button class="tab-btn" data-tab="preview" id="tab-btn-preview">Data Preview</button>
      <button class="tab-btn" data-tab="snapshots" id="tab-btn-snapshots">Snapshots History</button>
    </div>

    <!-- Tab 1: Schema -->
    <div id="tab-schema" class="tab-content">
      <div id="partition-section">
        <div style="font-weight: 600; margin-bottom: 0.4rem;">Partition Specification</div>
        <div class="partition-chips" id="partition-chips">
          <span style="color: var(--vscode-descriptionForeground); font-style: italic;">Unpartitioned</span>
        </div>
      </div>

      <div class="filter-bar">
        <div style="font-weight: 600;">Table Columns (<span id="column-count">0</span>)</div>
        <input type="text" class="search-input" id="schema-search" placeholder="Filter columns…">
      </div>
      <div style="overflow-x: auto;">
        <table id="schema-table">
          <thead>
            <tr>
              <th style="width: 50px;">ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullability</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody id="schema-tbody"></tbody>
        </table>
      </div>

      <div id="properties-section" style="margin-top: 2rem;">
        <div style="font-weight: 600; margin-bottom: 0.5rem;">Table Properties</div>
        <table id="properties-table">
          <thead><tr><th style="width: 300px;">Key</th><th>Value</th></tr></thead>
          <tbody id="properties-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Tab: View SQL (Visible for Iceberg Views) -->
    <div id="tab-sql" class="tab-content" style="display: none;">
      <div style="margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">
        ℹ️ <strong>Apache Iceberg View</strong>: Views are metadata-only definitions containing a SQL query. They do not store physical data snapshots. You can copy the SQL query below to execute in your external query engine (such as Trino or Spark).
      </div>
      <div class="filter-bar">
        <div><strong>Dialect:</strong> <span class="badge" id="view-dialect-badge" style="background: #0284c7; color: #fff;">TRINO</span></div>
        <button class="btn btn-secondary" id="copy-sql-btn">📋 Copy SQL</button>
      </div>
      <pre style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); padding: 1rem; border-radius: 4px; overflow: auto; max-height: 500px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5;"><code id="view-sql-code"></code></pre>
    </div>

    <!-- Tab 2: Data Preview -->
    <div id="tab-preview" class="tab-content" style="display: none;">
      <div class="filter-bar">
        <div>Sample Data (Top <span id="preview-row-count">0</span> rows)</div>
        <button class="btn btn-secondary" id="load-preview-btn">🔄 Reload Sample</button>
      </div>
      <div id="preview-loading" style="padding: 2rem; text-align: center; display: none;">
        <div class="spinner"></div>
        <div>Querying latest data files with DuckDB…</div>
      </div>
      <div id="preview-error" style="display: none; padding: 1rem; color: var(--vscode-errorForeground);"></div>
      <div id="preview-wrapper" style="overflow-x: auto;">
        <table id="preview-table">
          <thead id="preview-thead"></thead>
          <tbody id="preview-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Tab 3: Snapshots History -->
    <div id="tab-snapshots" class="tab-content" style="display: none;">
      <div class="filter-bar">
        <div style="font-weight: 600;">Snapshot Commits (<span id="snapshots-total">0</span> total)</div>
      </div>
      <div class="timeline-list" id="snapshots-list"></div>
      <div class="pagination-bar" id="snapshots-pagination">
        <button class="btn btn-secondary" id="snap-prev-btn">&larr; Previous</button>
        <span id="snap-page-indicator" style="font-size: 0.85rem;">Page 1</span>
        <button class="btn btn-secondary" id="snap-next-btn">Next &rarr;</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'webviewReady' });

    let currentOverview = null;
    let currentPreview = null;
    let allColumns = [];
    let allSnapshots = [];
    let snapshotPage = 0;
    const SNAPSHOTS_PER_PAGE = 10;

    // Breadcrumbs
    document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) {
        vscode.postMessage({
          type: 'breadcrumbNavigate',
          segment: parseInt(btn.getAttribute('data-idx') || '0', 10),
        });
      }
    });

    // Retry
    document.getElementById('retry-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    // Action buttons
    document.getElementById('query-btn')?.addEventListener('click', () => {
      if (currentOverview) {
        vscode.postMessage({
          type: 'openAdHocQuery',
          resourcePath: currentOverview.tablePath,
          initialSql: currentOverview.viewSql,
        });
      }
    });

    document.getElementById('copy-sql-btn')?.addEventListener('click', () => {
      if (currentOverview?.viewSql) {
        navigator.clipboard?.writeText(currentOverview.viewSql).catch(() => {});
        const btn = document.getElementById('copy-sql-btn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
      }
    });

    document.getElementById('view-metadata-btn')?.addEventListener('click', () => {
      if (currentOverview?.latestMetadataPath) {
        vscode.postMessage({ type: 'openMetadataPanel', resourcePath: currentOverview.latestMetadataPath });
      }
    });

    document.getElementById('view-dag-btn')?.addEventListener('click', () => {
      if (currentOverview) {
        vscode.postMessage({ type: 'openMetadataArchitecture', resourcePath: currentOverview.tablePath });
      }
    });

    document.getElementById('load-preview-btn')?.addEventListener('click', () => {
      if (currentOverview) {
        document.getElementById('preview-loading').style.display = 'block';
        document.getElementById('preview-wrapper').style.display = 'none';
        vscode.postMessage({ type: 'fetchDataPreview', tablePath: currentOverview.tablePath });
      }
    });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.style.display = 'none');
        btn.classList.add('active');
        const tabKey = btn.getAttribute('data-tab');
        document.getElementById('tab-' + tabKey).style.display = 'block';

        if (tabKey === 'preview' && !currentPreview) {
          document.getElementById('preview-loading').style.display = 'block';
          vscode.postMessage({ type: 'fetchDataPreview', tablePath: currentOverview.tablePath });
        }
      });
    });

    // Filter columns
    document.getElementById('schema-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderColumns(allColumns.filter(c => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)));
    });

    // Snapshot pagination
    document.getElementById('snap-prev-btn')?.addEventListener('click', () => {
      if (snapshotPage > 0) {
        snapshotPage--;
        renderSnapshots();
      }
    });

    document.getElementById('snap-next-btn')?.addEventListener('click', () => {
      const maxPage = Math.ceil(allSnapshots.length / SNAPSHOTS_PER_PAGE) - 1;
      if (snapshotPage < maxPage) {
        snapshotPage++;
        renderSnapshots();
      }
    });

    function renderColumns(cols) {
      const tbody = document.getElementById('schema-tbody');
      tbody.innerHTML = '';
      cols.forEach((col) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td style="color: var(--vscode-descriptionForeground);">\${col.id}</td>
          <td><strong>\${esc(col.name)}</strong></td>
          <td><code style="color: var(--vscode-symbolIcon-classForeground, #4ec9b0);">\${esc(col.type)}</code></td>
          <td>\${col.required ? '<span style="color: #f87171;">Required</span>' : '<span style="opacity: 0.7;">Optional</span>'}</td>
          <td style="color: var(--vscode-descriptionForeground);">\${esc(col.doc || '—')}</td>
        \`;
        tbody.appendChild(tr);
      });
      document.getElementById('column-count').textContent = cols.length;
    }

    function renderSnapshots() {
      const list = document.getElementById('snapshots-list');
      list.innerHTML = '';
      const total = allSnapshots.length;
      document.getElementById('snapshots-total').textContent = total;

      const start = snapshotPage * SNAPSHOTS_PER_PAGE;
      const end = Math.min(start + SNAPSHOTS_PER_PAGE, total);
      const pageItems = allSnapshots.slice(start, end);

      const maxPage = Math.max(0, Math.ceil(total / SNAPSHOTS_PER_PAGE) - 1);
      document.getElementById('snap-page-indicator').textContent = \`Page \${snapshotPage + 1} of \${maxPage + 1}\`;
      document.getElementById('snap-prev-btn').disabled = snapshotPage === 0;
      document.getElementById('snap-next-btn').disabled = snapshotPage >= maxPage;

      pageItems.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'timeline-card';
        const op = (s.operation || 'unknown').toLowerCase();
        let opClass = 'op-append';
        if (op.includes('overwrite')) opClass = 'op-overwrite';
        else if (op.includes('replace')) opClass = 'op-replace';
        else if (op.includes('delete')) opClass = 'op-delete';

        const dateStr = new Date(s.timestampMs).toLocaleString();
        const diffSummary = [];
        if (s.addedRecords) diffSummary.push(\`+\${s.addedRecords} records\`);
        if (s.deletedRecords) diffSummary.push(\`-\${s.deletedRecords} records\`);
        if (s.addedFiles) diffSummary.push(\`+\${s.addedFiles} files\`);

        card.innerHTML = \`
          <div class="timeline-left">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="timeline-id">#\${s.snapshotId}</span>
              <span class="op-badge \${opClass}">\${esc(s.operation || 'commit')}</span>
            </div>
            <div class="timeline-meta">\${dateStr} \${s.parentSnapshotId ? ' &bull; parent: #' + s.parentSnapshotId : ''}</div>
          </div>
          <div style="font-size: 0.85rem; color: var(--vscode-descriptionForeground);">
            \${diffSummary.join(' &bull; ')}
          </div>
        \`;
        list.appendChild(card);
      });
    }

    function renderPreview(data) {
      document.getElementById('preview-loading').style.display = 'none';
      const wrapper = document.getElementById('preview-wrapper');
      const errBox = document.getElementById('preview-error');

      if (data.error) {
        errBox.textContent = data.error;
        errBox.style.display = 'block';
        wrapper.style.display = 'none';
        return;
      }
      errBox.style.display = 'none';
      wrapper.style.display = 'block';

      const thead = document.getElementById('preview-thead');
      const tbody = document.getElementById('preview-tbody');
      thead.innerHTML = '';
      tbody.innerHTML = '';

      const tr = document.createElement('tr');
      data.columns.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        tr.appendChild(th);
      });
      thead.appendChild(tr);

      data.rows.forEach((row) => {
        const tr = document.createElement('tr');
        data.columns.forEach((col) => {
          const td = document.createElement('td');
          const val = row[col];
          td.textContent = val !== null && val !== undefined ? String(val) : 'NULL';
          if (val === null || val === undefined) {
            td.style.color = 'var(--vscode-descriptionForeground)';
            td.style.fontStyle = 'italic';
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      document.getElementById('preview-row-count').textContent = data.rows.length;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'setState') {
        if (msg.state === 'loading') {
          document.getElementById('loading').style.display = 'block';
          document.getElementById('error').style.display = 'none';
          document.getElementById('content').style.display = 'none';
        } else if (msg.state === 'error') {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('error-message').textContent = msg.message || 'An error occurred.';
          document.getElementById('content').style.display = 'none';
        } else if (msg.state === 'idle') {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'none';
          document.getElementById('content').style.display = 'block';
        }
      } else if (msg.type === 'loadTableOverview') {
        currentOverview = msg;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        document.getElementById('table-name').textContent = msg.tableName;
        const vBadge = document.getElementById('version-badge');
        if (msg.isView) {
          vBadge.textContent = 'VIEW (v' + msg.formatVersion + ')';
          vBadge.className = 'badge';
          vBadge.style.background = '#0284c7';
          vBadge.style.color = '#fff';

          // Views are metadata-only objects; querying and data previews are not applicable
          document.getElementById('query-btn').style.display = 'none';
          document.getElementById('view-dag-btn').style.display = 'none';
          document.getElementById('item-current-snapshot').style.display = 'none';
          document.getElementById('partition-section').style.display = 'none';
          document.getElementById('tab-btn-preview').style.display = 'none';

          document.getElementById('item-view-uuid').style.display = 'inline';
          document.getElementById('view-uuid').textContent = msg.viewUuid || msg.tableUuid;
          document.getElementById('item-current-version').style.display = 'inline';
          document.getElementById('current-version').textContent = 'v' + (msg.currentVersionId ?? 1);

          if (msg.defaultNamespace && msg.defaultNamespace.length > 0) {
            document.getElementById('item-default-namespace').style.display = 'inline';
            document.getElementById('default-namespace').textContent = msg.defaultNamespace.join('.');
          } else {
            document.getElementById('item-default-namespace').style.display = 'none';
          }

          if (msg.defaultCatalog) {
            document.getElementById('item-default-catalog').style.display = 'inline';
            document.getElementById('default-catalog').textContent = msg.defaultCatalog;
          } else {
            document.getElementById('item-default-catalog').style.display = 'none';
          }

          document.getElementById('tab-btn-sql').style.display = 'inline-block';
          document.getElementById('tab-btn-snapshots').textContent = 'Versions & History';
          document.getElementById('view-sql-code').textContent = msg.viewSql || 'No SQL definition available.';
          document.getElementById('view-dialect-badge').textContent = (msg.viewDialect || 'sql').toUpperCase();

          // If current tab is preview, switch to View SQL tab
          const activeTabBtn = document.querySelector('.tab-btn.active');
          if (activeTabBtn && activeTabBtn.getAttribute('data-tab') === 'preview') {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById('tab-btn-sql').classList.add('active');
            document.getElementById('tab-sql').classList.add('active');
          }
        } else {
          vBadge.textContent = 'v' + msg.formatVersion;
          vBadge.className = 'badge badge-v' + msg.formatVersion;
          vBadge.style.background = '';
          vBadge.style.color = '';

          document.getElementById('query-btn').style.display = 'inline-flex';
          document.getElementById('view-dag-btn').style.display = 'inline-flex';
          document.getElementById('item-current-snapshot').style.display = 'inline';
          document.getElementById('partition-section').style.display = 'block';
          document.getElementById('tab-btn-preview').style.display = 'inline-block';

          document.getElementById('item-view-uuid').style.display = 'none';
          document.getElementById('item-current-version').style.display = 'none';
          document.getElementById('item-default-namespace').style.display = 'none';
          document.getElementById('item-default-catalog').style.display = 'none';

          document.getElementById('tab-btn-sql').style.display = 'none';
          document.getElementById('tab-btn-snapshots').textContent = 'Snapshots History';
        }

        document.getElementById('table-location').textContent = msg.location;
        document.getElementById('current-snapshot').textContent = msg.currentSnapshotId || 'None';
        document.getElementById('table-updated').textContent = msg.lastUpdatedMs ? new Date(msg.lastUpdatedMs).toLocaleString() : 'Unknown';

        // Partition Spec
        const pChips = document.getElementById('partition-chips');
        pChips.innerHTML = '';
        if (msg.partitionSpec && msg.partitionSpec.length > 0) {
          msg.partitionSpec.forEach((p) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = \`\${p.name} (\${p.transform})\`;
            pChips.appendChild(chip);
          });
        } else {
          pChips.innerHTML = '<span style="color: var(--vscode-descriptionForeground); font-style: italic;">Unpartitioned</span>';
        }

        // Columns
        allColumns = msg.columns || [];
        renderColumns(allColumns);

        // Properties
        const pTbody = document.getElementById('properties-tbody');
        pTbody.innerHTML = '';
        const props = Object.entries(msg.properties || {});
        if (props.length > 0) {
          props.forEach(([k, v]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`<td style="font-family: monospace;">\${esc(k)}</td><td>\${esc(v)}</td>\`;
            pTbody.appendChild(tr);
          });
          document.getElementById('properties-section').style.display = 'block';
        } else {
          document.getElementById('properties-section').style.display = 'none';
        }

        // Snapshots or View Versions
        if (msg.isView && Array.isArray(msg.viewVersions) && msg.viewVersions.length > 0) {
          allSnapshots = msg.viewVersions.map((v) => ({
            snapshotId: 'v' + v.versionId,
            parentSnapshotId: null,
            timestampMs: v.timestampMs,
            operation: (v.representations && v.representations[0]?.dialect) ? v.representations[0].dialect.toUpperCase() : 'VIEW',
            addedRecords: undefined,
            deletedRecords: undefined,
            addedFiles: undefined,
            manifestList: undefined,
          }));
        } else {
          allSnapshots = msg.snapshots || [];
        }
        snapshotPage = 0;
        renderSnapshots();

      } else if (msg.type === 'loadDataPreview') {
        currentPreview = msg;
        renderPreview(msg);
      }
    });

    function esc(s) {
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
