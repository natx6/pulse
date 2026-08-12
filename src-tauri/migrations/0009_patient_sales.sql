-- Patient history: sales snapshot the patient's name/phone (same pattern as
-- the operator snapshot — deleting a patient never rewrites history). The
-- patients table is populated as a lookup index for search + history.
ALTER TABLE sales ADD COLUMN patient_name TEXT;
ALTER TABLE sales ADD COLUMN patient_phone TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_patient ON sales(patient_name);
