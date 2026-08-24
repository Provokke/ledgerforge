-- Ledger schema. Append-only: the database itself refuses UPDATE/DELETE/TRUNCATE,
-- and refuses to commit an entry whose postings don't net to zero per currency.

CREATE TABLE journal_head (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  seq       bigint NOT NULL DEFAULT 0,
  last_hash text   NOT NULL DEFAULT repeat('0', 64)
);
INSERT INTO journal_head DEFAULT VALUES;

CREATE TABLE journal_entries (
  seq        bigint PRIMARY KEY,
  id         text   NOT NULL UNIQUE,
  memo       text   NOT NULL DEFAULT '',
  prev_hash  text   NOT NULL,
  hash       text   NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_postings (
  entry_seq bigint NOT NULL REFERENCES journal_entries(seq),
  idx       int    NOT NULL,
  account   text   NOT NULL,
  side      text   NOT NULL CHECK (side IN ('debit', 'credit')),
  amount    bigint NOT NULL CHECK (amount > 0),
  currency  text   NOT NULL,
  PRIMARY KEY (entry_seq, idx)
);
CREATE INDEX journal_postings_account_idx ON journal_postings (account, currency);

CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE FUNCTION journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal is append-only (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER journal_entries_ro BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_immutable();
CREATE TRIGGER journal_postings_ro BEFORE UPDATE OR DELETE ON journal_postings FOR EACH ROW EXECUTE FUNCTION journal_immutable();
CREATE TRIGGER journal_entries_notrunc BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION journal_immutable();
CREATE TRIGGER journal_postings_notrunc BEFORE TRUNCATE ON journal_postings FOR EACH STATEMENT EXECUTE FUNCTION journal_immutable();

-- Checked at COMMIT so all the postings of an entry can be inserted first.
CREATE FUNCTION journal_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) AS net INTO bad
    FROM journal_postings WHERE entry_seq = NEW.entry_seq
    GROUP BY currency HAVING sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'entry % does not balance: % out by %', NEW.entry_seq, bad.currency, bad.net USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_postings_balanced AFTER INSERT ON journal_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
