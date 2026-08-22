-- Batch-level stock ledger (FEFO) + pack/break-unit selling.
--
-- product_batches is a per-batch breakdown of products.stock_qty: the sum of
-- a product's batch quantities must always equal its stock_qty. Every path
-- that moves stock (sales, returns, voids, adjustments, intake, purchases)
-- updates both sides in the same transaction.
-- FEFO = First Expired, First Out: sales consume the nearest-expiry batch
-- first, so old stock never dies on the shelf behind newer stock.

CREATE TABLE IF NOT EXISTS product_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_no TEXT,
  expiry_date TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_lookup ON product_batches(product_id, batch_no, expiry_date);

-- Which batches a sold line came out of (e.g. 'AX-8821@2027-03-15x2;CT-2301x1')
-- — the recall trail: search this column to find every sale that dispensed a
-- given batch. NULL for legacy rows (pre-batch sales).
ALTER TABLE sale_items ADD COLUMN batches TEXT;

-- How many sell units one purchase pack contains (carton of 10 strips = 10).
-- 1 = sold exactly as stocked. Stock stays counted in sell units; packs are
-- a POS convenience (add a whole carton in one tap).
ALTER TABLE products ADD COLUMN pack_size INTEGER NOT NULL DEFAULT 1;

-- Backfill: each stocked product becomes one batch holding all its units,
-- stamped with the product's existing batch/expiry so FEFO starts correct.
INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity)
SELECT id, batch_no, expiry_date, stock_qty FROM products WHERE stock_qty > 0;
