-- Operators: named staff for the per-operator reports, with OPTIONAL shift
-- windows ("HH:MM" strings) so the app can auto-switch who is on duty.
-- Sales keep the operator name as a string snapshot, so deleting an operator
-- here never rewrites history.
CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  shift_start TEXT,
  shift_end TEXT
);

-- Auto-switch is opt-in, off by default.
INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_operator', '0');
