/**
 * Manifest File Panel — HTML shell and client-side renderer.
 *
 * Implements FR-12: display manifest file entries from an Avro manifest file.
 * NFR-8: CSP nonce. NFR-9: --vscode-* colours only. FR-18: breadcrumbs.
 * FR-20: user-readable errors. A-5: ORC files have no preview link.
 */
import { generateNonce } from './metadataDetail.js';
import {
  escHtml,
  breadcrumbHtml,
  BREADCRUMB_CSS,
  TABLE_CSS,
  SET_STATE_SCRIPT,
  ESC_SCRIPT,
} from './shared.js';

export { generateNonce };

/**
 * Produce the HTML shell for the manifest file panel.
 */
export function getManifestFileHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifest File</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0; padding: 0 1rem 2rem;
    }
${BREADCRUMB_CSS}
    #loading { padding: 1rem; color: var(--vscode-descriptionForeground); }
    #error {
      display: none; padding: 1rem; color: var(--vscode-editorError-foreground);
      border: 1px solid var(--vscode-editorError-foreground); border-radius: 4px; margin-top: 1rem;
    }
    #error-message { margin-bottom: 0.5rem; }
    #retry-btn {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 0.4rem 0.8rem; cursor: pointer; border-radius: 3px;
    }
    #retry-btn:hover { background: var(--vscode-button-hoverBackground); }
${TABLE_CSS}
    .badge {
      display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px;
      font-size: 0.85em; font-weight: 600;
    }
    .badge-existing { color: var(--vscode-disabledForeground); }
    .badge-added    { color: var(--vscode-terminal-ansiGreen); }
    .badge-deleted  { color: var(--vscode-terminal-ansiRed); }
    .file-link {
      color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;
      background: none; border: none; padding: 0; font: inherit; text-align: left;
    }
    .file-link:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="loading">Loading manifest file…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>File Path</th>
          <th>Format</th>
          <th>Record Count</th>
          <th>File Size</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${SET_STATE_SCRIPT}
${ESC_SCRIPT}

    function renderRows(rows) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'none';
      document.getElementById('table-wrapper').style.display = 'block';
      const tbody = document.getElementById('tbody');
      tbody.innerHTML = '';
      for (const row of rows) {
        const basename = row.filePath.split('/').pop() || row.filePath;
        const fmt = (row.fileFormat || '').toUpperCase();
        const isParquet = fmt === 'PARQUET';
        const fileCell = isParquet
          ? '<button class="file-link" title="' + escAttr(row.filePath) + '" data-path="' + escAttr(row.filePath) + '">' + escHtml(basename) + '</button>'
          : '<span title="' + escAttr(row.filePath) + '">' + escHtml(basename) + '</span>';

        const badgeClass = row.status === 1 ? 'badge-added' : row.status === 2 ? 'badge-deleted' : 'badge-existing';
        const statusText = row.status === 0 ? 'EXISTING' : row.status === 1 ? 'ADDED' : row.status === 2 ? 'DELETED' : String(row.status);

        const size = row.fileSizeBytes != null
          ? (row.fileSizeBytes >= 1048576
             ? (row.fileSizeBytes / 1048576).toFixed(1) + ' MB'
             : row.fileSizeBytes >= 1024
             ? (row.fileSizeBytes / 1024).toFixed(1) + ' KB'
             : row.fileSizeBytes + ' B')
          : '—';

        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><span class="badge ' + badgeClass + '">' + statusText + '</span></td>' +
          '<td>' + fileCell + '</td>' +
          '<td>' + escHtml(fmt || '—') + '</td>' +
          '<td>' + (row.recordCount ?? '—') + '</td>' +
          '<td>' + size + '</td>';
        tbody.appendChild(tr);
      }
    }

    document.getElementById('tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.file-link');
      if (btn) { vscode.postMessage({ type: 'openParquetPreview', resourcePath: btn.dataset.path }); }
    });

    document.getElementById('retry-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('breadcrumb').addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) { vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) }); }
    });

    const previousState = vscode.getState();
    if (previousState?.type === 'loadManifestFile' && Array.isArray(previousState.rows)) {
      try { renderRows(previousState.rows); } catch (_) {}
    } else if (previousState?.type === 'setState' && previousState.state === 'error') {
      applyState(previousState);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'setState') {
        if (msg.state !== 'loading' || !vscode.getState() || vscode.getState().type !== 'loadManifestFile') {
          vscode.setState(msg);
          applyState(msg);
        }
        return;
      }

      if (msg.type === 'loadManifestFile') {
        try {
          vscode.setState({ type: 'loadManifestFile', rows: msg.rows });
          renderRows(msg.rows);
        } catch (err) {
          // swallow render errors
        }
      }
    });

    // Signal readiness only after the message listener is registered.
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
