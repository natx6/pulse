-- Customers get an optional email (used for contact; not required at sale time).
ALTER TABLE patients ADD COLUMN email TEXT;
