/**
 * Metadata Architecture DAG Panel — HTML shell and client-side renderer.
 *
 * Implements:
 *  - Snapshot Manifest Hierarchy DAG for the selected snapshot (Metadata -> Snapshot -> Manifest List -> Manifests)
 *  - Paginated commit timeline for snapshots (10 per page, prev/next)
 *  - Stop at Manifest level with on-demand drill down to data files
 */
import { escHtml, breadcrumbHtml, BREADCRUMB_CSS, TABLE_CSS } from './shared.js';
import type { LoadMetadataArchitectureMessage, LoadManifestDataFilesMessage } from '../messages.js';

export function getMetadataArchitectureHtml(
  nonce: string,
  cspSource: string,
  tablePath: string,
): string {
  const initialBreadcrumb = breadcrumbHtml(tablePath);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Architecture</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0 1.25rem 2.5rem;
    }

    ${BREADCRUMB_CSS}
    ${TABLE_CSS}

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      flex-wrap: wrap;
    }
    h1 { margin: 0; font-size: 1.4rem; font-weight: 600; }

    /* ── Timeline Rail ──────────────────────────────────────────────────── */
    .section-title {
      font-size: 1rem;
      font-weight: 600;
      margin: 1.25rem 0 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .timeline-container {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
    }
    .timeline-scroll {
      display: flex;
      gap: 0.75rem;
      overflow-x: auto;
      padding: 0.5rem 0;
    }
    .snap-chip {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 0.6rem 0.85rem;
      min-width: 280px;
      flex-shrink: 0;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      transition: border-color 0.15s ease;
    }
    .snap-chip:hover { border-color: var(--vscode-focusBorder); }
    .snap-chip.selected {
      border-color: var(--vscode-textLink-foreground);
      box-shadow: 0 0 0 1px var(--vscode-textLink-foreground);
    }
    .snap-chip-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      white-space: nowrap;
    }
    .snap-chip-id {
      font-family: monospace;
      font-weight: 600;
      font-size: 0.85rem;
      white-space: nowrap;
    }
    .snap-chip-time {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .op-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      flex-shrink: 0;
      line-height: 1.2;
    }
    .op-append { background: #065f46; color: #34d399; }
    .op-overwrite { background: #9a3412; color: #fdba74; }
    .op-replace { background: #3730a3; color: #a5b4fc; }
    .op-delete { background: #991b1b; color: #f87171; }

    .pagination-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }

    button.btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 0.35rem 0.7rem;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.82rem;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    button.btn:hover { background: var(--vscode-button-hoverBackground); }
    button.btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    button.btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .action-link {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 0.2rem 0.55rem;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.78rem;
    }
    .action-link:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* ── DAG Tree Architecture Layout ──────────────────────────────────── */
    .dag-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.75rem;
      padding: 1.5rem 1rem;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
    }
    .dag-node {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 0.75rem 1.25rem;
      width: 100%;
      max-width: 600px;
      text-align: center;
      position: relative;
    }
    .dag-node-meta {
      border-color: #3b82f6;
      box-shadow: 0 0 4px rgba(59, 130, 246, 0.2);
    }
    .dag-node-snap {
      border-color: #10b981;
      box-shadow: 0 0 4px rgba(16, 185, 129, 0.2);
    }
    .dag-node-ml {
      border-color: #8b5cf6;
      box-shadow: 0 0 4px rgba(139, 92, 246, 0.2);
    }
    .dag-arrow {
      font-size: 1.4rem;
      color: var(--vscode-descriptionForeground);
      line-height: 1;
    }
    .dag-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 0.2rem;
    }
    .dag-value { font-family: monospace; font-weight: 600; font-size: 0.9rem; }

    .section-subtitle {
      font-size: 0.82rem;
      color: var(--vscode-descriptionForeground);
      margin-top: -0.25rem;
      margin-bottom: 0.6rem;
    }
    .dag-node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 0.35rem;
    }
    .meta-controls {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    .meta-select-label {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
    }
    .meta-dropdown {
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
      padding: 0.2rem 0.5rem;
      border-radius: 3px;
      font-size: 0.78rem;
      font-family: inherit;
      cursor: pointer;
      max-width: 260px;
    }
    .meta-dropdown:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .active-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .meta-badge-container {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-top: 0.35rem;
    }
    .meta-pill {
      font-size: 0.72rem;
      padding: 0.15rem 0.45rem;
      border-radius: 3px;
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .meta-pill.historical {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }

    /* ── Manifest Cards ─────────────────────────────────────────────────── */
    .manifests-section {
      width: 100%;
      max-width: 800px;
      margin-top: 0.5rem;
    }
    .manifest-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
    }
    .manifest-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .manifest-path { font-family: monospace; font-size: 0.85rem; font-weight: 600; }
    .manifest-stats {
      display: flex;
      gap: 0.75rem;
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      margin-top: 0.35rem;
    }
    .manifest-summary {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      margin-top: 0.25rem;
      font-style: italic;
    }

    /* ── Data Files Accordion ───────────────────────────────────────────── */
    .data-files-drawer {
      display: none;
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px dashed var(--vscode-editorWidget-border);
    }

    #loading {
      padding: 3rem 1rem;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid var(--vscode-editorWidget-border);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 0.75rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    #error {
      display: none;
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
      background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.1));
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-editor-foreground));
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div>Resolving Iceberg metadata architecture…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to load metadata architecture</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div>
        <h1>Metadata Architecture DAG</h1>
        <div style="font-size: 0.85rem; color: var(--vscode-descriptionForeground); margin-top: 0.2rem;">
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
        <span id="page-indicator" style="font-size: 0.85rem; color: var(--vscode-descriptionForeground);">Page 1</span>
        <button class="btn btn-secondary" id="page-next-btn">Older Commits &rarr;</button>
      </div>
    </div>

    <!-- Section 2: Snapshot Manifest Hierarchy -->
    <div class="section-title">
      <span>Snapshot Manifest Hierarchy (Snapshot <span id="selected-snap-label" style="font-family: monospace;">#—</span>)</span>
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
        <div id="node-snap-meta" style="font-size: 0.8rem; color: var(--vscode-descriptionForeground); margin-top: 0.25rem;"></div>
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
        <div class="dag-label" style="text-align: center; margin-bottom: 0.5rem;">Manifest Files (<span id="manifests-count">0</span>)</div>
        <div id="manifests-list"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'webviewReady' });

    let currentArchitecture = null;
    let allSnapshots = [];
    let selectedSnapshotId = null;
    let timelinePage = 0;
    const PAGE_SIZE = 10;

    document.getElementById('retry-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry' });
    });

    document.getElementById('open-overview-btn')?.addEventListener('click', () => {
      if (currentArchitecture) {
        vscode.postMessage({ type: 'openTableOverview', resourcePath: currentArchitecture.tablePath });
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
      if (currentArchitecture && currentArchitecture.metadataFile) {
        vscode.postMessage({
          type: 'openMetadataPanel',
          resourcePath: currentArchitecture.metadataFile,
        });
      }
    });

    document.getElementById('meta-file-select')?.addEventListener('change', (e) => {
      const target = e.target;
      const selectedPath = target ? target.value : null;
      if (selectedPath && currentArchitecture && selectedPath !== currentArchitecture.metadataFile) {
        vscode.postMessage({
          type: 'selectArchitectureMetadataFile',
          tablePath: currentArchitecture.tablePath,
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
            type: 'selectArchitectureSnapshot',
            tablePath: currentArchitecture.tablePath,
            snapshotId: s.snapshotId,
            metadataPath: currentArchitecture.metadataFile,
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
        list.innerHTML = '<div style="text-align: center; color: var(--vscode-descriptionForeground); padding: 1rem;">No manifests found for this snapshot</div>';
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
                <span style="color: #34d399;">+\${m.addedFiles} added</span>
                <span>&bull;</span>
                <span>\${m.existingFiles} existing</span>
                <span>&bull;</span>
                <span style="color: #f87171;">-\${m.deletedFiles} deleted</span>
              </div>
              \${m.partitionSummary ? '<div class="manifest-summary">' + esc(m.partitionSummary) + '</div>' : ''}
            </div>
            <div>
              <button class="btn btn-secondary drill-btn" data-path="\${esc(m.path)}" data-idx="\${idx}">View Data Files &darr;</button>
            </div>
          </div>
          <div class="data-files-drawer" id="drawer-\${idx}">
            <div class="spinner-small" id="spin-\${idx}" style="display: none; padding: 0.5rem; color: var(--vscode-descriptionForeground);">Loading data files…</div>
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
      } else if (msg.type === 'loadMetadataArchitecture') {
        currentArchitecture = msg;
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
              content.innerHTML = \`<div style="color: var(--vscode-errorForeground);">\${esc(msg.error)}</div>\`;
              return;
            }
            if (!msg.files || msg.files.length === 0) {
              content.innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 0.82rem;">No data files found in this manifest</div>';
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
                      <td><span class="badge" style="font-size: 0.7rem;">\${esc(f.status)}</span></td>
                      <td style="font-family: monospace; font-size: 0.82rem;">\${esc(fname)}</td>
                      <td>\${f.recordCount}</td>
                      <td style="color: var(--vscode-descriptionForeground);">\${sizeKb}</td>
                      <td>
                        \${isParquet ? \`<button class=\"action-link preview-btn\" data-path=\"\${esc(f.path)}\"\>Preview\</button\>\` : '—'}
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
