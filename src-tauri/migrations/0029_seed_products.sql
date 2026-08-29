-- Starter product catalog for development & evaluation only. This migration's
-- name contains "seed", so the migration runner SKIPS it in release builds —
-- shipped databases start with an empty catalog. In debug it gives a
-- realistic Ghana pharmacy range to click around with.
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
