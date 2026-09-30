-- Backfill the FEFO batch ledger for stock that predates it.
-- Seed catalogs and legacy rows carry products.stock_qty (plus the product's
-- own batch_no/expiry_date columns) with no matching product_batches rows,
-- which leaves the Inventory batch expander empty ("Nothing on the shelf")
-- and blinds the POS pick hint, even though the aggregate stock is right.
-- Rebuild one batch row per under-ledgered product from its own columns.
-- Idempotent: only products with stock and zero batch rows are touched, so
-- re-running (or running on a healthy database) changes nothing.
INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity)
SELECT p.id,
       NULLIF(TRIM(COALESCE(p.batch_no, '')), ''),
       NULLIF(TRIM(COALESCE(p.expiry_date, '')), ''),
       p.stock_qty
FROM products p
WHERE p.stock_qty > 0
  AND NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.product_id = p.id);
