-- Pulse sample dataset for evaluation, demos and testing. Loaded on demand
-- via the seed_demo_data command (Settings → Sample data), NOT at startup,
-- so real client databases never inherit anything fake.
--
-- Contents: starter catalog (8 items) + full Ghana pharmacy range (~58 items
-- with expired / expiring / zero-stock / low-stock states) + 3 sample sales
-- (DMO- prefix, one with a partial refund) + Demo supplier with one open
-- purchase + Demo low/expired/expiring products.
--
-- Safe to re-run: products use INSERT OR IGNORE on unique barcode, sales and
-- purchase headers carry NOT EXISTS guards, and every line item resolves its
-- product by barcode (never a hardcoded id) with its own NOT EXISTS guard.

-- 1. Starter catalog (8 items).
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

-- 2. Restock the starter items (demo barcodes only — real products untouched).
UPDATE products SET cost_price = 40.00, selling_price = 55.00, stock_qty = 260, reorder_level = 60, expiry_date = '2027-08-30' WHERE barcode = '6220000000011';
UPDATE products SET cost_price = 23.00, selling_price = 36.50, stock_qty = 320, reorder_level = 80, expiry_date = '2027-06-15' WHERE barcode = '6220000000028';
UPDATE products SET cost_price = 5.00,  selling_price = 8.50,  stock_qty = 600, reorder_level = 120, expiry_date = '2028-04-20' WHERE barcode = '6220000000035';
UPDATE products SET cost_price = 9.50,  selling_price = 15.00, stock_qty = 18,  reorder_level = 30,  expiry_date = '2027-09-15' WHERE barcode = '6220000000042';
UPDATE products SET cost_price = 13.00, selling_price = 19.00, stock_qty = 140, reorder_level = 50, expiry_date = '2028-01-10' WHERE barcode = '6220000000059';
UPDATE products SET cost_price = 12.00, selling_price = 17.00, stock_qty = 260, reorder_level = 60, expiry_date = '2028-03-25' WHERE barcode = '6220000000066';
UPDATE products SET cost_price = 16.00, selling_price = 25.00, stock_qty = 380, reorder_level = 80, expiry_date = '2028-05-05' WHERE barcode = '6220000000073';
UPDATE products SET cost_price = 1.50,  selling_price = 3.50,  stock_qty = 800, reorder_level = 150, expiry_date = '2028-04-30' WHERE barcode = '6220000000080';

