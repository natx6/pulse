-- Stock adjustments (damaged/expired/counting error/returned to supplier):
-- an auditable log of manual stock changes. delta is signed (+in / -out).
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id);

-- Daily cash-up: the till reconciliation record for a day.
CREATE TABLE IF NOT EXISTS cash_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  operator TEXT,
  opening_float REAL NOT NULL DEFAULT 0,
  counted REAL NOT NULL,
  variance REAL NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cash_ups_day ON cash_ups(day);
