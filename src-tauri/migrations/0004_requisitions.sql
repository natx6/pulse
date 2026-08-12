-- Procurement requisitions: request stock, track it, receive it.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL UNIQUE,
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  qty_received INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id);
