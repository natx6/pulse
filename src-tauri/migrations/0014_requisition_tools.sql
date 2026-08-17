-- Requisition tooling: cancel flag + payment history for supplier invoices.
-- Cancelled orders drop out of the list and the bell; payments track what we
-- owe per supplier invoice (balance = total_amount - SUM(payments)).

ALTER TABLE purchases ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN cancel_reason TEXT;
ALTER TABLE purchases ADD COLUMN cancelled_at TEXT;

CREATE TABLE IF NOT EXISTS purchase_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Cash',
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_payments_purchase ON purchase_payments(purchase_id);
