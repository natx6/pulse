-- Point-in-time financial snapshot per sale: subtotal / discount / tax live
-- on the sale row so reprints stop reconstructing them (and stop printing
-- tax as 0). Legacy rows keep 0 defaults; reprint code falls back to the old
-- derivation for them.
ALTER TABLE sales ADD COLUMN subtotal REAL NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0;
