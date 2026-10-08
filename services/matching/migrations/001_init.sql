-- Every message the book has seen, in the order it saw it, with what came out.
-- Replaying the inputs rebuilds the book exactly; the stored output lets boot
-- check that the replay did the same thing as the first time.
CREATE TABLE match_log (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  msg_id     text NOT NULL UNIQUE,
  symbol     text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('order', 'cancel')),
  body       jsonb NOT NULL,
  output     jsonb NOT NULL,
  published  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION match_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.published IS NOT TRUE OR (to_jsonb(NEW) - 'published') <> (to_jsonb(OLD) - 'published') THEN
    RAISE EXCEPTION 'match_log is append-only (only published may flip to true)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER match_log_guard BEFORE UPDATE OR DELETE ON match_log FOR EACH ROW EXECUTE FUNCTION match_log_guard();
