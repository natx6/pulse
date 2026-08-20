-- Expenses need a payment method so daily cash-up can subtract only the
-- expenses that actually came out of the till (Cash), instead of treating
-- every expense as a cash outflow regardless of how it was paid.
ALTER TABLE expenses ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'Cash';
