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
  RENDER_TABLE_SCRIPT,
  escHtml,
} from './shared.js';

export { generateNonce };

export interface AdHocQueryStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the ad-hoc query panel.
 * Starts in `idle` state: textarea + Run visible; results and errors hidden.
 */
export function getAdHocQueryHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  initialSql?: string,
  styleUris?: AdHocQueryStyleUris,
): string {
  const queryText = initialSql ? escHtml(initialSql) : 'SELECT * FROM data LIMIT 100;';
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/adHocQuery.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ad-hoc Query</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="query-area">
    <textarea id="sql-input" placeholder="SELECT * FROM data LIMIT 100">${queryText}</textarea>
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
