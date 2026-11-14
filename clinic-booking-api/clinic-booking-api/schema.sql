-- schema.sql
-- Run this ONCE in your database (Neon: SQL Editor > paste > Run).
-- It creates the four "tables" (think: spreadsheets) the API stores data in.

-- 1. SLOTS: the appointment times a patient can pick from.
--    start_text / end_text keep the time exactly as it was sent to us, so we
--    can hand it back unchanged. start_at is the same time in a form the
--    database can sort and compare.
CREATE TABLE IF NOT EXISTS slots (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  start_text  TEXT NOT NULL,
  end_text    TEXT NOT NULL,
  start_at    TIMESTAMPTZ NOT NULL
);

-- 2. BOOKINGS: one row per booking.
--    seq is an automatic counter (1, 2, 3...) so we always know which booking
--    came first. id is the public id we show to people.
CREATE TABLE IF NOT EXISTS bookings (
  seq         BIGSERIAL PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  slot_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LEVEL 3, the most important line in the project.
-- "A slot can appear only once among CONFIRMED bookings."
-- The database itself refuses a second confirmed booking for the same slot,
-- even if two requests arrive in the same millisecond. Cancelled bookings are
-- ignored by this rule, which is how cancelling frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id)
  WHERE status = 'confirmed';

-- Makes "find this person's bookings" fast.
CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

-- 3. IDEMPOTENCY KEYS (level 4): remembers the answer we gave for each
--    Idempotency-Key, so a retried request gets the same answer again.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key              TEXT PRIMARY KEY,
  body_hash        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    JSONB NOT NULL
);

-- 4. BOOKING ATTEMPTS (level 5): a log of who tried to book and when,
--    used to count "how many tries has this email made in the last minute?"
CREATE TABLE IF NOT EXISTS booking_attempts (
  id     BIGSERIAL PRIMARY KEY,
  email  TEXT NOT NULL,
  at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attempts_by_email ON booking_attempts (email, at);
