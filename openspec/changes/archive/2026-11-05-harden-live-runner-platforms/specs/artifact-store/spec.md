# Spec Delta

## ADDED Requirements

### Requirement: Separate upload and download endpoints

The artifact store SHALL support distinct agent-facing upload and browser-facing download endpoints.

#### Scenario: Linux agent upload, host download

- **WHEN** `S3_ENDPOINT` points at an agent-reachable address such as `host.docker.internal:9000`
  and `S3_PUBLIC_ENDPOINT` points at `localhost:9000`
- **THEN** presigned PUT grants use `S3_ENDPOINT`
- **AND** presigned GET downloads use `S3_PUBLIC_ENDPOINT`
- **AND** a browser on the host can follow the download redirect without `--resolve`

#### Scenario: Default endpoint

- **WHEN** `S3_PUBLIC_ENDPOINT` is unset
- **THEN** downloads use `S3_ENDPOINT`
