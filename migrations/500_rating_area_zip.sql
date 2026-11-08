-- Some CMS individual-market geographic divisions (notably Alaska) are ZIP3, not counties.
-- Never convert them into a guessed county rating area.
CREATE TABLE rating_area_zip (
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  zip_prefix text NOT NULL CHECK (zip_prefix ~ '^[0-9]{3}$'),
  rating_area_id text NOT NULL CHECK (rating_area_id ~ '^Rating Area [1-9][0-9]*$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 9999),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  PRIMARY KEY (snapshot_id,state,zip_prefix,plan_year)
);
