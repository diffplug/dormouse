-- Up Migration
-- A founding member who chose to appear in the founders row, under the name
-- they chose (docs/specs/hosted.md -> "Billing"). No row is the default: the
-- opt-in starts unticked, and unticking deletes the row. The CHECK refuses a
-- name with a Cc, Cf, Zl or Zp character, padding, nothing, or more than 64
-- code points, as 012's label CHECK does.
CREATE TABLE dormouse_founders (
    "userId" text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (
        char_length(name) BETWEEN 1 AND 64
        AND name = btrim(name)
        AND name !~ '[\u0001-\u001f\u007f-\u009f­؀-؅؜۝܏࢐࢑࣢᠎​-‏ -‮⁠-⁤⁦-⁯﻿￹-￻\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
    ),
    "shownSince" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_founders;
