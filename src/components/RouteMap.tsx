"use client";

import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import type { RouteModel } from "@/lib/route/types";

// Route map (PLAN.md §15): MapLibre with segment rating colors, clickable
// hazard shapes, waypoint markers, and an official NWS radar WMS toggle. Every
// layer that shows weather carries its product time; radar is display-only.

const RATING_COLORS: Record<string, string> = {
  green: "#2f9e58", yellow: "#d8a416", red: "#d64545", unknown: "#8a7fb8",
};

// Hazard colors by family (matched in the map style expression + legend).
const HAZARD_COLORS: { key: string; color: string; label: string }[] = [
  { key: "CONVECTIVE", color: "#d64545", label: "Convective / thunderstorm" },
  { key: "TS", color: "#d64545", label: "Thunderstorm" },
  { key: "ICE", color: "#5aa7de", label: "Icing" },
  { key: "TURB", color: "#d8a416", label: "Turbulence" },
  { key: "IFR", color: "#9b7fd0", label: "IFR / mountain obsc." },
  { key: "OTHER", color: "#a08ad0", label: "Other advisory" },
];

const RADAR_TILES =
  "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows" +
  "?service=WMS&version=1.3.0&request=GetMap&layers=conus_bref_qcd" +
  "&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256" +
  "&format=image/png&transparent=true";

interface Hazard {
  hazardId: string;
  sourceRecordId: string;
  product: string;
  hazard: string;
  severity: string | null;
  floorFtMsl: number | null;
  ceilingFtMsl: number | null;
  validFrom: string;
  validTo: string;
  rawText: string | null;
  station: string | null;
  geometry: object | null;
  onRoute: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hhmm = (iso: string) => {
  try { return new Date(iso).toISOString().slice(11, 16) + "Z"; } catch { return "?"; }
};

const alt = (floor: number | null, ceiling: number | null) => {
  const lo = floor === null ? "SFC" : `${floor.toLocaleString()} ft`;
  const hi = ceiling === null ? "unlimited" : `${ceiling.toLocaleString()} ft`;
  return `${lo} – ${hi}`;
};

function hazardPopupHtml(h: Hazard): string {
  const title = `${esc(h.product)} · ${esc(h.hazard)}${h.severity ? " (" + esc(h.severity) + ")" : ""}`;
  const badge = h.onRoute
    ? `<span style="background:#5a1f1f;color:#ffb4b4;padding:1px 6px;border-radius:999px;font-size:11px">on your route</span>`
    : `<span style="background:#26313d;color:#9fb3c8;padding:1px 6px;border-radius:999px;font-size:11px">near your route — outside your corridor / time</span>`;
  const raw = h.rawText
    ? `<pre style="white-space:pre-wrap;word-break:break-word;background:#0b0f14;color:#cbd5e1;padding:8px;border-radius:6px;max-height:160px;overflow:auto;margin:6px 0 0;font-size:11.5px">${esc(h.rawText)}</pre>`
    : "";
  return `
    <div style="max-width:320px;font-family:system-ui,sans-serif;color:#e6edf3">
      <div style="font-weight:700;margin-bottom:3px">${title}</div>
      <div style="margin-bottom:5px">${badge}</div>
      <div style="font-size:12px;color:#9fb3c8;display:grid;gap:1px">
        ${h.station ? `<span>office/station: ${esc(h.station)}</span>` : ""}
        <span>valid ${hhmm(h.validFrom)} → ${hhmm(h.validTo)}</span>
        <span>altitudes: ${alt(h.floorFtMsl, h.ceilingFtMsl)}</span>
      </div>
      ${raw}
    </div>`;
}

export default function RouteMap(props: {
  route: RouteModel;
  snapshotId: string;
  ratingBySeq: Map<number, string>;
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
}) {
  const { route, snapshotId, ratingBySeq, onSelect } = props;
  const div = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [showRadar, setShowRadar] = useState(false);
  const [showHazards, setShowHazards] = useState(true);
  const [counts, setCounts] = useState<{ onRoute: number; nearby: number } | null>(null);

  useEffect(() => {
    if (!div.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: div.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-98, 39],
      zoom: 3.5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    // Hazard fill color expression keyed off the hazard family.
    const hazardColorExpr: maplibregl.ExpressionSpecification = [
      "match", ["get", "hazard"],
      "CONVECTIVE", "#d64545", "TS", "#d64545",
      "ICE", "#5aa7de", "TURB", "#d8a416",
      "IFR", "#9b7fd0", "MTN OBSCN", "#9b7fd0",
      "#a08ad0",
    ];

    map.on("load", async () => {
      const segmentFc = {
        type: "FeatureCollection" as const,
        features: route.segments.map((s) => ({
          type: "Feature" as const,
          properties: { seq: s.seq, rating: ratingBySeq.get(s.seq) ?? "unknown" },
          geometry: { type: "LineString" as const, coordinates: s.points },
        })),
      };
      map.addSource("route", { type: "geojson", data: segmentFc });

      // Hazards drawn first (under the route line). Placeholder source; filled
      // once the fetch returns.
      map.addSource("hazards", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "hazard-fill", type: "fill", source: "hazards",
        paint: {
          "fill-color": hazardColorExpr,
          "fill-opacity": ["case", ["get", "onRoute"], 0.32, 0.14],
        },
      });
      map.addLayer({
        id: "hazard-outline-on", type: "line", source: "hazards",
        filter: ["==", ["get", "onRoute"], true],
        paint: { "line-color": hazardColorExpr, "line-width": 2 },
      });
      map.addLayer({
        id: "hazard-outline-near", type: "line", source: "hazards",
        filter: ["==", ["get", "onRoute"], false],
        paint: { "line-color": hazardColorExpr, "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.9 },
      });

      map.addLayer({
        id: "route-casing", type: "line", source: "route",
        paint: { "line-color": "#0b0f14", "line-width": 7, "line-opacity": 0.6 },
      });
      map.addLayer({
        id: "route-segments", type: "line", source: "route",
        paint: {
          "line-color": ["match", ["get", "rating"],
            "green", RATING_COLORS.green!, "yellow", RATING_COLORS.yellow!,
            "red", RATING_COLORS.red!, RATING_COLORS.unknown!],
          "line-width": 4.5,
        },
      });

      for (const w of route.waypoints) {
        new maplibregl.Marker({ color: "#4a9eda", scale: 0.8 })
          .setLngLat([w.lon, w.lat])
          .setPopup(new maplibregl.Popup({ closeButton: false }).setText(w.ident))
          .addTo(map);
      }

      // Radar WMS (official NWS; added hidden, toggled below).
      map.addSource("radar", {
        type: "raster", tiles: [RADAR_TILES], tileSize: 256,
        attribution: "Radar: NOAA/NWS MRMS",
      });
      map.addLayer({
        id: "radar", type: "raster", source: "radar",
        paint: { "raster-opacity": 0.55 },
        layout: { visibility: "none" },
      }, "hazard-fill");

      // Segment selection.
      map.on("click", "route-segments", (e) => {
        const f = e.features?.[0];
        if (f) onSelect(Number(f.properties?.seq));
      });
      map.on("mouseenter", "route-segments", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "route-segments", () => { map.getCanvas().style.cursor = ""; });

      // Hazard click -> detailed popup. Bound to the fill and both outlines so
      // thin (zero-area) G-AIRMET lines are clickable too.
      const byId = new Map<string, Hazard>();
      const openHazard = (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const h = f && byId.get(String(f.properties?.hazardId));
        if (!h) return;
        new maplibregl.Popup({ maxWidth: "340px" })
          .setLngLat(e.lngLat)
          .setHTML(hazardPopupHtml(h))
          .addTo(map);
      };
      for (const layer of ["hazard-fill", "hazard-outline-on", "hazard-outline-near"]) {
        map.on("click", layer, openHazard);
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      }

      // Fit to route now; hazards load asynchronously.
      const b = new maplibregl.LngLatBounds();
      for (const s of route.segments) for (const p of s.points) b.extend(p as [number, number]);
      map.fitBounds(b, { padding: 60, duration: 0 });

      try {
        const res = await fetch(`/api/briefings/${snapshotId}/hazards`);
        if (res.ok) {
          const body = (await res.json()) as {
            hazards: Hazard[]; onRouteCount: number; nearbyCount: number;
          };
          const feats = body.hazards
            .filter((h) => h.geometry)
            .map((h) => {
              byId.set(h.hazardId, h);
              return {
                type: "Feature" as const,
                properties: { hazardId: h.hazardId, hazard: h.hazard, onRoute: h.onRoute },
                geometry: h.geometry as never,
              };
            });
          (map.getSource("hazards") as maplibregl.GeoJSONSource | undefined)?.setData({
            type: "FeatureCollection", features: feats,
          });
          setCounts({ onRoute: body.onRouteCount, nearby: body.nearbyCount });
        }
      } catch {
        setCounts(null);
      }
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("radar")) return;
    map.setLayoutProperty("radar", "visibility", showRadar ? "visible" : "none");
  }, [showRadar]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("hazard-fill")) return;
    const v = showHazards ? "visible" : "none";
    for (const l of ["hazard-fill", "hazard-outline-on", "hazard-outline-near"]) {
      map.setLayoutProperty(l, "visibility", v);
    }
  }, [showHazards]);

