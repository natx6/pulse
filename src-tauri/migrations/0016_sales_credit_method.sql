-- Book (credit) sales store 'Credit' as the primary payment method. SQLite
-- can't alter a CHECK constraint, so rebuild the sales table with the wider
-- CHECK, preserving data and indexes. FK enforcement is off by default, so
-- child tables (sale_items, sale_payments, sale_returns) keep working.

CREATE TABLE sales_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,
  total_amount REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'Card', 'MoMo', 'Credit')),
  operator TEXT,
  tendered REAL,
  change_given REAL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  patient_name TEXT,
  patient_phone TEXT
);

INSERT INTO sales_new (id, receipt_no, total_amount, payment_method, operator, tendered, change_given, timestamp, patient_name, patient_phone)
  SELECT id, receipt_no, total_amount, payment_method, operator, tendered, change_given, timestamp, patient_name, patient_phone
  FROM sales;

DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;

CREATE INDEX IF NOT EXISTS idx_sales_timestamp ON sales(timestamp);
CREATE INDEX IF NOT EXISTS idx_sales_patient ON sales(patient_name);
