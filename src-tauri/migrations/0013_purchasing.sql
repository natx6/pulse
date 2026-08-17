-- Purchasing: supplier master + purchase invoices with batch lines.
-- Replaces the requisition flow as the order/receive surface. Open legacy
-- requisitions are backfilled below so no open order goes invisible.

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- One purchase = one supplier invoice / delivery. id is the display number
-- (PUR-YYYYMMDD-NNN); reference_no is the supplier's own waybill/invoice #
-- (auto-filled with the display number when left blank).
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  reference_no TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_name TEXT,
  purchase_date TEXT NOT NULL,
  pay_term TEXT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Ordered', 'Received')),
  discount_type TEXT NOT NULL DEFAULT 'None' CHECK (discount_type IN ('None', 'Fixed', 'Percentage')),
  discount_amount REAL NOT NULL DEFAULT 0.0,
  total_amount REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT 'Pack',
  quantity REAL NOT NULL,
  qty_received REAL NOT NULL DEFAULT 0,
  unit_cost_raw REAL NOT NULL DEFAULT 0.0,
  discount_percent REAL NOT NULL DEFAULT 0.0,
  unit_cost_net REAL NOT NULL DEFAULT 0.0,
  line_total REAL NOT NULL DEFAULT 0.0,
  profit_margin_percent REAL,
  unit_selling_price REAL NOT NULL DEFAULT 0.0,
  mfg_date TEXT,
  expiry_date TEXT NOT NULL DEFAULT '',
  batch_no TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

-- SKU for the live search (barcode scan / SKU / name).
ALTER TABLE products ADD COLUMN sku TEXT;

-- Backfill: copy open/partial legacy requisitions into purchases as 'Ordered'
-- so they remain visible and receivable. Completed POs stay in the legacy
-- tables (history). The NOT IN guard keeps this safe on re-run.
INSERT INTO purchases (id, reference_no, supplier_id, supplier_name, purchase_date,
                       pay_term, status, discount_type, discount_amount, total_amount, created_at)
SELECT po.po_no, po.po_no, NULL, po.supplier, date(po.created_at),
       'Cash', 'Ordered', 'None', 0.0,
       COALESCE((SELECT SUM(pi.qty * COALESCE(pi.unit_cost, 0)) FROM po_items pi WHERE pi.po_id = po.id), 0.0),
       po.created_at
FROM purchase_orders po
WHERE po.status = 'open' AND po.po_no NOT IN (SELECT id FROM purchases);

INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_type,
                            quantity, qty_received, unit_cost_raw, discount_percent,
                            unit_cost_net, line_total, profit_margin_percent,
                            unit_selling_price, mfg_date, expiry_date, batch_no)
SELECT 'PI-' || pi.id, po.po_no, pi.product_id, pi.product_name, 'Pack',
       pi.qty, pi.qty_received, COALESCE(pi.unit_cost, 0.0), 0.0,
       COALESCE(pi.unit_cost, 0.0), COALESCE(pi.qty * pi.unit_cost, 0.0), NULL,
       COALESCE(p.selling_price, 0.0), NULL, COALESCE(p.expiry_date, ''), COALESCE(p.batch_no, '')
FROM po_items pi
JOIN purchase_orders po ON po.id = pi.po_id
LEFT JOIN products p ON p.id = pi.product_id
JOIN purchases pu ON pu.id = po.po_no
WHERE 'PI-' || pi.id NOT IN (SELECT id FROM purchase_items);
