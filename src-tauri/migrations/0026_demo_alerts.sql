-- Demo alerts so the notification (Alerts) panel is populated on first run and
-- every deep-link flash path is testable: one Open purchase (Requisitions)
-- plus clearly-labelled Demo products in Low / Expired / Expiring states.
-- Idempotent: products are keyed by unique barcode (INSERT OR IGNORE), the
-- purchase + line by their own ids (NOT EXISTS guard). All names start with
-- "Demo —" so they're easy to spot and delete.

INSERT OR IGNORE INTO suppliers (name, phone, location)
VALUES ('Demo Wholesale Ltd', '0300000000', 'Accra');

INSERT INTO purchases (id, reference_no, supplier_id, supplier_name, purchase_date, pay_term, status, discount_type, discount_amount, total_amount, created_at)
SELECT 'PUR-DEMO-001', 'DEMO-WAYBILL-1',
       (SELECT id FROM suppliers WHERE name = 'Demo Wholesale Ltd'),
       'Demo Wholesale Ltd', date('now', 'localtime'), 'Cash', 'Ordered',
       'None', 0.0, 400.0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE id = 'PUR-DEMO-001');

INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_type, quantity, qty_received, unit_cost_raw, discount_percent, unit_cost_net, line_total, profit_margin_percent, unit_selling_price, mfg_date, expiry_date, batch_no)
SELECT 'PI-DEMO-001', 'PUR-DEMO-001', 1,
       (SELECT name FROM products WHERE id = 1),
       'Pack', 10, 0, 40.0, 0.0, 40.0, 400.0, NULL, 55.0, NULL, '2027-08-30', 'DM-0001'
WHERE NOT EXISTS (SELECT 1 FROM purchase_items WHERE id = 'PI-DEMO-001');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Low Stock Item', '6220000000DLO', 'Demo', 5.0, 10.0, 3, 20, '2028-01-01', 0, 0, 'pack');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Expired Item', '6220000000DEX', 'Demo', 5.0, 10.0, 10, 20, '2020-01-01', 0, 0, 'pack');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Expiring Item', '6220000000DEXP', 'Demo', 5.0, 10.0, 10, 20, date('now', 'localtime', '+20 days'), 0, 0, 'pack');
