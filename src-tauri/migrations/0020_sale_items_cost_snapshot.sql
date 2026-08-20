-- Snapshot cost_price onto each sale line at the moment of sale, the same
-- pattern already used for product_name/unit. Without this, Gross Profit
-- reports silently change after the fact whenever a product's cost_price is
-- later updated (e.g. on restock), because profit was being computed from
-- the live catalog instead of what the item actually cost when it was sold.
-- NULL on existing rows (no way to know their true historical cost); the
-- report query falls back to the live cost_price only for those old rows.
ALTER TABLE sale_items ADD COLUMN unit_cost REAL;
