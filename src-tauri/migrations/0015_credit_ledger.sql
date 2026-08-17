-- Customer credit ("book") ledger: settlements against credit sales.
-- Credit sales are sale_payments rows with method = 'Credit'; this table
-- records each payment a customer makes against what they owe.

CREATE TABLE IF NOT EXISTS credit_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_name TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Cash',
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_credit_payments_name ON credit_payments(patient_name);