-- 3. Full catalog. Barcodes 6220000000100+ (the sample-import Vitamin C uses
-- 6220000000999, so no collision). States:
--   expired        -> Quinine, Chloramphenicol drops
--   expiring <=30d -> Insulin, Tramadol
--   expiring 30-60d-> Betadine, Hydrocortisone, Mefenamic acid
--   zero stock     -> Loperamide, Artificial tears
--   reorder-low    -> Ibuprofen (above), Chlorpheniramine, Metronidazole
INSERT OR IGNORE INTO products (name, barcode, category, manufacturer, strength, unit, rx_flag, batch_no, expiry_date, cost_price, selling_price, stock_qty, reorder_level, supplier, is_controlled)
VALUES
('Lonart 80/480 (Artemether-Lumefantrine)', '6220000000100', 'Antimalarials', 'Macleods', '80/480mg x6 tabs', 'x6 tabs', 1, 'LN-2411', '2027-10-15', 42.00, 58.00, 180, 40, 'Ernest Chemists', 0),
('Quinine 300mg Tablets', '6220000000101', 'Antimalarials', 'Cipla', '300mg x100 tabs', 'x100 tabs', 1, 'QN-2305', '2026-05-20', 15.00, 22.00, 120, 30, 'Tobinco', 0),
('Dihydroartemisinin-Piperaquine 40/320', '6220000000102', 'Antimalarials', 'Atlantic Life Sciences', '40/320mg x6 tabs', 'x6 tabs', 1, 'DP-2408', '2027-12-10', 32.00, 45.00, 90, 25, 'Glico', 0),
('Amoxiclav 625mg Tablets', '6220000000103', 'Antibiotics', 'GSK', '625mg x14 tabs', 'x14 tabs', 1, 'AC-2412', '2027-08-20', 48.00, 65.00, 110, 30, 'La Gray', 0),
('Ciprofloxacin 500mg Tablets', '6220000000104', 'Antibiotics', 'Cipla', '500mg x10 tabs', 'x10 tabs', 1, 'CP-2406', '2027-11-30', 19.00, 28.00, 150, 40, 'Ernest Chemists', 0),
('Azithromycin 500mg Tablets', '6220000000105', 'Antibiotics', 'Pfizer', '500mg x3 tabs', 'x3 tabs', 1, 'AZ-2409', '2027-09-05', 33.00, 45.00, 95, 25, 'DFC', 0),
('Metronidazole 400mg Tablets', '6220000000106', 'Antibiotics', 'Sanofi', '400mg x100 tabs', 'x100 tabs', 1, 'MT-2403', '2028-02-14', 16.00, 25.00, 25, 40, 'Kinapharma', 0),
('Doxycycline 100mg Tablets', '6220000000107', 'Antibiotics', 'Cipla', '100mg x100 tabs', 'x100 tabs', 1, 'DX-2410', '2027-10-25', 21.00, 30.00, 80, 30, 'Letap', 0),
('Erythromycin 500mg Tablets', '6220000000108', 'Antibiotics', 'Hovid', '500mg x100 tabs', 'x100 tabs', 1, 'ER-2401', '2027-07-30', 22.00, 32.00, 60, 20, 'Asmed', 0),
('Amoxicillin 250mg/5ml Suspension', '6220000000109', 'Antibiotics', 'GSK', '250mg/5ml 100ml', '100ml', 1, 'AM-2407', '2027-05-15', 19.00, 28.00, 70, 25, 'La Gray', 0),
('Cefuroxime 500mg Tablets', '6220000000110', 'Antibiotics', 'GSK', '500mg x10 tabs', 'x10 tabs', 1, 'CF-2405', '2027-06-20', 62.00, 85.00, 55, 15, 'Tobinco', 0),
('Paracetamol 500mg x20 Blister', '6220000000111', 'Analgesics', 'Unique', '500mg x20 tabs', 'x20 tabs', 0, 'PC-2412', '2028-06-30', 3.50, 6.00, 400, 100, 'Ernest Chemists', 0),
('Diclofenac 50mg Tablets', '6220000000112', 'Analgesics', 'Novartis', '50mg x100 tabs', 'x100 tabs', 0, 'DC-2404', '2027-09-25', 15.00, 24.00, 90, 30, 'Glico', 0),
('Piroxicam 20mg Tablets', '6220000000113', 'Analgesics', 'Pfizer', '20mg x100 tabs', 'x100 tabs', 0, 'PX-2402', '2027-04-18', 17.00, 26.00, 60, 20, 'Kinapharma', 0),
('Tramadol 50mg Capsules', '6220000000114', 'Analgesics', 'Cipla', '50mg x100 caps', 'x100 caps', 1, 'TR-2409', '2026-09-10', 20.00, 30.00, 40, 15, 'DFC', 1),
('Aspirin 300mg Tablets', '6220000000115', 'Analgesics', 'Bayer', '300mg x100 tabs', 'x100 tabs', 0, 'AS-2408', '2028-03-10', 6.00, 10.00, 200, 50, 'Letap', 0),
('Mefenamic Acid 500mg Tablets', '6220000000116', 'Analgesics', 'Hovid', '500mg x100 tabs', 'x100 tabs', 0, 'MF-2401', '2026-10-05', 14.00, 22.00, 75, 25, 'Asmed', 0),
('Losartan 50mg Tablets', '6220000000117', 'Cardiovascular', 'Macleods', '50mg x100 tabs', 'x100 tabs', 1, 'LS-2410', '2027-11-20', 24.00, 35.00, 140, 40, 'Ernest Chemists', 0),
('Nifedipine 20mg Retard Tablets', '6220000000118', 'Cardiovascular', 'Bayer', '20mg x100 tabs', 'x100 tabs', 1, 'NF-2406', '2027-08-12', 26.00, 38.00, 85, 30, 'Tobinco', 0),
('Atenolol 50mg Tablets', '6220000000119', 'Cardiovascular', 'AstraZeneca', '50mg x100 tabs', 'x100 tabs', 1, 'AT-2403', '2027-06-08', 12.00, 20.00, 70, 25, 'Glico', 0),
('Hydrochlorothiazide 25mg Tablets', '6220000000120', 'Cardiovascular', 'Cipla', '25mg x100 tabs', 'x100 tabs', 1, 'HZ-2407', '2028-01-25', 9.00, 16.00, 65, 20, 'Kinapharma', 0),
('Atorvastatin 20mg Tablets', '6220000000121', 'Cardiovascular', 'Pfizer', '20mg x100 tabs', 'x100 tabs', 1, 'AV-2411', '2027-12-05', 32.00, 45.00, 120, 35, 'La Gray', 0),
('Glibenclamide 5mg Tablets', '6220000000122', 'Diabetes', 'Sanofi', '5mg x100 tabs', 'x100 tabs', 1, 'GB-2405', '2027-07-22', 9.00, 15.00, 90, 30, 'DFC', 0),
('Metformin 850mg Tablets', '6220000000123', 'Diabetes', 'Merck', '850mg x100 tabs', 'x100 tabs', 1, 'MF-2412', '2028-05-18', 22.00, 32.00, 110, 35, 'Ernest Chemists', 0),
('Insulin Actrapid 100IU/ml', '6220000000124', 'Diabetes', 'Novo Nordisk', '100IU/ml 10ml vial', '10ml vial', 1, 'IN-2408', '2026-09-05', 75.00, 95.00, 25, 10, 'Tobinco', 0),
('Vitamin C 500mg Tablets', '6220000000125', 'Vitamins', 'Unique', '500mg x100 tabs', 'x100 tabs', 0, 'VC-2410', '2028-07-15', 11.00, 18.00, 180, 40, 'Glico', 0),
('Vitamin B-Complex Tablets', '6220000000126', 'Vitamins', 'Zim', 'x100 tabs', 'x100 tabs', 0, 'BC-2404', '2027-10-30', 12.00, 20.00, 160, 40, 'Letap', 0),
('Folic Acid 5mg Tablets', '6220000000127', 'Vitamins', 'Zim', '5mg x100 tabs', 'x100 tabs', 0, 'FA-2406', '2028-02-28', 7.00, 12.00, 140, 35, 'Asmed', 0),
('Ferrous Sulfate 200mg Tablets', '6220000000128', 'Vitamins', 'Hovid', '200mg x100 tabs', 'x100 tabs', 0, 'FS-2409', '2027-09-30', 8.00, 14.00, 120, 30, 'Kinapharma', 0),
('Multivitamin Syrup 200ml', '6220000000129', 'Vitamins', 'Unique', '200ml bottle', '200ml', 0, 'MV-2411', '2027-08-25', 24.00, 35.00, 80, 20, 'Ernest Chemists', 0),
('Zinc 20mg Tablets', '6220000000130', 'Vitamins', 'Zim', '20mg x100 tabs', 'x100 tabs', 0, 'ZN-2407', '2028-04-10', 10.00, 16.00, 100, 30, 'DFC', 0),
('Calcium + Vitamin D3 Tablets', '6220000000131', 'Vitamins', 'Macleods', 'x100 tabs', 'x100 tabs', 0, 'CA-2412', '2027-12-20', 30.00, 42.00, 90, 25, 'La Gray', 0),
('Dextromethorphan Syrup 100ml', '6220000000132', 'Cough & Cold', 'Hovid', '100ml bottle', '100ml', 0, 'DM-2405', '2027-05-10', 16.00, 25.00, 110, 30, 'Tobinco', 0),
('Guaifenesin Syrup 100ml', '6220000000133', 'Cough & Cold', 'Unique', '100ml bottle', '100ml', 0, 'GF-2408', '2027-06-28', 14.00, 22.00, 95, 25, 'Glico', 0),
('Salbutamol Inhaler 100mcg', '6220000000134', 'Respiratory', 'GSK', '100mcg/dose 200 doses', 'inhaler', 1, 'SB-2403', '2027-04-15', 28.00, 40.00, 70, 20, 'Ernest Chemists', 0),
('Beclomethasone Inhaler 100mcg', '6220000000135', 'Respiratory', 'GSK', '100mcg/dose 200 doses', 'inhaler', 1, 'BC-2406', '2027-03-20', 34.00, 48.00, 45, 15, 'La Gray', 0),
('Loratadine 10mg Tablets', '6220000000136', 'Antihistamines', 'Cipla', '10mg x100 tabs', 'x100 tabs', 0, 'LR-2410', '2028-06-15', 11.00, 18.00, 130, 35, 'Kinapharma', 0),
('Cetirizine 10mg Tablets', '6220000000137', 'Antihistamines', 'Sanofi', '10mg x100 tabs', 'x100 tabs', 0, 'CZ-2409', '2028-01-30', 9.00, 15.00, 120, 30, 'DFC', 0),
('Chlorpheniramine 4mg Tablets', '6220000000138', 'Antihistamines', 'Zim', '4mg x100 tabs', 'x100 tabs', 0, 'CH-2402', '2027-08-08', 4.00, 8.00, 24, 30, 'Asmed', 0),
('Omeprazole 20mg Capsules', '6220000000139', 'Gastrointestinal', 'AstraZeneca', '20mg x100 caps', 'x100 caps', 0, 'OM-2411', '2027-11-10', 20.00, 30.00, 150, 40, 'Ernest Chemists', 0),
('Domperidone 10mg Tablets', '6220000000140', 'Gastrointestinal', 'Janssen', '10mg x100 tabs', 'x100 tabs', 0, 'DP-2407', '2027-07-05', 19.00, 28.00, 70, 25, 'Tobinco', 0),
('Loperamide 2mg Capsules', '6220000000141', 'Gastrointestinal', 'Hovid', '2mg x100 caps', 'x100 caps', 0, 'LP-2404', '2027-06-12', 13.00, 20.00, 0, 20, 'Glico', 0),
('Antacid Suspension 200ml', '6220000000142', 'Gastrointestinal', 'Unique', '200ml bottle', '200ml', 0, 'AN-2409', '2027-09-18', 18.00, 28.00, 90, 25, 'Kinapharma', 0),
('Albendazole 400mg Tablet', '6220000000143', 'Gastrointestinal', 'Zim', '400mg x1 tab', 'x1 tab', 0, 'AB-2412', '2028-05-25', 2.50, 5.00, 200, 60, 'DFC', 0),
('Mebendazole 100mg Tablets', '6220000000144', 'Gastrointestinal', 'Zim', '100mg x100 tabs', 'x100 tabs', 0, 'MB-2406', '2027-10-05', 11.00, 18.00, 85, 30, 'Letap', 0),
('Clotrimazole Cream 1% 20g', '6220000000145', 'Skin Care', 'Bayer', '1% 20g tube', '20g', 0, 'CL-2408', '2027-08-30', 9.00, 15.00, 110, 35, 'Asmed', 0),
('Miconazole Cream 2% 20g', '6220000000146', 'Skin Care', 'Janssen', '2% 20g tube', '20g', 0, 'MC-2405', '2027-05-28', 11.00, 18.00, 80, 25, 'Tobinco', 0),
('Hydrocortisone Cream 1% 15g', '6220000000147', 'Skin Care', 'Sanofi', '1% 15g tube', '15g', 0, 'HC-2403', '2026-10-01', 13.00, 20.00, 65, 20, 'Glico', 0),
('Betadine 10% Solution 100ml', '6220000000148', 'First Aid', 'Mundipharma', '10% 100ml bottle', '100ml', 0, 'BT-2407', '2026-09-25', 16.00, 25.00, 75, 25, 'Ernest Chemists', 0),
('Gentamicin Eye/Ear Drops 0.3% 10ml', '6220000000149', 'Eye Care', 'Cipla', '0.3% 10ml bottle', '10ml', 1, 'GT-2409', '2027-11-15', 14.00, 22.00, 85, 25, 'La Gray', 0),
('Chloramphenicol Eye Drops 0.5% 10ml', '6220000000150', 'Eye Care', 'Sanofi', '0.5% 10ml bottle', '10ml', 1, 'CM-2401', '2026-07-10', 11.00, 18.00, 60, 20, 'Kinapharma', 0),
('Artificial Tears 10ml', '6220000000151', 'Eye Care', 'Alcon', '10ml bottle', '10ml', 0, 'AT-2406', '2027-12-01', 21.00, 30.00, 0, 15, 'DFC', 0),
('Methylated Spirit 500ml', '6220000000152', 'First Aid', 'Unique', '500ml bottle', '500ml', 0, 'MS-2410', '2028-03-20', 11.00, 18.00, 140, 40, 'Letap', 0),
('Surgical Cotton Wool 100g', '6220000000153', 'First Aid', 'Hovid', '100g roll', '100g', 0, 'CW-2408', '2027-10-12', 7.00, 12.00, 120, 35, 'Asmed', 0),
('Adhesive Plaster Roll', '6220000000154', 'First Aid', 'Unique', '2.5cm x 4.5m roll', 'roll', 0, 'AP-2404', '2028-01-05', 6.00, 10.00, 90, 25, 'Glico', 0),
('Disposable Gloves (pair)', '6220000000155', 'First Aid', 'M&G', 'latex, powder-free', 'pair', 0, 'GL-2412', '2028-08-01', 0.80, 1.50, 500, 150, 'Tobinco', 0),
('Syringe 5ml', '6220000000156', 'First Aid', 'Durbin', '5ml, sterile', 'each', 0, 'SY-2409', '2028-06-10', 1.00, 2.00, 300, 100, 'Ernest Chemists', 0),
('Glucose 25% 50ml IV', '6220000000157', 'First Aid', 'Fresenius', '25% 50ml vial', '50ml', 1, 'GL-2405', '2027-04-25', 8.00, 12.00, 40, 15, 'DFC', 0);

