-- Demo sales so the History (and Dashboard "recent") views aren't empty on
-- first run. Two of today's and one of yesterday's, one with a partial refund,
-- exercising every column the history page reads. Each insert is gated on its
-- own DMO- receipt_no not existing, so re-running the migration never
-- duplicates. The DMO- prefix keeps them clear of the live RCPT- format.

INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0001', 51.0, 'Cash', 'Kwame', 60.0, 9.0, 'Ama Mensah', '0241234567', 51.0, 0, 0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0001');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 3, 'Paracetamol 500mg Tablets', 2, 8.0, 'bottle (100 tabs)'
FROM sales s WHERE s.receipt_no = 'DMO-0001';
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 2, 'Amoxicillin 500mg Capsules', 1, 35.0, 'bottle (100 caps)'
FROM sales s WHERE s.receipt_no = 'DMO-0001';
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'Cash', 51.0, NULL
FROM sales s WHERE s.receipt_no = 'DMO-0001';

INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0002', 100.0, 'MoMo', 'Akosua', NULL, 0, 'Kofi Owusu', '0209876543', 100.0, 0, 0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0002');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 1, 'Coartem 20/120 (Artemether-Lumefantrine)', 1, 52.0, 'strip (6 tabs)'
FROM sales s WHERE s.receipt_no = 'DMO-0002';
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 7, 'Metformin 500mg Tablets', 2, 24.0, 'bottle (100 tabs)'
FROM sales s WHERE s.receipt_no = 'DMO-0002';
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'MoMo', 100.0, 'MO2508A1B2C3D'
FROM sales s WHERE s.receipt_no = 'DMO-0002';

INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0003', 52.0, 'Card', 'Kwame', 52.0, 0, 'Yaa Boateng', '0551112233', 52.0, 0, 0, datetime('now', 'localtime', '-1 day')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0003');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 5, 'Lisinopril 10mg Tablets', 2, 18.0, 'strip (28 tabs)'
FROM sales s WHERE s.receipt_no = 'DMO-0003';
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, 6, 'Amlodipine 5mg Tablets', 1, 16.0, 'strip (28 tabs)'
FROM sales s WHERE s.receipt_no = 'DMO-0003';
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'Card', 52.0, '刷卡0001'
FROM sales s WHERE s.receipt_no = 'DMO-0003';

INSERT INTO sale_returns (sale_id, receipt_no, total_refunded, reason, operator, timestamp)
SELECT s.id, 'DMO-0003', 18.0, 'Customer returned 1 strip', 'Kwame', datetime('now', 'localtime', '-1 day')
FROM sales s WHERE s.receipt_no = 'DMO-0003';
INSERT INTO sale_return_items (return_id, product_id, product_name, quantity, unit_price, unit)
SELECT r.id, 5, 'Lisinopril 10mg Tablets', 1, 18.0, 'strip (28 tabs)'
FROM sale_returns r WHERE r.receipt_no = 'DMO-0003';
