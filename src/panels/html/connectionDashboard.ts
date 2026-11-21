/**
 * Connection Dashboard Panel — HTML shell generator.
 *
 * Implements:
 *  - Connection details card
 *  - Warehouse catalog summary
 *  - Searchable schemas roster with direct jump buttons
 *  - Quick launch action bar
 *
 * Client-side rendering script is located in src/webviews/connectionDashboard.ts
 * and bundled to out/webviews/connectionDashboard.js.
 */

export interface ConnectionDashboardStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export function getConnectionDashboardHtml(
  nonce: string,
  cspSource: string,
  styleUris?: ConnectionDashboardStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/connectionDashboard.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/connectionDashboard.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
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

  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
