-- Up Migration
-- Billing's own rows beside @pgstencil/stripe's pgstencil_billing schema
-- (docs/specs/hosted.md -> "Billing").

-- A founder who opted into the founders row, under the name they chose to show.
CREATE TABLE dormouse_founders (
    "userId" text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    "shownSince" timestamptz NOT NULL DEFAULT now()
);

-- The optional Van Westendorp answers from the checkout success page, one
-- set per account, each a whole-dollar yearly price or unanswered.
CREATE TABLE dormouse_price_survey (
    "userId" text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    "tooExpensive" integer CHECK ("tooExpensive" BETWEEN 0 AND 100000),
    "tooCheap" integer CHECK ("tooCheap" BETWEEN 0 AND 100000),
    expensive integer CHECK (expensive BETWEEN 0 AND 100000),
    bargain integer CHECK (bargain BETWEEN 0 AND 100000),
    "answeredAt" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_price_survey;
DROP TABLE dormouse_founders;
