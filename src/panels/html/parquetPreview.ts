/**
 * Parquet Preview Panel — HTML shell and client-side renderer.
 *
 * Implements FR-13: preview first 100 rows of a Parquet file.
 * NFR-3: row cap with banner. NFR-8: CSP nonce. NFR-9: --vscode-* colours.
 * FR-18: breadcrumbs. FR-20: user-readable errors.
 */
import { generateNonce } from './metadataDetail.js';
import {
  breadcrumbHtml,
  SET_STATE_SCRIPT,
  RENDER_TABLE_SCRIPT,
} from './shared.js';

export { generateNonce };

export interface ParquetPreviewStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the Parquet preview panel.
 */
export function getParquetPreviewHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  styleUris?: ParquetPreviewStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/parquetPreview.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Parquet Preview</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="toolbar">
    <button id="adhoc-btn">Open ad-hoc query →</button>
  </div>
  <div id="cap-banner"></div>
  <div id="loading">Loading preview…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead id="thead"><tr id="header-row"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${SET_STATE_SCRIPT}
${RENDER_TABLE_SCRIPT}

    function renderPreview(result, capMessage) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'none';
      document.getElementById('table-wrapper').style.display = 'block';
      if (capMessage) {
        const banner = document.getElementById('cap-banner');
        banner.textContent = capMessage;
        banner.style.display = 'block';
      }
      renderTable(result.columnNames, result.rows);
    }

    document.getElementById('adhoc-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openAdHocQuery', resourcePath: ${JSON.stringify(resourcePath)} });
    });

    document.getElementById('retry-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('breadcrumb').addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) { vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) }); }
    });

    const previousState = vscode.getState();
    if (previousState?.type === 'loadPreview' && previousState.result) {
      try { renderPreview(previousState.result, previousState.capMessage); } catch (_) {}
    } else if (previousState?.type === 'setState' && previousState.state === 'error') {
      applyState(previousState);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'setState') {
        if (msg.state !== 'loading' || !vscode.getState() || vscode.getState().type !== 'loadPreview') {
          vscode.setState(msg);
          applyState(msg);
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

      if (msg.type === 'loadPreview') {
        const st = vscode.getState() || {};
        vscode.setState({ ...st, type: 'loadPreview', result: msg.result });
        renderPreview(msg.result, st.capMessage);
      }
    });

    // Signal readiness only after the message listener is registered.
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
