-- 0003_hazards: hazard-area geometries (SIGMET / Conv SIGMET / G-AIRMET /
-- CWA) and winds/temps aloft (FB) — PLAN.md §9.3, §9.5.

CREATE TABLE hazard_geometries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  product          text NOT NULL,   -- AIRSIGMET | GAIRMET | CWA
  hazard           text NOT NULL,   -- CONVECTIVE|TURB|ICE|IFR|MTN_OBSC|LLWS|SFC_WIND|FZLVL|PCPN|OTHER
  severity         text,
  qualifier        text,            -- e.g. CWA 'ISOL TSRA MOD TO HVY PCPN', gairmet dueTo
  geom             geography(Geometry, 4326) NOT NULL,  -- Polygon or MultiPolygon
  floor_ft_msl     integer,         -- NULL = surface/unknown floor
  ceiling_ft_msl   integer,         -- NULL = unlimited/unknown top
  movement_dir_deg integer,
  movement_spd_kt  integer,
  forecast_hour    integer,         -- G-AIRMET snapshot hour (0/3/6/9/12)
  valid_from       timestamptz NOT NULL,
  valid_to         timestamptz NOT NULL,  -- conservative: max(api, raw text)
  raw_text         text
);

CREATE INDEX hazard_geometries_geom ON hazard_geometries USING gist (geom);
CREATE INDEX hazard_geometries_valid ON hazard_geometries (valid_from, valid_to);
CREATE INDEX hazard_geometries_hazard ON hazard_geometries (hazard);

CREATE TABLE winds_aloft (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  region           text NOT NULL,
  level_class      text NOT NULL,   -- low | high
  fcst             text NOT NULL,   -- 06 | 12 | 24
  based_on         timestamptz NOT NULL,
  for_use_from     timestamptz NOT NULL,
  for_use_to       timestamptz NOT NULL,
  station          text NOT NULL,   -- FB point ident (usually a VOR)
  level_ft         integer NOT NULL,
  wind_dir_deg     integer,         -- NULL when light & variable
  wind_speed_kt    integer NOT NULL,
  temp_c           integer,
  light_variable   boolean NOT NULL DEFAULT false,
  UNIQUE (source_record_id, station, level_ft)
);

CREATE INDEX winds_aloft_lookup ON winds_aloft (station, level_ft, for_use_from);
CREATE INDEX winds_aloft_window ON winds_aloft (for_use_from, for_use_to);
