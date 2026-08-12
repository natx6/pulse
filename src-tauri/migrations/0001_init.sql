-- Pulse Pharmacy — initial schema.
-- Demo seed data included for first-run; delete the rows to start clean.

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  category TEXT,
  manufacturer TEXT,
  supplier TEXT,
  strength TEXT,
  rx_flag INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT,
  expiry_date TEXT,
  cost_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  fda_reg_no TEXT,
  is_controlled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,
  total_amount REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'Card', 'MoMo')),
  operator TEXT,
  tendered REAL,
  change_given REAL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sales_timestamp ON sales(timestamp);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Demo seed (Ghana-first catalog). INSERT OR IGNORE so re-running the
-- migration on an existing database skips rows that are already there.
-- Expiry dates are set ahead of 2026-08; Ibuprofen is deliberately expiring
-- soon so the red "expiring" state is visible in the demo.
INSERT OR IGNORE INTO products (name, barcode, category, manufacturer, strength, rx_flag, batch_no, expiry_date, cost_price, selling_price, stock_qty, reorder_level)
VALUES
  ('Coartem 20/120 (Artemether-Lumefantrine)', '6220000000011', 'Antimalarials', 'Novartis', '20/120mg x6 tabs', 1, 'CT-2301', '2027-05-30', 38.00, 52.00, 120, 40),
  ('Amoxicillin 500mg Capsules', '6220000000028', 'Antibiotics', 'GSK', '500mg x100 caps', 1, 'AX-8821', '2027-03-15', 22.50, 35.00, 142, 60),
  ('Paracetamol 500mg Tablets', '6220000000035', 'Analgesics', 'Generic', '500mg x100 tabs', 0, 'PC-4410', '2028-01-20', 4.80, 8.00, 480, 100),
  ('Ibuprofen 400mg Tablets', '6220000000042', 'Analgesics', 'Generic', '400mg x50 tabs', 0, 'IB-1190', '2026-09-15', 9.00, 14.00, 4, 30),
  ('Lisinopril 10mg Tablets', '6220000000059', 'Cardiovascular', 'Pfizer', '10mg x28 tabs', 1, 'LZ-7710', '2027-08-10', 12.00, 18.00, 85, 50),
  ('Amlodipine 5mg Tablets', '6220000000066', 'Cardiovascular', 'Generic', '5mg x28 tabs', 1, 'AM-3344', '2027-06-25', 10.50, 16.00, 210, 50),
  ('Metformin 500mg Tablets', '6220000000073', 'Diabetes', 'Generic', '500mg x100 tabs', 1, 'MF-9080', '2027-11-05', 15.00, 24.00, 300, 80),
  ('Oral Rehydration Salts (ORS)', '6220000000080', 'Rehydration', 'Generic', '20.5g sachet', 0, 'OR-2200', '2027-04-30', 1.20, 3.00, 640, 120);