-- 4. Sample sales (DMO- prefix, clear of the live RCPT- format). Line items
-- resolve products by barcode with per-row NOT EXISTS guards, so re-runs
-- and non-empty databases never duplicate or mislink.
INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0001', 51.0, 'Cash', 'Kwame', 60.0, 9.0, 'Ama Mensah', '0241234567', 51.0, 0, 0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0001');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Paracetamol 500mg Tablets', 2, 8.0, 'bottle (100 tabs)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0001' AND p.barcode = '6220000000035'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000035');
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Amoxicillin 500mg Capsules', 1, 35.0, 'bottle (100 caps)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0001' AND p.barcode = '6220000000028'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000028');
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'Cash', 51.0, NULL
FROM sales s WHERE s.receipt_no = 'DMO-0001'
AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id);

INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0002', 100.0, 'MoMo', 'Akosua', NULL, 0, 'Kofi Owusu', '0209876543', 100.0, 0, 0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0002');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Coartem 20/120 (Artemether-Lumefantrine)', 1, 52.0, 'strip (6 tabs)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0002' AND p.barcode = '6220000000011'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000011');
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Metformin 500mg Tablets', 2, 24.0, 'bottle (100 tabs)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0002' AND p.barcode = '6220000000073'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000073');
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'MoMo', 100.0, 'MO2508A1B2C3D'
FROM sales s WHERE s.receipt_no = 'DMO-0002'
AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id);

INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount, timestamp)
SELECT 'DMO-0003', 52.0, 'Card', 'Kwame', 52.0, 0, 'Yaa Boateng', '0551112233', 52.0, 0, 0, datetime('now', 'localtime', '-1 day')
WHERE NOT EXISTS (SELECT 1 FROM sales WHERE receipt_no = 'DMO-0003');

INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Lisinopril 10mg Tablets', 2, 18.0, 'strip (28 tabs)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0003' AND p.barcode = '6220000000059'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000059');
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
SELECT s.id, p.id, 'Amlodipine 5mg Tablets', 1, 16.0, 'strip (28 tabs)'
FROM sales s, products p WHERE s.receipt_no = 'DMO-0003' AND p.barcode = '6220000000066'
AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN products pp ON pp.id = si.product_id WHERE si.sale_id = s.id AND pp.barcode = '6220000000066');
INSERT INTO sale_payments (sale_id, method, amount, reference)
SELECT s.id, 'Card', 52.0, 'CARD0001'
FROM sales s WHERE s.receipt_no = 'DMO-0003'
AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id);

INSERT INTO sale_returns (sale_id, receipt_no, total_refunded, reason, operator, timestamp)
SELECT s.id, 'DMO-0003', 18.0, 'Customer returned 1 strip', 'Kwame', datetime('now', 'localtime', '-1 day')
FROM sales s WHERE s.receipt_no = 'DMO-0003'
AND NOT EXISTS (SELECT 1 FROM sale_returns sr WHERE sr.receipt_no = 'DMO-0003');
INSERT INTO sale_return_items (return_id, product_id, product_name, quantity, unit_price, unit)
SELECT r.id, p.id, 'Lisinopril 10mg Tablets', 1, 18.0, 'strip (28 tabs)'
FROM sale_returns r, products p WHERE r.receipt_no = 'DMO-0003' AND p.barcode = '6220000000059'
AND NOT EXISTS (SELECT 1 FROM sale_return_items sri JOIN products pp ON pp.id = sri.product_id WHERE sri.return_id = r.id AND pp.barcode = '6220000000059');

