-- 0001_navdata: versioned navigation data (airports, runways, navaids).
-- Imports load a complete new dataset, then atomically flip `active` so
-- queries never see a half-imported cycle (PLAN.md §13.6). One active
-- dataset per source; the previous one is kept for rollback/diffing.

CREATE TABLE nav_datasets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,               -- 'ourairports' | 'nasr'
  version_label text NOT NULL,               -- e.g. upstream Last-Modified date
  imported_at   timestamptz NOT NULL DEFAULT now(),
  active        boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX nav_datasets_one_active_per_source
  ON nav_datasets (source) WHERE active;

CREATE TABLE nav_airports (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id        uuid NOT NULL REFERENCES nav_datasets(id) ON DELETE CASCADE,
  ident             text NOT NULL,           -- OurAirports ident (KSTL, KO22)
  icao_code         text,
  iata_code         text,
  gps_code          text,                    -- US small fields often live here
  local_code        text,
  name              text NOT NULL,
  type              text NOT NULL,           -- large_airport ... heliport, closed
  geom              geography(Point, 4326) NOT NULL,
  elevation_ft      integer,
  municipality      text,
  iso_region        text,
  iso_country       text NOT NULL,
  scheduled_service boolean NOT NULL DEFAULT false
);

CREATE INDEX nav_airports_ident   ON nav_airports (dataset_id, ident);
CREATE INDEX nav_airports_icao    ON nav_airports (dataset_id, icao_code);
CREATE INDEX nav_airports_gps     ON nav_airports (dataset_id, gps_code);
CREATE INDEX nav_airports_local   ON nav_airports (dataset_id, local_code);
CREATE INDEX nav_airports_iata    ON nav_airports (dataset_id, iata_code);
CREATE INDEX nav_airports_geom    ON nav_airports USING gist (geom);
CREATE INDEX nav_airports_name_lc ON nav_airports (lower(name) text_pattern_ops);

CREATE TABLE nav_runways (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id     uuid NOT NULL REFERENCES nav_datasets(id) ON DELETE CASCADE,
  airport_ident  text NOT NULL,
  le_ident       text,
  he_ident       text,
  length_ft      integer,
  width_ft       integer,
  surface        text,
  lighted        boolean NOT NULL DEFAULT false,
  closed         boolean NOT NULL DEFAULT false,
  le_heading_deg real,
  he_heading_deg real
);

CREATE INDEX nav_runways_airport ON nav_runways (dataset_id, airport_ident);

CREATE TABLE nav_navaids (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id             uuid NOT NULL REFERENCES nav_datasets(id) ON DELETE CASCADE,
  ident                  text NOT NULL,
  name                   text NOT NULL,
  type                   text NOT NULL,     -- VOR, VORTAC, VOR-DME, NDB, DME, TACAN
  frequency_khz          integer,
  geom                   geography(Point, 4326) NOT NULL,
  elevation_ft           integer,
  iso_country            text,
  magnetic_variation_deg real,
  usage_type             text,              -- HI | LO | BOTH | TERMINAL | RNAV
  associated_airport     text
);

CREATE INDEX nav_navaids_ident ON nav_navaids (dataset_id, ident);
CREATE INDEX nav_navaids_geom  ON nav_navaids USING gist (geom);
