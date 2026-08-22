-- Per-day till opening float, saved the moment it's typed — not only when the
-- full cash-up is committed at close. The dashboard's "expected in till" reads
-- this so a morning float shows up immediately; cash_ups keeps recording the
-- final reconciliation as before.
CREATE TABLE IF NOT EXISTS till_floats (
  day TEXT PRIMARY KEY,
  amount REAL NOT NULL DEFAULT 0,
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
