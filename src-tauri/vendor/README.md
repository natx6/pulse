# Vendored tauri-plugin-sql (2.4.0)

Patched copy of https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql
(licenses preserved: MIT / Apache-2.0).

**Why:** the database is encrypted at rest with SQLCipher, and every
connection must present the per-install key (`pulse.key`, next to
`pulse.db`) as its first statement. Upstream opens SQLite pools with no way
to inject `PRAGMA key`, so this fork keys the pool from the key file in
`wrapper.rs` (`DbPool::connect`, sqlite branch) and adds a
`DatabaseKeyMissing` error variant.

sqlx 0.8 reserves the `key` pragma slot ahead of its own pragmas for exactly
this purpose, so the patch is a few lines.

**Upgrade policy:** don't bump this crate from crates.io — re-apply the two
small patches to the new version instead. Wired up via
`tauri-plugin-sql = { path = "vendor/tauri-plugin-sql" }` in `../Cargo.toml`.
