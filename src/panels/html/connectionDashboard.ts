/**
 * Connection Dashboard Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Connection details card
 *  - Warehouse catalog summary
 *  - Searchable tables roster with direct jump buttons
 *  - Quick launch action bar
 */
import { escHtml, TABLE_CSS } from './shared.js';
import type { LoadConnectionDashboardMessage } from '../messages.js';

export function getConnectionDashboardHtml(
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
  <title>Connection Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 1.25rem 1.5rem 2.5rem;
    }

    ${TABLE_CSS}

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      flex-wrap: wrap;
    }
    .header-title-row { display: flex; align-items: center; gap: 0.75rem; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.78rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
    }

    .actions-bar {
      display: flex;
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

    /* ── Metrics Cards Grid ─────────────────────────────────────────────── */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 1rem 1.2rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .card-title {
      font-size: 0.82rem;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0.5px;
    }
    .card-main-val {
      font-size: 1.8rem;
      font-weight: 700;
      color: var(--vscode-editor-foreground);
    }
    .card-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      padding: 0.2rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .card-row-label { color: var(--vscode-descriptionForeground); }
    .card-row-val { font-weight: 500; word-break: break-all; }

    /* ── Table Roster ───────────────────────────────────────────────────── */
    .roster-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .roster-title { font-size: 1.1rem; font-weight: 600; }
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

    .action-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      margin-right: 0.75rem;
    }
    .action-link:hover { opacity: 0.8; }

    .table-link {
      color: var(--vscode-textLink-foreground);
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      text-align: left;
    }
    .table-link:hover {
      text-decoration: underline;
    }

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
  </style>
</head>
<body>
  <div id="loading">
    <div class="spinner"></div>
    <div>Loading warehouse catalog…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to connect to warehouse</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div class="header-title-row">
        <h1 id="conn-title">Connection</h1>
        <span class="status-badge"><span class="status-dot"></span> Active</span>
      </div>
      <div class="actions-bar">
        <button class="btn" id="new-query-btn">📝 New SQL Query</button>
        <button class="btn btn-secondary" id="edit-settings-btn">⚙️ Settings</button>
      </div>
    </div>

    <div class="cards-grid">
      <!-- Card 1: Warehouse Storage -->
      <div class="card">
        <div class="card-title">Storage Configuration</div>
        <div class="card-row">
          <span class="card-row-label">Type:</span>
          <span class="card-row-val" id="conn-type"></span>
        </div>
        <div class="card-row">
          <span class="card-row-label">Warehouse Root:</span>
          <span class="card-row-val" id="conn-path" style="font-family: monospace;"></span>
        </div>
        <div class="card-row" id="region-row" style="display: none;">
          <span class="card-row-label">AWS Region:</span>
          <span class="card-row-val" id="conn-region"></span>
        </div>
        <div class="card-row" id="endpoint-row" style="display: none;">
          <span class="card-row-label">Endpoint:</span>
          <span class="card-row-val" id="conn-endpoint"></span>
        </div>
      </div>

      <!-- Card 2: Catalog Summary -->
      <div class="card">
        <div class="card-title">Catalog Inventory</div>
        <div style="display: flex; gap: 2rem; margin-top: 0.5rem;">
          <div>
            <div class="card-main-val" id="stat-schemas">0</div>
            <div style="font-size: 0.8rem; color: var(--vscode-descriptionForeground);">Namespaces</div>
          </div>
          <div>
            <div class="card-main-val" id="stat-tables">0</div>
            <div style="font-size: 0.8rem; color: var(--vscode-descriptionForeground);">Iceberg Tables</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tables Roster -->
    <div class="roster-header">
      <div class="roster-title">Discovered Tables (<span id="tables-count">0</span>)</div>
      <input type="text" class="search-input" id="table-search" placeholder="Search tables or schemas…">
    </div>

    <div style="overflow-x: auto;">
      <table id="tables-table">
        <thead>
          <tr>
            <th style="width: 250px;">Namespace</th>
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

    let currentDashboard = null;
    let allTables = [];

    document.getElementById('retry-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('new-query-btn')?.addEventListener('click', () => {
      if (currentDashboard?.tables?.length > 0) {
        vscode.postMessage({ type: 'openAdHocQuery', resourcePath: currentDashboard.tables[0].path });
      } else {
        alert('No Iceberg tables discovered in this catalog yet.');
      }
    });

    document.getElementById('edit-settings-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'editConnection', connectionId: currentDashboard?.connectionId });
    });

    document.getElementById('table-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderTables(allTables.filter(t => t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)));
    });

    function renderTables(tables) {
      const countEl = document.getElementById('tables-count');
      if (countEl) {
        countEl.textContent = tables.length;
      }
      const tbody = document.getElementById('tables-tbody');
      tbody.innerHTML = '';
      if (tables.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 2rem;">No tables found</td></tr>';
        return;
      }

      tables.forEach((t) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><code style="color: var(--vscode-symbolIcon-classForeground, #4ec9b0);">\${esc(t.schema)}</code></td>
          <td><button class="table-link" data-action="overview" data-path="\${esc(t.path)}" title="Open table overview">\${esc(t.name)}</button></td>
          <td style="font-family: monospace; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">\${esc(t.path)}</td>
          <td>
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
      } else if (msg.type === 'loadConnectionDashboard') {
        currentDashboard = msg;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        document.getElementById('conn-title').textContent = msg.connectionLabel || 'Warehouse';
        document.getElementById('conn-type').textContent = (msg.connectionType || 'local').toUpperCase();
        document.getElementById('conn-path').textContent = msg.warehousePath;

        if (msg.region) {
          document.getElementById('conn-region').textContent = msg.region;
          document.getElementById('region-row').style.display = 'flex';
        }
        if (msg.endpointUrl) {
          document.getElementById('conn-endpoint').textContent = msg.endpointUrl;
          document.getElementById('endpoint-row').style.display = 'flex';
        }

        document.getElementById('stat-schemas').textContent = msg.schemasCount;
        document.getElementById('stat-tables').textContent = msg.tablesCount;

        allTables = msg.tables || [];
        const searchInput = document.getElementById('table-search');
        const filterVal = msg.initialFilter || '';
        if (searchInput) {
          searchInput.value = filterVal;
        }
        const q = filterVal.toLowerCase();
        if (q) {
          renderTables(allTables.filter(t => (t.name && t.name.toLowerCase().includes(q)) || (t.schema && t.schema.toLowerCase().includes(q))));
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
          renderTables(allTables.filter(t => (t.name && t.name.toLowerCase().includes(q)) || (t.schema && t.schema.toLowerCase().includes(q))));
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