-- 5. Demo supplier with one open purchase + Demo low/expired/expiring products.
INSERT OR IGNORE INTO suppliers (name, phone, location)
VALUES ('Demo Wholesale Ltd', '0300000000', 'Accra');

INSERT INTO purchases (id, reference_no, supplier_id, supplier_name, purchase_date, pay_term, status, discount_type, discount_amount, total_amount, created_at)
SELECT 'PUR-DEMO-001', 'DEMO-WAYBILL-1',
       (SELECT id FROM suppliers WHERE name = 'Demo Wholesale Ltd'),
       'Demo Wholesale Ltd', date('now', 'localtime'), 'Cash', 'Ordered',
       'None', 0.0, 400.0, datetime('now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE id = 'PUR-DEMO-001');

INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_type, quantity, qty_received, unit_cost_raw, discount_percent, unit_cost_net, line_total, profit_margin_percent, unit_selling_price, mfg_date, expiry_date, batch_no)
SELECT 'PI-DEMO-001', 'PUR-DEMO-001', p.id,
       p.name,
       'Pack', 10, 0, 40.0, 0.0, 40.0, 400.0, NULL, 55.0, NULL, '2027-08-30', 'DM-0001'
FROM products p WHERE p.barcode = '6220000000011'
AND NOT EXISTS (SELECT 1 FROM purchase_items WHERE id = 'PI-DEMO-001');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Low Stock Item', '6220000000DLO', 'Demo', 5.0, 10.0, 3, 20, '2028-01-01', 0, 0, 'pack');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Expired Item', '6220000000DEX', 'Demo', 5.0, 10.0, 10, 20, '2020-01-01', 0, 0, 'pack');

INSERT OR IGNORE INTO products (name, barcode, category, cost_price, selling_price, stock_qty, reorder_level, expiry_date, rx_flag, is_controlled, unit)
VALUES ('Demo — Expiring Item', '6220000000DEXP', 'Demo', 5.0, 10.0, 10, 20, date('now', 'localtime', '+20 days'), 0, 0, 'pack');
