-- FDA Ghana registered drugs catalog for autocomplete.
-- Populated on demand via the scraper (scripts/scrape-fda.js) and the
-- refresh_fda_catalog command. Filtered to product_category DRUG/DRUGS only.
CREATE TABLE IF NOT EXISTS fda_drugs (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  product_name TEXT NOT NULL,
  generic_name TEXT,
  strength TEXT,
  active_ingredient TEXT,
  dosage_form TEXT,
  product_category TEXT,
  product_sub_category TEXT,
  registration_number TEXT,
  manufacturer TEXT,
  client_name TEXT,
  registration_date TEXT,
  expiry_date TEXT,
  status TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS fda_drugs_fts USING fts5(
  product_name, generic_name, strength, active_ingredient,
  content='fda_drugs', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Keep FTS in sync.
CREATE TRIGGER IF NOT EXISTS fda_drugs_ai AFTER INSERT ON fda_drugs BEGIN
  INSERT INTO fda_drugs_fts(rowid, product_name, generic_name, strength, active_ingredient)
  VALUES (new.rowid, new.product_name, new.generic_name, new.strength, new.active_ingredient);
END;
CREATE TRIGGER IF NOT EXISTS fda_drugs_ad AFTER DELETE ON fda_drugs BEGIN
  INSERT INTO fda_drugs_fts(fda_drugs_fts, rowid, product_name, generic_name, strength, active_ingredient)
  VALUES ('delete', old.rowid, old.product_name, old.generic_name, old.strength, old.active_ingredient);
END;
CREATE TRIGGER IF NOT EXISTS fda_drugs_au AFTER UPDATE ON fda_drugs BEGIN
  INSERT INTO fda_drugs_fts(fda_drugs_fts, rowid, product_name, generic_name, strength, active_ingredient)
  VALUES ('delete', old.rowid, old.product_name, old.generic_name, old.strength, old.active_ingredient);
  INSERT INTO fda_drugs_fts(rowid, product_name, generic_name, strength, active_ingredient)
  VALUES (new.rowid, new.product_name, new.generic_name, new.strength, new.active_ingredient);
END;
