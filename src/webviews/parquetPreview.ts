/**
 * Parquet Preview Webview Client Script
 *
 * Implements FR-13: preview first 100 rows of a Parquet file.
 * NFR-3: row cap with banner.
 */
import { applyState, renderTable } from './shared.js';

interface ParquetPreviewResult {
  columnNames: string[];
  rows: Array<Record<string, unknown>>;
}

interface ParquetPreviewWebviewState {
  type?: string;
  state?: string;
  message?: string;
  result?: ParquetPreviewResult;
  capMessage?: string;
}

const vscode = acquireVsCodeApi<ParquetPreviewWebviewState>();

function renderPreview(result: ParquetPreviewResult, capMessage?: string): void {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const tableWrapperEl = document.getElementById('table-wrapper');

  if (loadingEl) loadingEl.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (tableWrapperEl) tableWrapperEl.style.display = 'block';

  if (capMessage) {
    const banner = document.getElementById('cap-banner');
    if (banner) {
      banner.textContent = capMessage;
      banner.style.display = 'block';
    }
  }
  renderTable(result.columnNames, result.rows);
}

const adhocBtn = document.getElementById('adhoc-btn');
adhocBtn?.addEventListener('click', () => {
  const resourcePath = adhocBtn.dataset.resourcePath || '';
  vscode.postMessage({ type: 'openAdHocQuery', resourcePath });
});

document.getElementById('retry-btn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'retry' });
});

document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.breadcrumb-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) });
  }
});

const previousState = vscode.getState();
if (previousState?.type === 'loadPreview' && previousState.result) {
  try {
    renderPreview(previousState.result, previousState.capMessage);
  } catch {
    // ignore state restore errors
  }
} else if (previousState?.type === 'setState' && previousState.state === 'error') {
  applyState(previousState);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg?.type) return;

  if (msg.type === 'setState') {
    const curState = vscode.getState();
    if (msg.state !== 'loading' || !curState || curState.type !== 'loadPreview') {
      vscode.setState(msg);
      applyState(msg);
    }
    return;
  }

  if (msg.type === 'showCapBanner') {
    const banner = document.getElementById('cap-banner');
    if (banner) {
      banner.textContent = msg.message;
      banner.style.display = 'block';
    }
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

