-- Up Migration
-- The name a computer was enrolled under, by default its hostname, which the
-- account page lists it by (docs/specs/hosted.md -> "Burrow enrollment"). A
-- computer enrolled before this, or by a Dormouse that sends none, has none.
-- The CHECK refuses what `reduceBurrowLabel` (remote-lib-common) strips: Cc,
-- Cf, Zl and Zp characters, padding, nothing, and more than 64 code points.
ALTER TABLE dormouse_relay_burrows ADD COLUMN label text CHECK (
    char_length(label) BETWEEN 1 AND 64
    AND label = btrim(label)
    AND label !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
);

-- Down Migration
ALTER TABLE dormouse_relay_burrows DROP COLUMN label;
