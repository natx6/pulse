-- Returns & refunds: the SALE STAYS (history integrity); returns are recorded
-- separately and reports subtract them. Stock goes back on the shelf.
CREATE TABLE IF NOT EXISTS sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  receipt_no TEXT NOT NULL,
  total_refunded REAL NOT NULL,
  reason TEXT,
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sale_returns(id),
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  unit TEXT
);
