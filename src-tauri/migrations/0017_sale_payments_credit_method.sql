-- sale_payments.method had its own CHECK ('Cash', 'Card', 'MoMo'); widen it
-- to include Credit (book) payment lines. SQLite can't alter a CHECK, so
-- rebuild the table preserving data and the index.

CREATE TABLE sale_payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('Cash', 'Card', 'MoMo', 'Credit')),
  amount REAL NOT NULL,
  reference TEXT
);

INSERT INTO sale_payments_new (id, sale_id, method, amount, reference)
  SELECT id, sale_id, method, amount, reference FROM sale_payments;

DROP TABLE sale_payments;
ALTER TABLE sale_payments_new RENAME TO sale_payments;

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
