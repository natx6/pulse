-- Product archive: inactive products vanish from the POS and live inventory
-- (see + receive), but keep their history. Restore from Inventory's
-- "Show archived" toggle. 1 = active (default), 0 = archived.
ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
