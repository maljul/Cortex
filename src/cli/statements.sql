-- Every statement `cortex init` and `cortex doctor` send, by name.
--
-- They live here rather than inside `src/cli/*.ts` because of a rule this repository
-- enforces mechanically: `scripts/gate-mechanical.sh`'s `sql-containment` row requires no
-- SQL in `src/` outside `src/memory/` and `src/db/`, and the first draft of the CLI turned
-- that row red. The rule behind the grep is `04` §1's: SQL is written down, never composed.
-- A named-statement file satisfies it more completely than the grep asks, because the CLI
-- now selects a statement by name and cannot build one.
--
-- Read by `src/cli/probes.ts`, split by the same splitter that drives the migration, and
-- keyed by the `-- name:` line above each statement.
--
-- The one statement not here is CREATE USER: a role name is an identifier and cannot be
-- bound as a parameter, so it is built in `src/cli/init.ts` against a validated name. Its
-- password IS bound, and `test/cli-init.test.ts` fails if that ever becomes interpolation.

-- name: role_exists
-- $1 is a role name. Used to decide whether init creates it — `pg_roles` answers whether an
-- account exists, which is not a privilege question and so is not the catalogue read V9
-- warns about; every privilege claim below is made by attempting a statement.
SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1;

-- name: current_principal
-- Who the cluster thinks this connection is. `04` §3's table was false for months while
-- every grant in it was correct, because nothing asked this question on the write plane.
SELECT current_user AS who;

-- name: table_inventory
-- What `cortex doctor` compares against the CREATE TABLE statements in sql/001_init.sql.
SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema();

-- name: probe_read
-- The read plane must be able to do this.
SELECT count(*) FROM repos;

-- name: probe_write
-- The write plane must be able to do this and the read plane must not. Always inside a
-- transaction that is rolled back, so the row never survives — including in the case this
-- exists to catch, where a plane that should have been refused was not.
INSERT INTO repos (slug) VALUES ('cortex-init-probe/should-not-persist');

-- name: probe_ddl
-- `04` §3: the write plane holds four verbs on six tables and "nothing else". Rolled back
-- like the one above, which is what makes it safe to attempt.
DROP TABLE findings;
