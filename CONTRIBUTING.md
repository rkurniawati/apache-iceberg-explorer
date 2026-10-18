# Iceberg Explorer — VS Code Extension

Browse Apache Iceberg warehouses stored in Google Cloud Storage (GCS), S3-compatible object storage, or on the local file system, directly from VS Code.

---

## Prerequisites

- VS Code 1.96 or later
- Node.js 20 or later
- npm 10 or later

---

## Install dependencies

From the `iceberg-explorer` directory:

```bash
npm install
```

---

## Run from the IDE (recommended during development)

This is the fastest way — no packaging required.

**Step 1.** Open the `iceberg-explorer` folder as the VS Code workspace root:

```bash
code /path/to/delivery/projects/iceberg-explorer
```

> The folder must be the workspace root (not a parent folder). VS Code resolves
> `${workspaceFolder}` in `.vscode/launch.json` to whatever folder is open.

**Step 2.** Press **`F5`**.

VS Code will:
1. Compile the TypeScript source via `npm run compile`
2. Open a new **Extension Development Host** window with the extension loaded

You can also launch it from the sidebar: click the **Run and Debug** icon (`Cmd+Shift+D`), select **Run Extension** from the dropdown, then click the green play button.

**What you will see** in the Extension Development Host window:

- Open the Explorer sidebar (`Cmd+Shift+E`)
- Scroll to the bottom — the **Iceberg Explorer** panel appears.
- If no connections are configured, a welcome view is displayed with an **Add Connection** button and a `+` icon in the view title bar.
- Once a connection (Local, S3, or GCS) is configured, you can browse namespaces, tables, views, snapshots, and manifests, inspect metadata, and execute ad-hoc SQL queries.

---

## Architecture & System Design

Iceberg Explorer runs across two primary environments in VS Code:
1. **Node.js (Extension Host)**: Manages extension lifecycle, storage adapters (Local FS, AWS S3, GCS), tree view providers, Avro manifest decoding, and DuckDB-WASM execution on worker threads.
2. **Chromium (Webview Sandboxes)**: Renders webview panels (Table Overview, Schema Overview, Connection Dashboard, Metadata Structure SVG DAG, Settings, Ad-hoc SQL Query, Parquet Preview, etc.) styled with modular CSS.

For complete architectural details, multi-process execution models, DuckDB-WASM worker integration, and IPC message protocols, see [**`docs/architecture.md`**](docs/architecture.md).

---

## Running tests

Run the complete test suite:

```bash
npm test
```

Or run individual test slices during targeted development:

```bash
npm run test:slice-query     # DuckDB query engine, SQL parser & scan optimizer
npm run test:slice-tree      # Sidebar tree view provider & commands
npm run test:slice-panels    # Webview panels & message dispatching
npm run test:slice-settings  # Connection settings, credentials & validation
npm run test:slice-gcs       # Google Cloud Storage adapter & ADC
npm run test:slice-view      # Apache Iceberg View Specification v1
npm run test:slice-location  # Table location mismatch resolution
```

---

## Run from the command line (install as .vsix)

Use this to install the extension permanently into your VS Code.

**Step 1.** Compile and package:

```bash
npm run package
```

This produces `iceberg-explorer-0.0.1.vsix` in the current directory.

**Step 2.** Install:

```bash
code --install-extension iceberg-explorer-0.0.1.vsix
```

Or from inside VS Code: `Cmd+Shift+P` → **Extensions: Install from VSIX…** → select the `.vsix` file.

**Step 3.** Reload VS Code:

```bash
# Command palette
Cmd+Shift+P → Developer: Reload Window
```

---

## Uninstall

```bash
code --uninstall-extension RuthK.iceberg-explorer
```

Or: `Cmd+Shift+P` → **Extensions: Show Installed Extensions** → find Iceberg Explorer → **Uninstall**.

---

## Releasing via GitHub Actions

Releases are automated using GitHub Actions (`.github/workflows/release.yml`):

