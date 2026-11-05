# artifact-store Specification

## Purpose
Durable object storage for run artifacts. Remote runner agents upload collected blobs directly to a RustFS S3-compatible store through short-lived, run-scoped presigned PUT grants; the control plane records object keys, hashes and sizes and serves downloads only after the normal run-access check. Storage is disabled unless explicitly configured.

## Requirements

### Requirement: Object-store configuration

The control plane SHALL support an S3-compatible artifact store with RustFS as the default
backend, configured by environment and swappable with S3/R2 by configuration.

#### Scenario: RustFS default
- **WHEN** `ARTIFACT_STORE=s3` and RustFS endpoint/bucket/credentials are configured
- **THEN** the control plane uses the RustFS S3 API for artifact storage
- **AND** no object-store credentials are sent to runner hosts

#### Scenario: Disabled store
- **WHEN** `ARTIFACT_STORE` is unset or `none`
- **THEN** remote artifacts remain metadata-only and local runs keep the existing run-directory
  behavior

### Requirement: Presigned upload grants

The API SHALL issue short-lived, run-scoped presigned PUT grants to an authenticated runner
agent for artifact upload.

#### Scenario: Presign
- **WHEN** an agent requests upload grants for a run it owns
- **THEN** the API returns a presigned PUT URL and object key per artifact
- **AND** the grant expires and is scoped to the run/tenant prefix
- **AND** an unknown run or host mismatch is refused

#### Scenario: Upload
- **WHEN** the agent uploads a blob to the presigned URL
- **THEN** the object is stored under the run prefix
- **AND** the agent returns the object key, SHA-256, size and content type

### Requirement: Artifact verification and download

The control plane SHALL record artifact object metadata and SHALL serve downloads only after
the normal run-access check.

#### Scenario: Verified artifact
- **WHEN** an artifact upload reports a key and checksum
- **THEN** the run artifact records `storageKey`, `bucket`, `sha256`, `bytes` and content type
- **AND** a size/checksum mismatch is recorded as an upload error rather than a valid artifact

#### Scenario: Download
- **WHEN** an authorized viewer requests a stored artifact
- **THEN** the API returns a short-lived presigned GET URL or streams the local file
- **AND** a path outside the run directory is refused
