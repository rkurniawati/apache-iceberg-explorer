/**
 * Connection Dashboard Webview Client Script
 *
 * Implements:
 *  - Connection details card
 *  - Warehouse catalog summary
 *  - Searchable schemas roster with direct jump buttons
 *  - Quick launch action bar
 */
import { esc } from './shared.js';

interface DiscoveredSchema {
  name: string;
  path: string;
  tableCount: number;
}

interface DiscoveredTable {
  name: string;
  path: string;
  schema: string;
}

interface ConnectionDashboardPayload {
  type: 'loadConnectionDashboard';
  connectionId?: string;
  connectionLabel: string;
  connectionType: string;
  warehousePath: string;
  region?: string;
  endpointUrl?: string;
  schemasCount: number;
  tablesCount: number;
  schemas: DiscoveredSchema[];
  tables: DiscoveredTable[];
  initialFilter?: string;
}

const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady' });

let currentDashboard: ConnectionDashboardPayload | null = null;
let allSchemas: DiscoveredSchema[] = [];

document.getElementById('retry-btn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'retry' });
});

document.getElementById('new-query-btn')?.addEventListener('click', () => {
  if (currentDashboard?.tables && currentDashboard.tables.length > 0) {
    vscode.postMessage({ type: 'openAdHocQuery', resourcePath: currentDashboard.tables[0].path });
  } else {
    alert('No Iceberg tables discovered in this catalog yet.');
  }
});

document.getElementById('edit-settings-btn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'editConnection', connectionId: currentDashboard?.connectionId });
});

document.getElementById('schema-search')?.addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  const q = target.value.toLowerCase();
  renderSchemas(allSchemas.filter((s) => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
});

function renderSchemas(schemas: DiscoveredSchema[]): void {
  const countEl = document.getElementById('schemas-count');
  if (countEl) {
    countEl.textContent = String(schemas.length);
  }
  const tbody = document.getElementById('schemas-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (schemas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 2rem;">No schemas found</td></tr>';
    return;
  }

  schemas.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><button class="table-link" data-action="open-schema" data-path="${esc(s.path)}" data-name="${esc(s.name)}" title="Open schema overview"><code style="color: var(--vscode-symbolIcon-classForeground, #4ec9b0); font-family: inherit; font-size: inherit;">${esc(s.name)}</code></button></td>
      <td style="font-family: monospace; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">${esc(s.path)}</td>
      <td>${s.tableCount} table${s.tableCount === 1 ? '' : 's'}</td>
      <td>
        <button class="action-link" data-action="open-schema" data-path="${esc(s.path)}" data-name="${esc(s.name)}">View Tables</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('schemas-tbody')?.addEventListener('click', (e) => {
  const targetEl = e.target as HTMLElement | null;
  const target = targetEl?.closest('[data-action]') as HTMLElement | null;
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

  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const errorMsgEl = document.getElementById('error-message');
  const contentEl = document.getElementById('content');

  if (msg.type === 'setState') {
    if (msg.state === 'loading') {
      if (loadingEl) loadingEl.style.display = 'block';
      if (errorEl) errorEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'none';
    } else if (msg.state === 'error') {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'block';
      if (errorMsgEl) errorMsgEl.textContent = msg.message || 'An error occurred.';
      if (contentEl) contentEl.style.display = 'none';
    } else if (msg.state === 'idle') {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'block';
    }
  } else if (msg.type === 'loadConnectionDashboard') {
    currentDashboard = msg;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    const titleEl = document.getElementById('conn-title');
    const typeEl = document.getElementById('conn-type');
    const pathEl = document.getElementById('conn-path');
    const regionEl = document.getElementById('conn-region');
    const regionRow = document.getElementById('region-row');
    const endpointEl = document.getElementById('conn-endpoint');
    const endpointRow = document.getElementById('endpoint-row');
    const statSchemasEl = document.getElementById('stat-schemas');
    const statTablesEl = document.getElementById('stat-tables');

    if (titleEl) titleEl.textContent = msg.connectionLabel || 'Warehouse';
    if (typeEl) typeEl.textContent = (msg.connectionType || 'local').toUpperCase();
    if (pathEl) pathEl.textContent = msg.warehousePath;

    if (msg.region) {
      if (regionEl) regionEl.textContent = msg.region;
      if (regionRow) regionRow.style.display = 'flex';
    }
    if (msg.endpointUrl) {
      if (endpointEl) endpointEl.textContent = msg.endpointUrl;
      if (endpointRow) endpointRow.style.display = 'flex';
    }

    if (statSchemasEl) statSchemasEl.textContent = String(msg.schemasCount);
    if (statTablesEl) statTablesEl.textContent = String(msg.tablesCount);

    allSchemas = msg.schemas || [];
    const searchInput = document.getElementById('schema-search') as HTMLInputElement | null;
    const filterVal = msg.initialFilter || '';
    if (searchInput) {
      searchInput.value = filterVal;
    }
    const q = filterVal.toLowerCase();
    if (q) {
      renderSchemas(allSchemas.filter((s) => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
    } else {
      renderSchemas(allSchemas);
    }
  } else if (msg.type === 'setFilter') {
    const searchInput = document.getElementById('schema-search') as HTMLInputElement | null;
    const filterVal = msg.filter || '';
    if (searchInput) {
      searchInput.value = filterVal;
    }
    const q = filterVal.toLowerCase();
    if (q) {
      renderSchemas(allSchemas.filter((s) => (s.name && s.name.toLowerCase().includes(q)) || (s.path && s.path.toLowerCase().includes(q))));
    } else {
      renderSchemas(allSchemas);
    }
  }
});

