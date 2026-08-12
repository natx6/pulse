-- Split payments: a sale can be settled with multiple methods (e.g. partial
-- cash + partial MoMo), each with an optional transaction reference (e.g. the
-- 12-digit MoMo ID). One row per method per sale. The sales.payment_method
-- column stays as the primary method for back-compat with pre-split data.
CREATE TABLE IF NOT EXISTS sale_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('Cash', 'Card', 'MoMo')),
  amount REAL NOT NULL,
  reference TEXT
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
