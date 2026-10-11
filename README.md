# Iceberg Explorer for VS Code

Browse, inspect, and query **Apache Iceberg** warehouses directly from your VS Code workspace.

Iceberg Explorer connects to local file systems, AWS S3 (and S3-compatible storage like MinIO), and Google Cloud Storage (GCS) to inspect metadata, visualize snapshots, analyze manifests, and run ad-hoc SQL queries using embedded DuckDB.

---

## Features

### 🌲 Interactive Sidebar Tree View
* **Warehouse Hierarchy**: Seamlessly navigate namespaces, tables, metadata versions, snapshots, and manifest files from the VS Code Explorer sidebar.
* **Multi-Connection Support**: Configure multiple warehouses and switch the active connection with one click.

### ☁️ Flexible Storage Backends
* **Local File System**: Direct browsing of local Iceberg table directories.
* **AWS S3 & S3-Compatible**: Connect to AWS S3 or custom endpoints (e.g., MinIO, Ceph, LocalStack).
* **Google Cloud Storage (GCS)**: Authenticate with zero-config Application Default Credentials (ADC) via `gcloud` or dedicated Service Account JSON keys.

### 📊 Deep Metadata & Schema Inspection
* **Table Overview**: Inspect snapshot history, schema evolution, current partition specs, record counts, and storage metrics at a glance.
* **Schema Viewer**: Browse columns, nested types, doc annotations, and nullability constraints.
* **Metadata Structure**: Trace snapshot lineage, parent-child snapshot trees, and metadata JSON structure.
* **Manifest & Avro Inspector**: Inspect manifest lists and manifest files with partition metrics and data file entries.

### ⚡ In-IDE SQL Querying (DuckDB-WASM)
* **Ad-Hoc SQL Queries**: Run standard SQL queries against your Iceberg Parquet data files directly within VS Code—no external Spark or Trino clusters required.
* **Instant Data Preview**: View query results and parquet data samples in interactive, paginated tables.

### 🔒 Secure by Design
* All sensitive credentials (AWS Access Keys, Session Tokens, GCS Service Account Keys) are stored exclusively in VS Code's Keychain-backed `SecretStorage`. Plain-text credentials are never saved to workspace files or settings.

---

## Quick Start

### 1. Open the Explorer
Click the **Explorer** icon (`Cmd+Shift+E`) in the VS Code Activity Bar and expand the **Iceberg Explorer** view at the bottom of the sidebar.

### 2. Add a Connection
Click the **Add Connection** button (or the **`+`** icon in the view title) to open the Connection Settings panel:
* **Local**: Provide the local absolute path to your warehouse directory.
* **S3**: Enter your bucket name, optional prefix, region, credentials, and custom endpoint URL (if using MinIO/LocalStack).
* **GCS**: Enter your bucket name, prefix, and select your authentication method (ADC or Service Account Key).

### 3. Explore & Query
* **Set Active**: Click **Activate** on your configured connection.
* **Browse Tables**: Expand namespaces and tables in the sidebar to reveal schema, metadata, and snapshots.
* **Inspect Details**: Right-click or click on any table to open the **Table Overview**, **Schema Overview**, or **Metadata Structure**.
* **Query Data**: Open the **Ad-hoc Query** panel to run SQL queries against the underlying Parquet files.

---

## Extension Commands

All commands can be triggered via the VS Code Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Iceberg Explorer: Add Connection` | Open connection manager to add a new warehouse |
| `Iceberg Explorer: Open Connection Dashboard` | View and manage configured warehouse connections |
| `Iceberg Explorer: Open Table Overview` | Display table summary, properties, and metrics |
| `Iceberg Explorer: Open Schema Overview` | View column definitions, types, and schemas |
| `Iceberg Explorer: Open Metadata Structure` | Inspect snapshot DAG, manifest hierarchy, and metadata JSON |

---

## System Requirements

* **VS Code**: Version `1.96.0` or later
* **Platform**: macOS arm64 (Apple Silicon) *(MVP architecture)*

---

## Development & Contributing

Looking to build from source, run tests, or contribute to the extension? See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, build scripts, and architecture details.

---

## License

Refer to the project repository for license details.
