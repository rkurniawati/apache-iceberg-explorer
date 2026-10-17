# Change Log

All notable changes to the "iceberg-explorer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.1] - 2026-10-16

### Initial Release

#### Added
- **Interactive Sidebar Tree View**:
  - Multi-connection warehouse hierarchy navigation across namespaces, tables, metadata versions, snapshots, and manifest files.
  - One-click active connection switching, connect/disconnect, edit, and delete support.
  - Breadcrumb navigation and tree reveal integration.
- **Multi-Cloud & Local Storage Adapters**:
  - Local file system support for local Iceberg warehouse directories.
  - AWS S3 and S3-compatible object storage support (MinIO, Ceph, LocalStack).
  - Google Cloud Storage (GCS) support via Application Default Credentials (ADC) and Service Account JSON keys.
  - Secure credential storage backed by VS Code Keychain-backed `SecretStorage`.
- **Deep Metadata & Schema Inspection**:
  - **Table Overview**: Snapshot lineage, schema evolution, current partition specs, record counts, and storage metrics.
  - **Schema Viewer**: Column definitions, nested types, doc annotations, and nullability constraints.
  - **Metadata Structure**: Snapshot DAGs, manifest hierarchy, and metadata JSON structure.
  - **Manifest & Avro Inspector**: Manifest lists and manifest files with partition summaries and data file entries.
- **In-IDE SQL Querying via DuckDB-WASM**:
  - Embedded DuckDB WebAssembly engine executing in background Node worker threads.
  - Ad-hoc SQL querying against underlying Iceberg Parquet data files without requiring external compute clusters.
  - Paginated interactive data previews and query result tables.
  - Query timeout watchdog (30s) and cancellation support.
