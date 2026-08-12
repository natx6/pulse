-- Unit of measure for products (blister/strip, bottle, sachet...) and the
-- unit captured on each sale line so receipts and reprints show it.
ALTER TABLE products ADD COLUMN unit TEXT;
ALTER TABLE sale_items ADD COLUMN unit TEXT;

-- Demo seed units (matched by demo barcodes; real products untouched).
UPDATE products SET unit = 'strip (6 tabs)' WHERE barcode = '6220000000011';
UPDATE products SET unit = 'bottle (100 caps)' WHERE barcode = '6220000000028';
UPDATE products SET unit = 'bottle (100 tabs)' WHERE barcode = '6220000000035';
UPDATE products SET unit = 'bottle (50 tabs)' WHERE barcode = '6220000000042';
UPDATE products SET unit = 'strip (28 tabs)' WHERE barcode = '6220000000059';
UPDATE products SET unit = 'strip (28 tabs)' WHERE barcode = '6220000000066';
UPDATE products SET unit = 'bottle (100 tabs)' WHERE barcode = '6220000000073';
UPDATE products SET unit = 'sachet' WHERE barcode = '6220000000080';
