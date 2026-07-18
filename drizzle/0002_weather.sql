-- 0002_weather: raw source records (provenance) + normalized observation,
-- forecast-group, and PIREP stores (PLAN.md §9, §13.3). Every normalized row
-- points back to the exact upstream payload it came from.

CREATE TABLE source_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text NOT NULL,       -- METAR|TAF|PIREP|AIRSIGMET|GAIRMET|CWA|WINDTEMP|AFD|ALERT
  station      text,                -- station / WFO / region key where applicable
  external_key text NOT NULL,       -- upstream identity for dedupe (e.g. METAR:KSTL:1784350440)
  issued_at    timestamptz,
  valid_from   timestamptz,
  valid_to     timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  upstream_url text NOT NULL,
  raw          jsonb NOT NULL,      -- untouched upstream payload ({text: ...} for text products)
  parse_status text NOT NULL DEFAULT 'ok',  -- ok | partial | failed
  UNIQUE (source_type, external_key)
);

CREATE INDEX source_records_lookup
  ON source_records (source_type, station, issued_at DESC);
CREATE INDEX source_records_fetched ON source_records (fetched_at);

CREATE TABLE weather_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  station          text NOT NULL,
  observed_at      timestamptz NOT NULL,
  geom             geography(Point, 4326),
  flight_category  text,            -- VFR | MVFR | IFR | LIFR (null if not derivable)
  temp_c           real,
  dewpoint_c       real,
  wind_dir_deg     integer,         -- null = variable or missing (see missing_fields)
  wind_speed_kt    integer,
  wind_gust_kt     integer,
  visibility_sm    real,            -- 10 means "10+" (capped value; cap noted in missing_fields as visibility_capped)
  ceiling_ft_agl   integer,         -- lowest BKN/OVC/VV; NULL = no ceiling reported
  altim_in_hg      real,
  wx_string        text,
  clouds           jsonb,           -- [{cover, baseFtAgl}]
  missing_fields   jsonb NOT NULL DEFAULT '[]',
  raw_text         text NOT NULL,
  UNIQUE (station, observed_at)
);

CREATE INDEX weather_observations_station
  ON weather_observations (station, observed_at DESC);

CREATE TABLE weather_forecasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  station          text NOT NULL,
  issued_at        timestamptz NOT NULL,
  group_seq        integer NOT NULL,
  group_type       text NOT NULL,   -- BASE | FM | BECMG | TEMPO | PROB
  probability      integer,
  valid_from       timestamptz NOT NULL,
  valid_to         timestamptz NOT NULL,
  wind_dir_deg     integer,         -- null = VRB or missing
  wind_speed_kt    integer,
  wind_gust_kt     integer,
  visibility_sm    real,
  ceiling_ft_agl   integer,
  wx_string        text,
  clouds           jsonb,
  raw_text         text NOT NULL    -- full raw TAF (same on every group of one TAF)
);

CREATE INDEX weather_forecasts_station
  ON weather_forecasts (station, valid_from, valid_to);

CREATE TABLE pireps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  observed_at      timestamptz NOT NULL,
  geom             geography(Point, 4326) NOT NULL,
  altitude_ft_msl  integer,
  altitude_note    text,            -- e.g. UNKN, DURC/DURD context
  aircraft_type    text,
  report_type      text NOT NULL,   -- PIREP | AIREP
  urgent           boolean NOT NULL DEFAULT false,
  turbulence       jsonb,           -- [{intensity, type, freq, baseFtMsl, topFtMsl}]
  icing            jsonb,
  clouds           jsonb,
  wx_string        text,
  temp_c           real,
  raw_text         text NOT NULL
);

CREATE INDEX pireps_geom ON pireps USING gist (geom);
CREATE INDEX pireps_time ON pireps (observed_at DESC);
