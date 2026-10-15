/**
 * Metadata Structure Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Snapshot Manifest Hierarchy DAG for the selected snapshot (Metadata -> Snapshot -> Manifest List -> Manifests)
 *  - Paginated commit timeline for snapshots (10 per page, prev/next)
 *  - Stop at Manifest level with on-demand drill down to data files
 */
import { escHtml, breadcrumbHtml } from './shared.js';
import type { LoadMetadataStructureMessage, LoadManifestDataFilesMessage } from '../messages.js';

export interface MetadataStructureStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
}

export function getMetadataStructureHtml(
  nonce: string,
  cspSource: string,
  tablePath: string,
  styleUris?: MetadataStructureStyleUris,
): string {
  const initialBreadcrumb = breadcrumbHtml(tablePath);
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/metadataStructure.css';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Structure</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div>Resolving Iceberg metadata structure…</div>
  </div>

  <div id="error">
    <div class="error-title">Failed to load metadata structure</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary error-retry-btn" id="retry-btn">Retry</button>
  </div>

  <div id="content">
    <div class="header-bar">
      <div>
        <h1>Metadata Structure</h1>
        <div class="header-subtitle">
          Iceberg metadata structure. Click any snapshot commit to view its manifest hierarchy.
        </div>
      </div>
      <div>
        <button class="btn btn-secondary" id="open-overview-btn">View Table Overview</button>
      </div>
    </div>

    <!-- Section 1: Paginated Snapshots Timeline -->
    <div class="section-title">
      <span>Snapshot Commits Timeline (<span id="total-commits">0</span> total)</span>
    </div>
    <div class="section-subtitle">
      Select a snapshot commit below to inspect its manifest hierarchy in the diagram.
    </div>
    <div class="timeline-container">
      <div class="timeline-scroll" id="timeline-scroll"></div>
      <div class="pagination-controls">
        <button class="btn btn-secondary" id="page-prev-btn">&larr; Newer Commits</button>
        <span id="page-indicator">Page 1</span>
        <button class="btn btn-secondary" id="page-next-btn">Older Commits &rarr;</button>
      </div>
    </div>

    <!-- Section 2: Snapshot Manifest Hierarchy -->
    <div class="section-title">
      <span>Snapshot Manifest Hierarchy (Snapshot <span id="selected-snap-label">#—</span>)</span>
    </div>
    <div class="section-subtitle">
      Manifest list and manifests associated with the snapshot selected above.
    </div>
    <div class="dag-container">
      <!-- 1. Metadata JSON -->
      <div class="dag-node dag-node-meta">
        <div class="dag-node-header">
          <div class="dag-label">Table Metadata File</div>
          <div class="meta-controls">
            <label for="meta-file-select" class="meta-select-label">Version:</label>
            <select id="meta-file-select" class="meta-dropdown" title="Select Metadata JSON version" aria-label="Select Metadata JSON version"></select>
            <button class="btn btn-secondary action-link" id="view-meta-json-btn" title="Open this metadata JSON in the Metadata Detail view">View JSON Details ↗</button>
          </div>
        </div>
        <div class="dag-value" id="node-meta-file">vN.metadata.json</div>
        <div id="node-meta-badge" class="meta-badge-container"></div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 2. Snapshot -->
      <div class="dag-node dag-node-snap">
        <div class="dag-node-header">
          <div class="dag-label">Selected Snapshot</div>
          <span class="active-badge" id="snap-active-badge">Selected in Timeline</span>
        </div>
        <div class="dag-value" id="node-snap-id">Snapshot #—</div>
        <div id="node-snap-meta"></div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 3. Manifest List -->
      <div class="dag-node dag-node-ml">
        <div class="dag-label">Manifest List (.avro)</div>
        <div class="dag-value" id="node-ml-file">snap-xxx.avro</div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 4. Manifest Files (stops at manifest level with drill down) -->
      <div class="manifests-section">
        <div class="dag-label dag-label-center">Manifest Files (<span id="manifests-count">0</span>)</div>
        <div id="manifests-list"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'webviewReady' });

    let currentStructure = null;
    let allSnapshots = [];
    let selectedSnapshotId = null;
    let timelinePage = 0;
    const PAGE_SIZE = 10;

    document.getElementById('retry-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('open-overview-btn')?.addEventListener('click', () => {
      if (currentStructure) {
        vscode.postMessage({ type: 'openTableOverview', resourcePath: currentStructure.tablePath });
      }
    });

    document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-link');
      if (btn) {
        vscode.postMessage({
          type: 'breadcrumbNavigate',
          segment: Number(btn.dataset.idx),
        });
      }
    });

    document.getElementById('view-meta-json-btn')?.addEventListener('click', () => {
      if (currentStructure && currentStructure.metadataFile) {
        vscode.postMessage({
          type: 'openMetadataPanel',
          resourcePath: currentStructure.metadataFile,
        });
      }
    });

    document.getElementById('meta-file-select')?.addEventListener('change', (e) => {
      const target = e.target;
      const selectedPath = target ? target.value : null;
      if (selectedPath && currentStructure && selectedPath !== currentStructure.metadataFile) {
        vscode.postMessage({
          type: 'selectStructureMetadataFile',
          tablePath: currentStructure.tablePath,
          metadataPath: selectedPath,
        });
      }
    });

    // Pagination
    document.getElementById('page-prev-btn')?.addEventListener('click', () => {
      if (timelinePage > 0) {
        timelinePage--;
        renderTimeline();
      }
    });

    document.getElementById('page-next-btn')?.addEventListener('click', () => {
      const maxPage = Math.ceil(allSnapshots.length / PAGE_SIZE) - 1;
      if (timelinePage < maxPage) {
        timelinePage++;
        renderTimeline();
      }
    });

    function renderTimeline() {
      const scroll = document.getElementById('timeline-scroll');
      scroll.innerHTML = '';
      const total = allSnapshots.length;
      document.getElementById('total-commits').textContent = total;

      const start = timelinePage * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, total);
      const pageItems = allSnapshots.slice(start, end);

      const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
      document.getElementById('page-indicator').textContent = \`Page \${timelinePage + 1} of \${maxPage + 1}\`;
      document.getElementById('page-prev-btn').disabled = timelinePage === 0;
      document.getElementById('page-next-btn').disabled = timelinePage >= maxPage;

      pageItems.forEach((s) => {
        const chip = document.createElement('div');
        chip.className = 'snap-chip' + (s.snapshotId === selectedSnapshotId ? ' selected' : '');
        const op = (s.operation || 'unknown').toLowerCase();
        let opClass = 'op-append';
        if (op.includes('overwrite')) opClass = 'op-overwrite';
        else if (op.includes('replace')) opClass = 'op-replace';
        else if (op.includes('delete')) opClass = 'op-delete';

        chip.innerHTML = \`
          <div class="snap-chip-header">
            <span class="snap-chip-id">#\${s.snapshotId}</span>
            <span class="op-badge \${opClass}">\${esc(s.operation || 'commit')}</span>
          </div>
          <div class="snap-chip-time">\${new Date(s.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}</div>
        \`;
        chip.addEventListener('click', () => {
          selectedSnapshotId = s.snapshotId;
          renderTimeline();
          document.getElementById('selected-snap-label').textContent = '#' + s.snapshotId;
          vscode.postMessage({
            type: 'selectStructureSnapshot',
            tablePath: currentStructure.tablePath,
            snapshotId: s.snapshotId,
            metadataPath: currentStructure.metadataFile,
          });
        });
        scroll.appendChild(chip);
      });
    }

    function renderManifests(manifests) {
      const list = document.getElementById('manifests-list');
      list.innerHTML = '';
      document.getElementById('manifests-count').textContent = manifests.length;

      if (manifests.length === 0) {
        list.innerHTML = '<div class="empty-state">No manifests found for this snapshot</div>';
        return;
      }

      manifests.forEach((m, idx) => {
        const card = document.createElement('div');
        card.className = 'manifest-card';
        const filename = m.path.split('/').pop() || m.path;

        card.innerHTML = \`
          <div class="manifest-header">
            <div>
              <div class="manifest-path">\${esc(filename)}</div>
              <div class="manifest-stats">
                <span>Partition Spec: #\${m.partitionSpecId}</span>
                <span>&bull;</span>
                <span class="stat-added">+\${m.addedFiles} added</span>
                <span>&bull;</span>
                <span>\${m.existingFiles} existing</span>
                <span>&bull;</span>
                <span class="stat-deleted">-\${m.deletedFiles} deleted</span>
              </div>
              \${m.partitionSummary ? '<div class="manifest-summary">' + esc(m.partitionSummary) + '</div>' : ''}
            </div>
            <div>
              <button class="btn btn-secondary drill-btn" data-path="\${esc(m.path)}" data-idx="\${idx}">View Data Files &darr;</button>
            </div>
          </div>
          <div class="data-files-drawer" id="drawer-\${idx}">
            <div class="spinner-small hidden" id="spin-\${idx}">Loading data files…</div>
            <div id="drawer-content-\${idx}"></div>
          </div>
        \`;
        list.appendChild(card);
      });
    }

    document.getElementById('manifests-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.drill-btn');
      if (btn) {
        const idx = btn.getAttribute('data-idx');
        const path = btn.getAttribute('data-path');
        const drawer = document.getElementById('drawer-' + idx);
        if (drawer.style.display === 'block') {
          drawer.style.display = 'none';
          btn.innerHTML = 'View Data Files &darr;';
        } else {
          drawer.style.display = 'block';
          btn.innerHTML = 'Hide Data Files &uarr;';
          const content = document.getElementById('drawer-content-' + idx);
          if (!content.hasChildNodes()) {
            document.getElementById('spin-' + idx).style.display = 'block';
            vscode.postMessage({ type: 'fetchManifestDataFiles', manifestPath: path });
          }
        }
        return;
      }

      const previewBtn = e.target.closest('.preview-btn');
      if (previewBtn) {
        const resourcePath = previewBtn.getAttribute('data-path');
        if (resourcePath) {
          vscode.postMessage({ type: 'openParquetPreview', resourcePath });
        }
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'setState') {
        if (msg.state === 'loading') {
          document.getElementById('loading').style.display = 'block';
          document.getElementById('error').style.display = 'none';
          document.getElementById('content').style.display = 'none';
        } else if (msg.state === 'error') {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('error-message').textContent = msg.message || 'An error occurred.';
          document.getElementById('content').style.display = 'none';
        } else if (msg.state === 'idle') {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'none';
          document.getElementById('content').style.display = 'block';
        }
      } else if (msg.type === 'loadMetadataStructure' || msg.type === 'loadMetadataArchitecture') {
        currentStructure = msg;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        allSnapshots = msg.snapshots || [];
        selectedSnapshotId = msg.activeSnapshot ? msg.activeSnapshot.snapshotId : msg.currentSnapshotId;
        document.getElementById('selected-snap-label').textContent = selectedSnapshotId ? '#' + selectedSnapshotId : 'None';

        const metaFilename = msg.metadataFile.split('/').pop() || msg.metadataFile;
        document.getElementById('node-meta-file').textContent = metaFilename;

        // Populate metadata versions dropdown
        const selectEl = document.getElementById('meta-file-select');
        selectEl.innerHTML = '';
        const avail = msg.availableMetadataFiles || [];
        if (avail.length > 0) {
          avail.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.resourcePath;
            opt.textContent = v.label + (v.isLatest ? ' (Latest)' : '');
            if (v.resourcePath === msg.metadataFile) {
              opt.selected = true;
            }
            selectEl.appendChild(opt);
          });
          selectEl.style.display = 'inline-block';
        } else {
          selectEl.style.display = 'none';
        }

        // Display version status badge
        const badgeContainer = document.getElementById('node-meta-badge');
        badgeContainer.innerHTML = '';
        const curMetaInfo = avail.find((v) => v.resourcePath === msg.metadataFile);
        const isLatest = curMetaInfo ? curMetaInfo.isLatest : true;
        const pill = document.createElement('span');
        pill.className = 'meta-pill' + (isLatest ? '' : ' historical');
        pill.textContent = isLatest ? 'Latest Metadata Version' : 'Historical Metadata Version';
        badgeContainer.appendChild(pill);

        if (msg.activeSnapshot) {
          document.getElementById('node-snap-id').textContent = 'Snapshot #' + msg.activeSnapshot.snapshotId;
          const mlName = msg.activeSnapshot.manifestList.split('/').pop() || msg.activeSnapshot.manifestList;
          document.getElementById('node-ml-file').textContent = mlName;
          renderManifests(msg.activeSnapshot.manifests || []);
        } else {
          document.getElementById('node-snap-id').textContent = 'No Active Snapshot';
          document.getElementById('node-ml-file').textContent = '—';
          renderManifests([]);
        }

        timelinePage = 0;
        renderTimeline();

      } else if (msg.type === 'loadManifestDataFiles') {
        // Find drawer with matching manifest path
        document.querySelectorAll('.drill-btn').forEach((btn) => {
          if (btn.getAttribute('data-path') === msg.manifestPath) {
            const idx = btn.getAttribute('data-idx');
            document.getElementById('spin-' + idx).style.display = 'none';
            const content = document.getElementById('drawer-content-' + idx);
            content.innerHTML = '';

            if (msg.error) {
              content.innerHTML = \`<div class="drawer-error">\${esc(msg.error)}</div>\`;
              return;
            }
            if (!msg.files || msg.files.length === 0) {
              content.innerHTML = '<div class="drawer-empty">No data files found in this manifest</div>';
              return;
            }

            const table = document.createElement('table');
            table.innerHTML = \`
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Data File Path</th>
                  <th>Records</th>
                  <th>Size</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                \${msg.files.map(f => {
                  const fname = f.path.split('/').pop() || f.path;
                  const isParquet = fname.endsWith('.parquet');
                  const sizeKb = (f.fileSizeInBytes / 1024).toFixed(1) + ' KB';
                  return \`
                    <tr>
                      <td><span class="badge badge-sm">\${esc(f.status)}</span></td>
                      <td class="file-path-cell">\${esc(fname)}</td>
                      <td>\${f.recordCount}</td>
                      <td class="file-size-cell">\${sizeKb}</td>
                      <td>
                        \${isParquet ? \`<button class="action-link preview-btn" data-path="\${esc(f.path)}">Preview</button>\` : '—'}
                      </td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            \`;
            content.appendChild(table);
          }
        });
      }
    });

    function esc(s) {
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}

/** @deprecated Use getMetadataStructureHtml */
export const getMetadataArchitectureHtml = getMetadataStructureHtml;

