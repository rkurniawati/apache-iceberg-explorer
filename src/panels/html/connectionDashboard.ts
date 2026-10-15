/**
 * Connection Dashboard Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Connection details card
 *  - Warehouse catalog summary
 *  - Searchable tables roster with direct jump buttons
 *  - Quick launch action bar
 */
import { escHtml } from './shared.js';
import type { LoadConnectionDashboardMessage } from '../messages.js';

export interface ConnectionDashboardStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

export function getConnectionDashboardHtml(
  nonce: string,
  cspSource: string,
  styleUris?: ConnectionDashboardStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/connectionDashboard.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection Dashboard</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
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

    <!-- Schemas Roster -->
    <div class="roster-header">
      <div class="roster-title">Schemas (<span id="schemas-count">0</span>)</div>
      <input type="text" class="search-input" id="schema-search" placeholder="Search schemas…">
    </div>

    <div style="overflow-x: auto;">
      <table id="schemas-table">
        <thead>
          <tr>
            <th style="width: 260px;">Schema / Namespace</th>
            <th>Location URI</th>
            <th style="width: 140px;">Tables</th>
            <th style="width: 160px;">Actions</th>
          </tr>
        </thead>
        <tbody id="schemas-tbody"></tbody>
      </table>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'webviewReady' });

    let currentDashboard = null;
    let allSchemas = [];

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

    document.getElementById('schema-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderSchemas(allSchemas.filter(s => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
    });

    function renderSchemas(schemas) {
      const countEl = document.getElementById('schemas-count');
      if (countEl) {
        countEl.textContent = schemas.length;
      }
      const tbody = document.getElementById('schemas-tbody');
      tbody.innerHTML = '';
      if (schemas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 2rem;">No schemas found</td></tr>';
        return;
      }

      schemas.forEach((s) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><button class="table-link" data-action="open-schema" data-path="\${esc(s.path)}" data-name="\${esc(s.name)}" title="Open schema overview"><code style="color: var(--vscode-symbolIcon-classForeground, #4ec9b0); font-family: inherit; font-size: inherit;">\${esc(s.name)}</code></button></td>
          <td style="font-family: monospace; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">\${esc(s.path)}</td>
          <td>\${s.tableCount} table\${s.tableCount === 1 ? '' : 's'}</td>
          <td>
            <button class="action-link" data-action="open-schema" data-path="\${esc(s.path)}" data-name="\${esc(s.name)}">View Tables</button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
    }

    document.getElementById('schemas-tbody')?.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (target) {
        const action = target.getAttribute('data-action');
        const path = target.getAttribute('data-path');
        const name = target.getAttribute('data-name');
        if (action === 'open-schema' && path) {
          vscode.postMessage({ type: 'openSchemaOverview', schemaPath: path, schemaName: name });
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

        allSchemas = msg.schemas || [];
        const searchInput = document.getElementById('schema-search');
        const filterVal = msg.initialFilter || '';
        if (searchInput) {
          searchInput.value = filterVal;
        }
        const q = filterVal.toLowerCase();
        if (q) {
          renderSchemas(allSchemas.filter(s => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
        } else {
          renderSchemas(allSchemas);
        }
      } else if (msg.type === 'setFilter') {
        const searchInput = document.getElementById('schema-search');
        const filterVal = msg.filter || '';
        if (searchInput) {
          searchInput.value = filterVal;
        }
        const q = filterVal.toLowerCase();
        if (q) {
          renderSchemas(allSchemas.filter(s => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
        } else {
          renderSchemas(allSchemas);
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
