-- Petty cash / expense tracking.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT 'Other',
  description TEXT,
  amount REAL NOT NULL,
  operator TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_timestamp ON expenses(timestamp);

-- Customer discount tier: optional percentage discount applied at checkout.
-- NULL or 0 = no discount. Values like 5, 10, 15 represent percent off.
ALTER TABLE patients ADD COLUMN discount_tier REAL DEFAULT 0;
