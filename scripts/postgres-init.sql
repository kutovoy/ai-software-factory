-- Runs once, when the Postgres data volume is first initialised.
-- Integration suites target this database so demo/smoke rows never mix with tests.
create database factory_test owner factory;

-- The local forge (Forgejo, spec `forge`) keeps its own database so forge state can be
-- reset without touching the read model (ADR-010).
create database forgejo owner factory;
