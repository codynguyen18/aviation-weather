"use client";

import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import type { RouteModel } from "@/lib/route/types";

// Route map (PLAN.md §15): MapLibre with segment rating colors, hazard clip
// overlays, waypoint markers, and an official NWS radar WMS toggle. Every
// layer that shows weather carries its product time; radar is display-only.

const RATING_COLORS: Record<string, string> = {
  green: "#2f9e58", yellow: "#d8a416", red: "#d64545", unknown: "#8a7fb8",
};

const RADAR_TILES =
  "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows" +
  "?service=WMS&version=1.3.0&request=GetMap&layers=conus_bref_qcd" +
  "&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256" +
  "&format=image/png&transparent=true";

interface HazardOverlay {
  segmentSeq: number;
  hazard: string;
  product: string;
  validTo: string;
  geometry: object | null;
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
  const [hazardCount, setHazardCount] = useState<number | null>(null);

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

    map.on("load", async () => {
      // Route segments colored by rating.
      const segmentFc = {
        type: "FeatureCollection" as const,
        features: route.segments.map((s) => ({
          type: "Feature" as const,
          properties: {
            seq: s.seq,
            rating: ratingBySeq.get(s.seq) ?? "unknown",
          },
          geometry: { type: "LineString" as const, coordinates: s.points },
        })),
      };
      map.addSource("route", { type: "geojson", data: segmentFc });
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

      // Waypoints.
      for (const w of route.waypoints) {
        new maplibregl.Marker({ color: "#4a9eda", scale: 0.8 })
          .setLngLat([w.lon, w.lat])
          .setPopup(new maplibregl.Popup({ closeButton: false }).setText(w.ident))
          .addTo(map);
      }

      // Hazard clip overlays for this snapshot.
      try {
        const res = await fetch(`/api/briefings/${snapshotId}/hazards`);
        if (res.ok) {
          const body = (await res.json()) as { hazards: HazardOverlay[] };
          const feats = body.hazards
            .filter((h) => h.geometry)
            .map((h) => ({
              type: "Feature" as const,
              properties: {
                label: `${h.hazard} (${h.product}) valid to ${h.validTo.slice(11, 16)}Z`,
                hazard: h.hazard,
              },
              geometry: h.geometry as never,
            }));
          setHazardCount(feats.length);
          map.addSource("hazards", {
            type: "geojson",
            data: { type: "FeatureCollection", features: feats },
          });
          map.addLayer({
            id: "hazard-fill", type: "fill", source: "hazards",
            paint: {
              "fill-color": ["match", ["get", "hazard"],
                "CONVECTIVE", "#d64545", "ICE", "#5aa7de", "TURB", "#d8a416", "#a08ad0"],
              "fill-opacity": 0.22,
            },
            layout: { visibility: showHazards ? "visible" : "none" },
          }, "route-casing");
          map.addLayer({
            id: "hazard-outline", type: "line", source: "hazards",
            paint: { "line-color": "#d64545", "line-width": 1, "line-dasharray": [3, 2] },
            layout: { visibility: showHazards ? "visible" : "none" },
          }, "route-casing");
          map.on("click", "hazard-fill", (e) => {
            const f = e.features?.[0];
            if (f) {
              new maplibregl.Popup().setLngLat(e.lngLat)
                .setText(String(f.properties?.label ?? "hazard")).addTo(map);
            }
          });
        }
      } catch {
        setHazardCount(null);
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
      }, "route-casing");

      map.on("click", "route-segments", (e) => {
        const f = e.features?.[0];
        if (f) onSelect(Number(f.properties?.seq));
      });
      map.on("mouseenter", "route-segments", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "route-segments", () => { map.getCanvas().style.cursor = ""; });

      // Fit to route.
      const b = new maplibregl.LngLatBounds();
      for (const s of route.segments) for (const p of s.points) b.extend(p as [number, number]);
      map.fitBounds(b, { padding: 60, duration: 0 });
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
    map.setLayoutProperty("hazard-fill", "visibility", v);
    map.setLayoutProperty("hazard-outline", "visibility", v);
  }, [showHazards]);

  return (
    <div className="panel" style={{ padding: 8 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "2px 6px 8px" }}>
        <b>Route map</b>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
          <input type="checkbox" checked={showHazards} onChange={(e) => setShowHazards(e.target.checked)} />
          hazards{hazardCount !== null ? ` (${hazardCount})` : ""}
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
          <input type="checkbox" checked={showRadar} onChange={(e) => setShowRadar(e.target.checked)} />
          radar (display only — strategic, not tactical)
        </label>
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          click a segment for details
        </span>
      </div>
      <div ref={div} style={{ height: 440, borderRadius: 8, overflow: "hidden" }} />
    </div>
  );
}
