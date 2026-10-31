-- Runs once, when the Postgres data volume is first initialised.
-- Integration suites target this database so demo/smoke rows never mix with tests.
create database factory_test owner factory;
