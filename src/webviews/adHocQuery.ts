/**
 * Ad-hoc Query Webview Client Script
 *
 * Implements FR-14–FR-17: SQL textarea, Run button, Cancel button, results table.
 */
import { renderTable } from './shared.js';

interface QueryResultData {
  columnNames: string[];
  rows: Array<Record<string, unknown>>;
}

interface AdHocQueryWebviewState {
  type?: string;
  sql?: string;
  result?: QueryResultData;
  capMessage?: string;
  error?: string | null;
}

const vscode = acquireVsCodeApi<AdHocQueryWebviewState>();
let isLoading = false;

const runBtn = document.getElementById('run-btn') as HTMLButtonElement | null;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement | null;
const sqlInput = document.getElementById('sql-input') as HTMLTextAreaElement | null;
const statusText = document.getElementById('status-text');
const errorArea = document.getElementById('error-area');
const capBanner = document.getElementById('cap-banner');
const tableWrapper = document.getElementById('table-wrapper');

runBtn?.addEventListener('click', () => {
  if (isLoading || !sqlInput) return;
  const sql = sqlInput.value.trim() || sqlInput.placeholder.trim();
  if (!sql) return;
  vscode.postMessage({ type: 'runQuery', sql });
});

cancelBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancelQuery' });
});

document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.breadcrumb-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({ type: 'breadcrumbNavigate', segment: Number(btn.dataset.idx) });
  }
});

function setLoading(on: boolean): void {
  isLoading = on;
  if (runBtn) runBtn.disabled = on;
  if (cancelBtn) cancelBtn.style.display = on ? 'inline-block' : 'none';
  if (statusText) statusText.textContent = on ? 'Running…' : '';
}

function setIdle(): void {
  setLoading(false);
  if (errorArea) errorArea.style.display = 'none';
  if (capBanner) capBanner.style.display = 'none';
  if (tableWrapper) tableWrapper.style.display = 'none';
  if (statusText) statusText.textContent = '';
  const st = vscode.getState() || {};
  vscode.setState({ sql: st.sql });
}

const previousState = vscode.getState();
if (previousState?.sql && sqlInput) {
  sqlInput.value = previousState.sql;
}
if (previousState?.type === 'loadQueryResult' && previousState.result) {
  if (tableWrapper) tableWrapper.style.display = 'block';
  if (previousState.capMessage && capBanner) {
    capBanner.textContent = previousState.capMessage;
    capBanner.style.display = 'block';
  }
  renderTable(previousState.result.columnNames, previousState.result.rows);
} else if (previousState?.error && errorArea) {
  errorArea.style.display = 'block';
  errorArea.textContent = previousState.error;
}

sqlInput?.addEventListener('input', (e) => {
  const target = e.target as HTMLTextAreaElement;
  const st = vscode.getState() || {};
  vscode.setState({ ...st, sql: target.value });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg?.type) return;

  if (msg.type === 'setState') {
    if (msg.state === 'loading') {
      setLoading(true);
      if (errorArea) errorArea.style.display = 'none';
      if (capBanner) capBanner.style.display = 'none';
      if (tableWrapper) tableWrapper.style.display = 'none';
    } else if (msg.state === 'error') {
      setLoading(false);
      if (errorArea) {
        errorArea.style.display = 'block';
        errorArea.textContent = msg.message || 'An error occurred.';
      }
      const st = vscode.getState() || {};
      vscode.setState({ ...st, error: msg.message });
    } else if (msg.state === 'idle') {
      setIdle();
    }
    return;
  }

  if (msg.type === 'showCapBanner') {
    if (capBanner) {
      capBanner.textContent = msg.message;
      capBanner.style.display = 'block';
    }
    const st = vscode.getState() || {};
    vscode.setState({ ...st, capMessage: msg.message });
    return;
  }

  if (msg.type === 'loadQueryResult') {
    setLoading(false);
    if (errorArea) errorArea.style.display = 'none';
    if (tableWrapper) tableWrapper.style.display = 'block';
    renderTable(msg.result.columnNames, msg.result.rows);
    const st = vscode.getState() || {};
    vscode.setState({ ...st, type: 'loadQueryResult', result: msg.result, error: null });
  }
});

// Signal readiness only after the message listener is registered.
vscode.postMessage({ type: 'webviewReady' });

