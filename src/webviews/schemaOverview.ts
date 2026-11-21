/**
 * Schema Overview Webview Client Script
 *
 * Implements:
 *  - Schema details card
 *  - Tables count in this schema
 *  - Searchable list of tables in this schema
 *  - Direct jump to Table Overview or SQL Query
 */
import { esc } from './shared.js';

interface DiscoveredTable {
  name: string;
  path: string;
  schema: string;
}

interface SchemaOverviewPayload {
  type: 'loadSchemaOverview';
  schemaName: string;
  schemaPath: string;
  warehouseLabel?: string;
  warehousePath?: string;
  tablesCount: number;
  tables: DiscoveredTable[];
  initialFilter?: string;
}

const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady' });

let currentSchema: SchemaOverviewPayload | null = null;
let allTables: DiscoveredTable[] = [];

document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.breadcrumb-link') as HTMLElement | null;
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
  if (currentSchema?.tables && currentSchema.tables.length > 0) {
    vscode.postMessage({ type: 'openAdHocQuery', resourcePath: currentSchema.tables[0].path });
  } else {
    alert('No Iceberg tables found in this schema.');
  }
});

document.getElementById('table-search')?.addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  const q = target.value.toLowerCase();
  renderTables(allTables.filter((t) => t.name.toLowerCase().includes(q) || t.path.toLowerCase().includes(q)));
});

function renderTables(tables: DiscoveredTable[]): void {
  const countEl = document.getElementById('tables-count');
  if (countEl) {
    countEl.textContent = String(tables.length);
  }
  const tbody = document.getElementById('tables-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (tables.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 2rem;">No tables found in this schema</td></tr>';
    return;
  }

  tables.forEach((t) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><button class="table-link" data-action="overview" data-path="${esc(t.path)}" title="Open table overview">${esc(t.name)}</button></td>
      <td style="font-family: monospace; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">${esc(t.path)}</td>
      <td>
        <button class="action-link" data-action="overview" data-path="${esc(t.path)}">Overview</button>
        <button class="action-link" data-action="query" data-path="${esc(t.path)}">Query SQL</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('tables-tbody')?.addEventListener('click', (e) => {
  const targetEl = e.target as HTMLElement | null;
  const target = targetEl?.closest('[data-action]') as HTMLElement | null;
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
  } else if (msg.type === 'loadSchemaOverview') {
    currentSchema = msg;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    const titleEl = document.getElementById('schema-title');
    const nameValEl = document.getElementById('schema-name-val');
    const pathValEl = document.getElementById('schema-path-val');
    const whValEl = document.getElementById('schema-wh-val');
    const statTablesEl = document.getElementById('stat-tables');

    if (titleEl) titleEl.textContent = msg.schemaName || 'Schema';
    if (nameValEl) nameValEl.textContent = msg.schemaName || 'default';
    if (pathValEl) pathValEl.textContent = msg.schemaPath;

    const whText = msg.warehouseLabel ? (msg.warehouseLabel + ' (' + (msg.warehousePath || '') + ')') : (msg.warehousePath || '');
    if (whValEl) whValEl.textContent = whText;

    if (statTablesEl) statTablesEl.textContent = String(msg.tablesCount);

    allTables = msg.tables || [];
    const searchInput = document.getElementById('table-search') as HTMLInputElement | null;
    const filterVal = msg.initialFilter || '';
    if (searchInput) {
      searchInput.value = filterVal;
    }
    const q = filterVal.toLowerCase();
    if (q) {
      renderTables(allTables.filter((t) => (t.name && t.name.toLowerCase().includes(q)) || (t.path && t.path.toLowerCase().includes(q))));
    } else {
      renderTables(allTables);
    }
  } else if (msg.type === 'setFilter') {
    const searchInput = document.getElementById('table-search') as HTMLInputElement | null;
    const filterVal = msg.filter || '';
    if (searchInput) {
      searchInput.value = filterVal;
    }
    const q = filterVal.toLowerCase();
    if (q) {
      renderTables(allTables.filter((t) => (t.name && t.name.toLowerCase().includes(q)) || (t.path && t.path.toLowerCase().includes(q))));
    } else {
      renderTables(allTables);
    }
  }
});

