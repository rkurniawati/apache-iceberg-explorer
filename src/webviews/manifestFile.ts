/**
 * Manifest File Webview Client Script
 *
 * Implements FR-12: display manifest file entries from an Avro manifest file.
 * A-5: ORC files have no preview link.
 */
import { applyState, escHtml, escAttr } from './shared.js';

interface ManifestFileRow {
  status: number;
  filePath: string;
  fileFormat?: string;
  recordCount?: number;
  fileSizeBytes?: number;
}

interface ManifestFileWebviewState {
  type?: string;
  state?: string;
  message?: string;
  rows?: ManifestFileRow[];
}

const vscode = acquireVsCodeApi<ManifestFileWebviewState>();

function renderRows(rows: ManifestFileRow[]): void {
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

document.getElementById('tbody')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.file-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({ type: 'openParquetPreview', resourcePath: btn.dataset.path });
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
if (previousState?.type === 'loadManifestFile' && Array.isArray(previousState.rows)) {
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
    if (msg.state !== 'loading' || !curState || curState.type !== 'loadManifestFile') {
      vscode.setState(msg);
      applyState(msg);
    }
    return;
  }

  if (msg.type === 'loadManifestFile') {
    try {
      vscode.setState({ type: 'loadManifestFile', rows: msg.rows });
      renderRows(msg.rows);
    } catch {
      // swallow render errors
    }
  }
});

// Signal readiness only after the message listener is registered.
vscode.postMessage({ type: 'webviewReady' });

