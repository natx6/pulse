-- Central audit trail: one row per business action (sale, return, void,
-- adjustment, stock take, purchase, payment, settlement, import, intake,
-- product create, expense add/delete, discount change, user change, ...).
-- Written inside the same transaction as the action itself, so the trail
-- can never drift from the data. Restores are the exception: swapping the
-- database file replaces history along with everything else.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  operator TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  amount REAL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
