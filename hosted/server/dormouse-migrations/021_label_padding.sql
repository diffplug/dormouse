-- Up Migration
-- Padding as JavaScript's trim counts it, which `reduceBurrowLabel` and
-- `isFounderName` strip or refuse: 012's and 015's CHECKs compare against
-- btrim, which strips only U+0020. Of the other characters trim strips, these
-- refuse the Zs ones at either end; the rest are Cc, Cf, Zl, or Zp, which
-- those CHECKs refuse anywhere.
ALTER TABLE dormouse_relay_burrows ADD CONSTRAINT dormouse_relay_burrows_label_padding CHECK (
    label !~ '^[    -   　]|[    -   　]$'
);
ALTER TABLE dormouse_founders ADD CONSTRAINT dormouse_founders_name_padding CHECK (
    name !~ '^[    -   　]|[    -   　]$'
);

-- Down Migration
ALTER TABLE dormouse_founders DROP CONSTRAINT dormouse_founders_name_padding;
ALTER TABLE dormouse_relay_burrows DROP CONSTRAINT dormouse_relay_burrows_label_padding;
