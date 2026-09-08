/**
 * Manifest List Panel — HTML shell and client-side renderer.
 *
 * Implements FR-11: display manifest list entries from an Avro manifest-list file.
 * NFR-8: CSP nonce on all scripts.
 * NFR-9: All colours use --vscode-* variables only.
 * FR-18: Breadcrumb bar.
 * FR-20: User-readable error state.
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
 * Produce the HTML shell for the manifest list panel.
 * Rendered in `loading` state initially; the host posts messages to drive transitions.
 */
export function getManifestListHtml(
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
  <title>Manifest List</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0 1rem 2rem;
    }
${BREADCRUMB_CSS}
    #loading { padding: 1rem; color: var(--vscode-descriptionForeground); }
    #error { display: none; padding: 1rem; color: var(--vscode-editorError-foreground);
      border: 1px solid var(--vscode-editorError-foreground); border-radius: 4px; margin-top: 1rem; }
    #error-message { margin-bottom: 0.5rem; }
    #retry-btn {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 0.4rem 0.8rem; cursor: pointer; border-radius: 3px;
    }
    #retry-btn:hover { background: var(--vscode-button-hoverBackground); }
${TABLE_CSS}
    .manifest-link {
      color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;
      background: none; border: none; padding: 0; font: inherit; text-align: left;
    }
    .manifest-link:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="loading">Loading manifest list…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Manifest Path</th>
          <th>Partition Spec ID</th>
          <th>Content</th>
          <th>Added Files</th>
          <th>Existing Files</th>
          <th>Deleted Files</th>
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
        const basename = row.manifestPath.split('/').pop() || row.manifestPath;
        const contentLabel = row.content === 0 ? 'DATA' : row.content === 1 ? 'DELETES' : String(row.content);
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><button class="manifest-link" title="' + escAttr(row.manifestPath) + '" data-path="' + escAttr(row.manifestPath) + '">' + escHtml(basename) + '</button></td>' +
          '<td>' + row.partitionSpecId + '</td>' +
          '<td>' + contentLabel + '</td>' +
          '<td>' + (row.addedFilesCount ?? '—') + '</td>' +
          '<td>' + (row.existingFilesCount ?? '—') + '</td>' +
          '<td>' + (row.deletedFilesCount ?? '—') + '</td>';
        tbody.appendChild(tr);
      }
    }

    document.getElementById('tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.manifest-link');
      if (btn) { vscode.postMessage({ type: 'openManifestFile', resourcePath: btn.dataset.path }); }
    });

    document.getElementById('retry-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('breadcrumb').addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) { vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) }); }
    });

    const previousState = vscode.getState();
    if (previousState?.type === 'loadManifestList' && Array.isArray(previousState.rows)) {
      try { renderRows(previousState.rows); } catch (_) {}
    } else if (previousState?.type === 'setState' && previousState.state === 'error') {
      applyState(previousState);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'setState') {
        if (msg.state !== 'loading' || !vscode.getState() || vscode.getState().type !== 'loadManifestList') {
          vscode.setState(msg);
          applyState(msg);
        }
        return;
      }

      if (msg.type === 'loadManifestList') {
        try {
          vscode.setState({ type: 'loadManifestList', rows: msg.rows });
          renderRows(msg.rows);
        } catch (err) {
          // swallow render errors — webview remains in loading state
        }
      }
    });

    // Signal readiness only after the message listener is registered so the
    // host's response cannot arrive before we can receive it.
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