1. **Automated Release Cutting (Recommended)**:
   Use the built-in release script to bump versions, update changelog, run tests, commit, tag, and push:
   ```bash
   # Interactive prompt (select patch, minor, major, or custom)
   npm run release

   # Or specify version and optional notes directly
   npm run release patch
   npm run release minor -m "Support Iceberg v3 metadata format"
   npm run release 0.2.0

   # Preview changes without modifying files or git
   npm run release patch --dry-run
   ```
   Pushing the tag triggers the GitHub Action to build and package the `.vsix` and publish the GitHub Release with the `.vsix` attached.

2. **Manual tag-triggered release**:
   ```bash
   git tag v0.0.1
   git push origin v0.0.1
   ```

3. **Manual release dispatch**:
   - Navigate to **Actions** → **Release** in your GitHub repository.
   - Click **Run workflow** and optionally configure draft / prerelease toggles.
   - The workflow also saves the `.vsix` as a downloadable artifact in the workflow run summary.

---

## Project structure

```
iceberg-explorer/
├── .vscode/               # VS Code launch configs & tasks
├── docs/                  # Technical design & documentation
│   └── architecture.md    # Multi-process architecture, IPC & WASM spec
├── resources/             # Icons and stylesheets
│   ├── css/               # Modular Webview CSS stylesheets
│   ├── iceberg.svg        # Extension vector icon
│   └── iceberg.png        # Extension raster icon
├── scripts/               # Build, bundle, and release utilities
│   ├── bundle-duckdb.mjs  # DuckDB-WASM bundler for Node worker threads
│   ├── release.mjs        # Automated version bump and release cutter
│   └── optimize-demo-gif.py # Screen recording GIF optimizer
├── src/
│   ├── extension.ts       # Extension entry point (activate / deactivate)
│   ├── connection/        # Connection Manager, credentials, discovery & validation
│   ├── storage/           # Storage Layer (S3, GCS, Local FS) & locationResolver
│   ├── tree/              # Sidebar TreeDataProvider & contextual commands
│   ├── query/             # DuckDB-WASM query engine, worker threads & Avro decoding
│   ├── panels/            # WebviewPanelManager, IPC contracts & HTML generators
│   │   ├── html/          # HTML templates & client-side scripts
│   │   ├── messages.ts    # PanelMessage and WebviewMessage IPC interfaces
│   │   └── webviewPanelManager.ts
│   ├── utils/             # Iceberg View v1 spec parser & helpers
│   └── test/              # Integration and unit test slices
├── out/                   # Compiled JavaScript & packaged WASM assets
├── package.json
└── tsconfig.json
```

---

## Development scripts

| Command | Description |
|---|---|
| `npm run compile` | Compile TypeScript and bundle extension with esbuild |
| `npm run watch` | Watch mode — recompiles on every save |
| `npm test` | Run all unit and integration test slices |
| `npm run copy-wasm` | Prepare DuckDB-WASM assets and worker scripts in `out/` |
| `npm run package` | Produce `.vsix` package via `vsce package` |
| `npm run release` | Automated release cutter (updates package.json, changelog, commits, tags, and pushes) |

---

## Key Features & Capabilities

- **Storage Adapters**: Unified `StorageAdapter` interface supporting Local FS, AWS S3 (and S3-compatible storage like MinIO), and Google Cloud Storage (GCS).
- **Authentication & Security**: Native GCS ADC (`gcloud`) and Service Account Keys; AWS IAM credentials; secrets stored securely in VS Code `SecretStorage` (Keychain-backed).
- **Smart Path & Location Resolution**: Tolerates cross-bucket copies, path variations, and relocated metadata locations.
- **Tree View Provider**: Hierarchical navigation of connections, schemas, tables, views, snapshots, metadata files, and data files.
- **Webview Panels**: Connection Dashboard, Schema Overview, Table Overview, interactive SVG Metadata Structure DAG, Raw Metadata JSON viewer, Manifest List/File inspectors, and Parquet data preview.
- **In-IDE SQL Querying**: Ad-hoc SQL execution over Parquet files via embedded DuckDB-WASM on `worker_threads` with automatic row and byte budgeting.
- **Iceberg Views**: Full support for Apache Iceberg View Specification v1 inspection.
