# sql.js Additive-Migration Smoke — Result Memo (FOUND-07)

> Proves a **v0.1-era `palisade.db` survives the additive v0.2 schema migration with zero data
> loss** before any production migration is written. Read-only de-risking for the D19 migration that
> Phase 2 will put into `src/logging/database.ts`. Script: `scratch/sqljs-migration.mjs` (gitignored;
> the `*.db` fixture is built in-memory and never committed).

**Status:** PASSED · **Run:** 2026-06-03 · **sql.js:** ^1.11.0 (repo-resident dependency, no new install)

---

## What was tested

1. Built a v0.1-era database in-memory using the **exact** v0.1 `SCHEMA` from
   `src/logging/database.ts` (`events` / `skill_trust` / `pattern_stats` + the 4 event indexes) and
   inserted 12 representative `events` rows (mixed `allow` / `warn` / `block`, varied timestamps,
   some `matches_json`) plus 4 `pattern_stats` rows.
2. Captured the v0.1 **audit queries verbatim** from `src/logging/events.ts`:
   - `queryEvents`: `SELECT * FROM events ORDER BY timestamp DESC LIMIT 100`
   - `getStats` totals: `COUNT(*)` + `SUM(CASE WHEN action_taken='block'/'warn'/'allow' …)` `WHERE timestamp >= ?`
   - `getStats` top-patterns: `SELECT pattern_id, hit_count FROM pattern_stats ORDER BY hit_count DESC LIMIT 10`
3. Applied **only additive** v0.2 migration (D19):
   - `ALTER TABLE events ADD COLUMN tier2_confidence REAL` (nullable)
   - `ALTER TABLE events ADD COLUMN tier3_confidence REAL` (nullable)
   - `CREATE TABLE IF NOT EXISTS meta (key, value)` + `INSERT OR REPLACE … ('schema_version','2')`
   - `CREATE TABLE IF NOT EXISTS tier3_cost_ledger (…)`
4. Re-ran the same audit queries and asserted equality.

## Result

| Check | Outcome |
|-------|---------|
| Rows preserved | **12 / 12** (no loss) |
| v0.1 columns | **12 / 12** intact, values unchanged |
| `queryEvents` (v0.1 columns) | **identical** pre/post (deep-equal on the v0.1 column projection) |
| New columns on v0.1 rows | `tier2_confidence` / `tier3_confidence` present and **NULL** (additive, expected) |
| `getStats` totals | **identical** (explicit columns — unaffected by `ADD COLUMN`) |
| `getStats` top-patterns | **identical** |
| `meta.schema_version` | reads back **`2`** |
| `tier3_cost_ledger` | created via `CREATE TABLE IF NOT EXISTS` |

## Conclusion

The D19 additive migration (nullable columns only, `CREATE TABLE IF NOT EXISTS`, `meta.schema_version`)
opens a v0.1 database and leaves every v0.1 audit query **identical** for the original columns. A
v0.1 `palisade.db` is forward-compatible with the proposed v0.2 schema with no data migration and no
query rewrite. **Phase 2 may implement this migration in `src/logging/database.ts` as proven here.**

> Note on "identical": `SELECT *` necessarily returns the two new nullable columns after
> `ADD COLUMN`; equality is asserted on the v0.1 column set (their presence + values), and the new
> columns are verified to be NULL on legacy rows. The explicit-column `getStats` queries are
> byte-identical with no caveat.
