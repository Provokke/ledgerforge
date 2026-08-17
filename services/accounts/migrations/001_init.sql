-- Accounts service schema. Money is bigint minor units, never numeric/float.

CREATE TABLE accounts (
  id         text PRIMARY KEY,
  owner      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE balances (
  account_id text   NOT NULL REFERENCES accounts(id),
  currency   text   NOT NULL,
  available  bigint NOT NULL DEFAULT 0,
  held       bigint NOT NULL DEFAULT 0,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, currency),
  CONSTRAINT balances_available_nonneg CHECK (available >= 0),
  CONSTRAINT balances_held_nonneg CHECK (held >= 0)
);

-- A hold earmarks funds for one order. Fills eat into it (consumed), the rest
-- goes back to available when the order is cancelled or done.
CREATE TABLE holds (
  id         text PRIMARY KEY,
  account_id text   NOT NULL,
  currency   text   NOT NULL,
  amount     bigint NOT NULL,
  consumed   bigint NOT NULL DEFAULT 0,
  status     text   NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES balances(account_id, currency),
  CONSTRAINT holds_amount_pos CHECK (amount > 0),
  CONSTRAINT holds_consumed_range CHECK (consumed >= 0 AND consumed <= amount),
  CONSTRAINT holds_status CHECK (status IN ('open', 'closed'))
);
CREATE INDEX holds_account_idx ON holds (account_id, currency) WHERE status = 'open';

-- Consumers record every event id they have applied, in the same transaction
-- as the work, so a redelivery is a no-op.
CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
