-- Refresh demo-seed expiry dates for databases created before 2026-08-11
-- (the original seed carried 2025/26 dates and looked expired by then).
-- Matched by the demo barcodes so real products are never touched.
UPDATE products SET expiry_date = '2027-05-30' WHERE barcode = '6220000000011';
UPDATE products SET expiry_date = '2027-03-15' WHERE barcode = '6220000000028';
UPDATE products SET expiry_date = '2028-01-20' WHERE barcode = '6220000000035';
UPDATE products SET expiry_date = '2026-09-15' WHERE barcode = '6220000000042';
UPDATE products SET expiry_date = '2027-08-10' WHERE barcode = '6220000000059';
UPDATE products SET expiry_date = '2027-06-25' WHERE barcode = '6220000000066';
UPDATE products SET expiry_date = '2027-11-05' WHERE barcode = '6220000000073';
UPDATE products SET expiry_date = '2027-04-30' WHERE barcode = '6220000000080';
