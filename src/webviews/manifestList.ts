/**
 * Manifest List Webview Client Script
 *
 * Implements FR-11: display manifest list entries from an Avro manifest-list file.
 */
import { applyState, escHtml, escAttr } from './shared.js';

interface ManifestListRow {
  manifestPath: string;
  partitionSpecId: number;
  content: number;
  addedFilesCount?: number;
  existingFilesCount?: number;
  deletedFilesCount?: number;
}

interface ManifestListWebviewState {
  type?: string;
  state?: string;
  message?: string;
  rows?: ManifestListRow[];
}

const vscode = acquireVsCodeApi<ManifestListWebviewState>();

function renderRows(rows: ManifestListRow[]): void {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const tableWrapperEl = document.getElementById('table-wrapper');
  const tbody = document.getElementById('tbody');

  if (loadingEl) loadingEl.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (tableWrapperEl) tableWrapperEl.style.display = 'block';
  if (!tbody) return;

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

document.getElementById('tbody')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.manifest-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({ type: 'openManifestFile', resourcePath: btn.dataset.path });
  }
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
if (previousState?.type === 'loadManifestList' && Array.isArray(previousState.rows)) {
  try {
    renderRows(previousState.rows);
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
    if (msg.state !== 'loading' || !curState || curState.type !== 'loadManifestList') {
      vscode.setState(msg);
      applyState(msg);
    }
    return;
  }

  if (msg.type === 'loadManifestList') {
    try {
      vscode.setState({ type: 'loadManifestList', rows: msg.rows });
      renderRows(msg.rows);
    } catch {
      // swallow render errors — webview remains in loading state
    }
  }
});

// Signal readiness only after the message listener is registered so the
// host's response cannot arrive before we can receive it.
vscode.postMessage({ type: 'webviewReady' });

