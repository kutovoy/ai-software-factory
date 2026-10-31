/**
 * Test preload (ADR-029).
 *
 * Integration suites are opt-in with `RUN_INTEGRATION=1`. When they run, they must not
 * write into the compose demo database: the default is `factory_test`, created by
 * `scripts/postgres-init.sql` on first init. An explicit DATABASE_URL still wins.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://factory:factory@localhost:5433/factory_test';
}
