-- Phase 4b follow-up: an attestation from a partial (task/config subset) run is recorded
-- for reporting but is not accepted by the autonomy gate, which requires the full matrix.
alter table benchmark_attestations
  add column if not exists partial boolean not null default false;