  const hazardLabel =
    counts === null ? "" : ` (${counts.onRoute} on route · ${counts.nearby} nearby)`;

  return (
    <div className="panel" style={{ padding: 8 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "2px 6px 8px", flexWrap: "wrap" }}>
        <b>Route map</b>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
          <input type="checkbox" checked={showHazards} onChange={(e) => setShowHazards(e.target.checked)} />
          hazards{hazardLabel}
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
          <input type="checkbox" checked={showRadar} onChange={(e) => setShowRadar(e.target.checked)} />
          radar (display only — strategic, not tactical)
        </label>
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          click a segment or a hazard for details
        </span>
      </div>
      <div ref={div} style={{ height: 440, borderRadius: 8, overflow: "hidden" }} />
      {showHazards && counts !== null && (counts.onRoute + counts.nearby > 0) && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "8px 6px 2px", fontSize: 11.5 }} className="muted">
          {[...new Map(HAZARD_COLORS.map((h) => [h.color, h])).values()].map((h) => (
            <span key={h.color} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ width: 11, height: 11, background: h.color, opacity: 0.5, borderRadius: 2, display: "inline-block" }} />
              {h.label}
            </span>
          ))}
          <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <span>▬ solid = affects your route</span>
            <span>┄ dashed = nearby only</span>
          </span>
        </div>
      )}
    </div>
  );
}
