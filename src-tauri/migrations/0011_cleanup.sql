-- Remove the tauri-plugin-sql migration bookkeeping table (leftover from the
-- plugin's own runner; our runner owns migrations via PRAGMA user_version).
DROP TABLE IF EXISTS _sqlx_migrations;
