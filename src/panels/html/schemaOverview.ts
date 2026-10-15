/**
 * Schema Overview Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Schema details card
 *  - Tables count in this schema
 *  - Searchable list of tables in this schema
 *  - Direct jump to Table Overview or SQL Query
 */
import { escHtml, breadcrumbHtml } from './shared.js';
import type { LoadSchemaOverviewMessage } from '../messages.js';

export interface SchemaOverviewStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

export function getSchemaOverviewHtml(
  nonce: string,
  cspSource: string,
  schemaPath: string,
  styleUris?: SchemaOverviewStyleUris,
): string {
  const initialBreadcrumb = breadcrumbHtml(schemaPath);
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/schemaOverview.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Overview</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div>Loading schema tables…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to load schema</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div class="header-title-row">
        <h1 id="schema-title">Schema</h1>
        <span class="status-badge"><span class="status-dot"></span> Schema</span>
      </div>
      <div class="actions-bar">
        <button class="btn btn-secondary" id="warehouse-btn">🏠 Warehouse Overview</button>
        <button class="btn" id="new-query-btn">📝 New SQL Query</button>
      </div>
    </div>

    <div class="cards-grid">
      <!-- Card 1: Schema Details -->
      <div class="card">
        <div class="card-title">Schema Configuration</div>
        <div class="card-row">
          <span class="card-row-label">Schema:</span>
          <span class="card-row-val" id="schema-name-val"></span>
        </div>
        <div class="card-row">
          <span class="card-row-label">Location:</span>
          <span class="card-row-val" id="schema-path-val" style="font-family: monospace;"></span>
        </div>
        <div class="card-row" id="warehouse-row">
          <span class="card-row-label">Warehouse:</span>
          <span class="card-row-val" id="schema-wh-val"></span>
        </div>
      </div>

      <!-- Card 2: Tables Inventory -->
      <div class="card">
        <div class="card-title">Schema Inventory</div>
        <div style="display: flex; gap: 2rem; margin-top: 0.5rem;">
          <div>
            <div class="card-main-val" id="stat-tables">0</div>
            <div style="font-size: 0.8rem; color: var(--vscode-descriptionForeground);">Iceberg Tables</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tables in Schema Roster -->
    <div class="roster-header">
      <div class="roster-title">Tables (<span id="tables-count">0</span>)</div>
      <input type="text" class="search-input" id="table-search" placeholder="Search tables in this schema…">
    </div>

    <div style="overflow-x: auto;">
      <table id="tables-table">
        <thead>
          <tr>
            <th>Table Name</th>
            <th>Location URI</th>
            <th style="width: 200px;">Actions</th>
          </tr>
        </thead>
        <tbody id="tables-tbody"></tbody>
      </table>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'webviewReady' });

    let currentSchema = null;
    let allTables = [];

    document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) {
        vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) });
      }
    });

    document.getElementById('retry-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('warehouse-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openConnectionDashboard' });
    });

    document.getElementById('new-query-btn')?.addEventListener('click', () => {
      if (currentSchema?.tables?.length > 0) {
        vscode.postMessage({ type: 'openAdHocQuery', resourcePath: currentSchema.tables[0].path });
      } else {
        alert('No Iceberg tables found in this schema.');
      }
    });

    document.getElementById('table-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderTables(allTables.filter(t => t.name.toLowerCase().includes(q) || t.path.toLowerCase().includes(q)));
    });

    function renderTables(tables) {
      const countEl = document.getElementById('tables-count');
      if (countEl) {
        countEl.textContent = tables.length;
      }
      const tbody = document.getElementById('tables-tbody');
      tbody.innerHTML = '';
      if (tables.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 2rem;">No tables found in this schema</td></tr>';
        return;
      }

      tables.forEach((t) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><button class="table-link" data-action="overview" data-path="\${esc(t.path)}" title="Open table overview">\${esc(t.name)}</button></td>
          <td style="font-family: monospace; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">\${esc(t.path)}</td>
          <td>
            <button class="action-link" data-action="overview" data-path="\${esc(t.path)}">Overview</button>
            <button class="action-link" data-action="query" data-path="\${esc(t.path)}">Query SQL</button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
    }

    document.getElementById('tables-tbody')?.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (target) {
        const action = target.getAttribute('data-action');
        const path = target.getAttribute('data-path');
        if (action === 'overview' && path) {
          vscode.postMessage({ type: 'openTableOverview', resourcePath: path });
        } else if (action === 'query' && path) {
          vscode.postMessage({ type: 'openAdHocQuery', resourcePath: path });
        }
      }
    });

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
      } else if (msg.type === 'loadSchemaOverview') {
        currentSchema = msg;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        document.getElementById('schema-title').textContent = msg.schemaName || 'Schema';
        document.getElementById('schema-name-val').textContent = msg.schemaName || 'default';
        document.getElementById('schema-path-val').textContent = msg.schemaPath;

        const whText = msg.warehouseLabel ? (msg.warehouseLabel + ' (' + (msg.warehousePath || '') + ')') : (msg.warehousePath || '');
        document.getElementById('schema-wh-val').textContent = whText;

        document.getElementById('stat-tables').textContent = msg.tablesCount;

        allTables = msg.tables || [];
        const searchInput = document.getElementById('table-search');
        const filterVal = msg.initialFilter || '';
        if (searchInput) {
          searchInput.value = filterVal;
        }
        const q = filterVal.toLowerCase();
        if (q) {
          renderTables(allTables.filter(t => (t.name && t.name.toLowerCase().includes(q)) || (t.path && t.path.toLowerCase().includes(q))));
        } else {
          renderTables(allTables);
        }
      } else if (msg.type === 'setFilter') {
        const searchInput = document.getElementById('table-search');
        const filterVal = msg.filter || '';
        if (searchInput) {
          searchInput.value = filterVal;
        }
        const q = filterVal.toLowerCase();
        if (q) {
          renderTables(allTables.filter(t => (t.name && t.name.toLowerCase().includes(q)) || (t.path && t.path.toLowerCase().includes(q))));
        } else {
          renderTables(allTables);
        }
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
