/**
 * Ad-hoc Query Panel — HTML shell and client-side renderer.
 *
 * Implements FR-14–FR-17: SQL textarea, Run button, Cancel button, results table.
 * FR-16: Cancel button visible during loading. FR-17: timeout handled in QueryEngine.
 * NFR-8: CSP nonce. NFR-9: --vscode-* colours. FR-18: breadcrumbs. FR-20: errors.
 */
import { generateNonce } from './metadataDetail.js';
import {
  breadcrumbHtml,
  BREADCRUMB_CSS,
  RENDER_TABLE_SCRIPT,
} from './shared.js';

export { generateNonce };

/**
 * Produce the HTML shell for the ad-hoc query panel.
 * Starts in `idle` state: textarea + Run visible; results and errors hidden.
 */
export function getAdHocQueryHtml(
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
  <title>Ad-hoc Query</title>
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
    #query-area { margin-bottom: 0.75rem; }
    #sql-input {
      width: 100%; min-height: 6rem; max-height: 20rem;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      padding: 0.4rem; resize: vertical;
    }
    #sql-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #btn-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
    #run-btn {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 0.4rem 0.9rem; cursor: pointer; border-radius: 3px;
    }
    #run-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #run-btn:disabled { opacity: 0.5; cursor: default; }
    #cancel-btn {
      display: none;
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-secondaryBackground); padding: 0.4rem 0.9rem;
      cursor: pointer; border-radius: 3px;
    }
    #cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status-text { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #cap-banner {
      display: none; padding: 0.4rem 0.8rem; margin-bottom: 0.5rem;
      background: var(--vscode-inputValidation-warningBackground, #332b00);
      color: var(--vscode-inputValidation-warningForeground, #cca700);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      border-radius: 3px;
    }
    #error-area {
      display: none; padding: 0.75rem; color: var(--vscode-editorError-foreground);
      border: 1px solid var(--vscode-editorError-foreground); border-radius: 4px; margin-bottom: 0.5rem;
      white-space: pre-wrap; word-break: break-word;
    }
    #table-wrapper { display: none; overflow: auto; max-height: 60vh; }
    table { border-collapse: collapse; font-size: var(--vscode-font-size, 13px); min-width: 100%; }
    th {
      text-align: left; padding: 0.4rem 0.6rem; position: sticky; top: 0;
      border-bottom: 2px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground); font-weight: 600;
    }
    td { padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--vscode-editorWidget-border); white-space: nowrap; }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
  </style>
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="query-area">
    <textarea id="sql-input" placeholder="SELECT * FROM data LIMIT 100">SELECT * FROM data LIMIT 100;</textarea>
    <div id="btn-row">
      <button id="run-btn">Run</button>
      <button id="cancel-btn">Cancel</button>
      <span id="status-text"></span>
    </div>
  </div>
  <div id="cap-banner"></div>
  <div id="error-area"></div>
  <div id="table-wrapper">
    <table>
      <thead><tr id="header-row"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let isLoading = false;
${RENDER_TABLE_SCRIPT}

    document.getElementById('run-btn').addEventListener('click', () => {
      if (isLoading) return;
      const inputEl = document.getElementById('sql-input');
      const sql = (inputEl.value.trim() || inputEl.placeholder.trim());
      if (!sql) return;
      vscode.postMessage({ type: 'runQuery', sql });
    });

    document.getElementById('cancel-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelQuery' });
    });

    document.getElementById('breadcrumb').addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) { vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) }); }
    });

    function setLoading(on) {
      isLoading = on;
      document.getElementById('run-btn').disabled = on;
      document.getElementById('cancel-btn').style.display = on ? 'inline-block' : 'none';
      document.getElementById('status-text').textContent = on ? 'Running…' : '';
    }

    function setIdle() {
      setLoading(false);
      document.getElementById('error-area').style.display = 'none';
      document.getElementById('cap-banner').style.display = 'none';
      document.getElementById('table-wrapper').style.display = 'none';
      document.getElementById('status-text').textContent = '';
      const st = vscode.getState() || {};
      vscode.setState({ sql: st.sql });
    }

    const previousState = vscode.getState();
    if (previousState?.sql) {
      document.getElementById('sql-input').value = previousState.sql;
    }
    if (previousState?.type === 'loadQueryResult' && previousState.result) {
      document.getElementById('table-wrapper').style.display = 'block';
      if (previousState.capMessage) {
        const banner = document.getElementById('cap-banner');
        banner.textContent = previousState.capMessage;
        banner.style.display = 'block';
      }
      renderTable(previousState.result.columnNames, previousState.result.rows);
    } else if (previousState?.error) {
      document.getElementById('error-area').style.display = 'block';
      document.getElementById('error-area').textContent = previousState.error;
    }

    document.getElementById('sql-input').addEventListener('input', (e) => {
      const st = vscode.getState() || {};
      vscode.setState({ ...st, sql: e.target.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'setState') {
        if (msg.state === 'loading') {
          setLoading(true);
          document.getElementById('error-area').style.display = 'none';
          document.getElementById('cap-banner').style.display = 'none';
          document.getElementById('table-wrapper').style.display = 'none';
        } else if (msg.state === 'error') {
          setLoading(false);
          document.getElementById('error-area').style.display = 'block';
          document.getElementById('error-area').textContent = msg.message || 'An error occurred.';
          const st = vscode.getState() || {};
          vscode.setState({ ...st, error: msg.message });
        } else if (msg.state === 'idle') {
          setIdle();
        }
        return;
      }

      if (msg.type === 'showCapBanner') {
        const banner = document.getElementById('cap-banner');
        banner.textContent = msg.message;
        banner.style.display = 'block';
        const st = vscode.getState() || {};
        vscode.setState({ ...st, capMessage: msg.message });
        return;
      }

      if (msg.type === 'loadQueryResult') {
        setLoading(false);
        document.getElementById('error-area').style.display = 'none';
        document.getElementById('table-wrapper').style.display = 'block';
        renderTable(msg.result.columnNames, msg.result.rows);
        const st = vscode.getState() || {};
        vscode.setState({ ...st, type: 'loadQueryResult', result: msg.result, error: null });
      }
    });

    // Signal readiness only after the message listener is registered.
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
