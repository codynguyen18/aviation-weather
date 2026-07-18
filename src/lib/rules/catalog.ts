import type {
  RuleDefinition,
  RuleEvaluation,
  SegmentContext,
} from "@/lib/rules/types";

// MVP rule catalog (PLAN.md §11.4). Hard limits compare against the PILOT'S
// numbers and force red; advisories are app heuristics with visible
// thresholds. Missing-data behavior is per-rule and explicit: safety-critical
// unknowns force the segment to Unknown — absence of data is never green.

const ev = (
  rule: RuleDefinition,
  partial: Omit<RuleEvaluation, "ruleId" | "ruleVersion" | "ruleClass" | "safetyCritical">,
): RuleEvaluation => ({
  ruleId: rule.id,
  ruleVersion: rule.version,
  ruleClass: rule.ruleClass,
  safetyCritical: rule.safetyCritical,
  ...partial,
});

const isTerminal = (ctx: SegmentContext) => ctx.terminalAirports.length > 0;

// --- Hard limits ---------------------------------------------------------

const ceilingBelowMinimum: RuleDefinition = {
  id: "ceiling-below-minimum",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: true,
  evaluate(ctx) {
    const candidates = [
      ...ctx.observations.map((o) => ({
        kind: "observation" as const, station: o.station,
        value: o.ceilingFtAgl, src: o.sourceRecordId,
        stale: o.freshness === "stale", label: `METAR ${o.station}`,
      })),
      ...ctx.forecastGroups.map((f) => ({
        kind: "forecast" as const, station: f.station,
        value: f.ceilingFtAgl, src: f.sourceRecordId,
        stale: f.freshness === "stale", label: `TAF ${f.station} ${f.groupType}`,
      })),
    ];
    const usable = candidates.filter((c) => !c.stale);
    if (usable.length === 0) {
      if (!isTerminal(ctx)) return null; // en-route segment: no station of record
      return ev(this, {
        result: "unknown",
        measured: { candidates: candidates.length, allStale: candidates.length > 0 },
        thresholds: { minCeilingFt: ctx.minimums.minCeilingFt },
        confidence: "low",
        explanation: `No current ceiling information for ${ctx.terminalAirports.join("/")} — cannot verify your ${ctx.minimums.minCeilingFt} ft minimum`,
        isHardStop: false,
        sourceRecordIds: candidates.map((c) => c.src),
      });
    }
    const worst = usable
      .filter((c) => c.value !== null)
      .sort((a, b) => a.value! - b.value!)[0];
    if (worst && worst.value! < ctx.minimums.minCeilingFt) {
      return ev(this, {
        result: "red",
        measured: { ceilingFtAgl: worst.value, source: worst.label, kind: worst.kind },
        thresholds: { minCeilingFt: ctx.minimums.minCeilingFt },
        confidence: worst.kind === "observation" ? "high" : "medium",
        explanation: `${worst.label}: ceiling ${worst.value} ft is below your ${ctx.minimums.minCeilingFt} ft minimum`,
        isHardStop: true,
        sourceRecordIds: [worst.src],
      });
    }
    return ev(this, {
      result: "pass",
      measured: { lowestCeilingFtAgl: worst?.value ?? null },
      thresholds: { minCeilingFt: ctx.minimums.minCeilingFt },
      confidence: "high",
      explanation: `Ceilings at/above your ${ctx.minimums.minCeilingFt} ft minimum`,
      isHardStop: false,
      sourceRecordIds: usable.map((c) => c.src),
    });
  },
};

const visibilityBelowMinimum: RuleDefinition = {
  id: "visibility-below-minimum",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: true,
  evaluate(ctx) {
    const candidates = [
      ...ctx.observations.map((o) => ({
        value: o.visibilitySm, src: o.sourceRecordId, label: `METAR ${o.station}`,
        stale: o.freshness === "stale", kind: "observation" as const,
      })),
      ...ctx.forecastGroups.map((f) => ({
        value: f.visibilitySm, src: f.sourceRecordId, label: `TAF ${f.station} ${f.groupType}`,
        stale: f.freshness === "stale", kind: "forecast" as const,
      })),
    ];
    const usable = candidates.filter((c) => !c.stale && c.value !== null);
    if (usable.length === 0) {
      if (!isTerminal(ctx)) return null;
      return ev(this, {
        result: "unknown",
        measured: {},
        thresholds: { minVisibilitySm: ctx.minimums.minVisibilitySm },
        confidence: "low",
        explanation: `No current visibility information for ${ctx.terminalAirports.join("/")}`,
        isHardStop: false,
        sourceRecordIds: candidates.map((c) => c.src),
      });
    }
    const worst = usable.sort((a, b) => a.value! - b.value!)[0]!;
    if (worst.value! < ctx.minimums.minVisibilitySm) {
      return ev(this, {
        result: "red",
        measured: { visibilitySm: worst.value, source: worst.label },
        thresholds: { minVisibilitySm: ctx.minimums.minVisibilitySm },
        confidence: worst.kind === "observation" ? "high" : "medium",
        explanation: `${worst.label}: visibility ${worst.value} sm is below your ${ctx.minimums.minVisibilitySm} sm minimum`,
        isHardStop: true,
        sourceRecordIds: [worst.src],
      });
    }
    return ev(this, {
      result: "pass",
      measured: { lowestVisibilitySm: worst.value },
      thresholds: { minVisibilitySm: ctx.minimums.minVisibilitySm },
      confidence: "high",
      explanation: `Visibility at/above your ${ctx.minimums.minVisibilitySm} sm minimum`,
      isHardStop: false,
      sourceRecordIds: usable.map((c) => c.src),
    });
  },
};

const surfaceWindLimit: RuleDefinition = {
  id: "surface-wind-limit",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    if (!isTerminal(ctx)) return null;
    const winds = [
      ...ctx.observations.map((o) => ({
        speed: Math.max(o.windSpeedKt ?? 0, o.windGustKt ?? 0),
        src: o.sourceRecordId, label: `METAR ${o.station}`,
        stale: o.freshness === "stale",
      })),
      ...ctx.forecastGroups.map((f) => ({
        speed: Math.max(f.windSpeedKt ?? 0, f.windGustKt ?? 0),
        src: f.sourceRecordId, label: `TAF ${f.station} ${f.groupType}`,
        stale: f.freshness === "stale",
      })),
    ].filter((w) => !w.stale);
    if (winds.length === 0) {
      return ev(this, {
        result: "unknown",
        measured: {},
        thresholds: { maxSurfaceWindKt: ctx.minimums.maxSurfaceWindKt },
        confidence: "low",
        explanation: `No current surface wind information for ${ctx.terminalAirports.join("/")}`,
        isHardStop: false,
        sourceRecordIds: [],
      });
    }
    const worst = winds.sort((a, b) => b.speed - a.speed)[0]!;
    if (worst.speed > ctx.minimums.maxSurfaceWindKt) {
      return ev(this, {
        result: "red",
        measured: { windOrGustKt: worst.speed, source: worst.label },
        thresholds: { maxSurfaceWindKt: ctx.minimums.maxSurfaceWindKt },
        confidence: "high",
        explanation: `${worst.label}: wind/gust ${worst.speed} kt exceeds your ${ctx.minimums.maxSurfaceWindKt} kt limit`,
        isHardStop: true,
        sourceRecordIds: [worst.src],
      });
    }
    return ev(this, {
      result: "pass",
      measured: { maxWindOrGustKt: worst.speed },
      thresholds: { maxSurfaceWindKt: ctx.minimums.maxSurfaceWindKt },
      confidence: "high",
      explanation: `Surface winds within your ${ctx.minimums.maxSurfaceWindKt} kt limit`,
      isHardStop: false,
      sourceRecordIds: winds.map((w) => w.src),
    });
  },
};

const crosswindLimit: RuleDefinition = {
  id: "crosswind-limit",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    if (!isTerminal(ctx)) return null;
    const runways = ctx.runways.filter((r) => r.headingDeg !== null);
    const winds = ctx.observations
      .filter((o) => o.freshness !== "stale" && o.windDirDeg !== null && o.windSpeedKt !== null)
      .map((o) => ({
        dir: o.windDirDeg!, speed: Math.max(o.windSpeedKt!, o.windGustKt ?? 0),
        src: o.sourceRecordId, label: `METAR ${o.station}`,
      }));
    if (winds.length === 0) return null; // surface-wind rule covers the unknown path
    if (runways.length === 0) {
      return ev(this, {
        result: "not-applicable",
        measured: { note: "no runway data for crosswind computation" },
        thresholds: { maxCrosswindKt: ctx.minimums.maxCrosswindKt },
        confidence: "low",
        explanation: `Runway data unavailable for ${ctx.terminalAirports.join("/")} — crosswind not computed`,
        isHardStop: false,
        sourceRecordIds: [],
      });
    }
    // Best runway = smallest crosswind component for the strongest wind.
    const w = winds.sort((a, b) => b.speed - a.speed)[0]!;
    const best = runways
      .map((r) => {
        const angle = ((w.dir - r.headingDeg!) * Math.PI) / 180;
        return { runway: r, xwind: Math.abs(w.speed * Math.sin(angle)) };
      })
      .sort((a, b) => a.xwind - b.xwind)[0]!;
    const xwind = Math.round(best.xwind);
    if (xwind > ctx.minimums.maxCrosswindKt) {
      return ev(this, {
        result: "red",
        measured: { crosswindKt: xwind, bestRunway: best.runway.ident, wind: `${w.dir}/${w.speed}` },
        thresholds: { maxCrosswindKt: ctx.minimums.maxCrosswindKt },
        confidence: "high",
        explanation: `${w.label}: best-runway crosswind ${xwind} kt (rwy ${best.runway.ident}) exceeds your ${ctx.minimums.maxCrosswindKt} kt limit`,
        isHardStop: true,
        sourceRecordIds: [w.src],
      });
    }
    return ev(this, {
      result: "pass",
      measured: { crosswindKt: xwind, bestRunway: best.runway.ident },
      thresholds: { maxCrosswindKt: ctx.minimums.maxCrosswindKt },
      confidence: "high",
      explanation: `Crosswind ${xwind} kt on runway ${best.runway.ident} within your ${ctx.minimums.maxCrosswindKt} kt limit`,
      isHardStop: false,
      sourceRecordIds: [w.src],
    });
  },
};

const windsAloftLimit: RuleDefinition = {
  id: "winds-aloft-limit",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    const s = ctx.segment;
    if (s.windSource === "none") {
      return ev(this, {
        result: "unknown",
        measured: { windSource: "none" },
        thresholds: { maxWindsAloftKt: ctx.minimums.maxWindsAloftKt },
        confidence: "low",
        explanation: "Winds aloft unavailable for this segment (no FB station within 150 nm or window)",
        isHardStop: false,
        sourceRecordIds: [],
      });
    }
    const speed = s.windSpeedKt ?? 0;
    if (speed > ctx.minimums.maxWindsAloftKt) {
      return ev(this, {
        result: "red",
        measured: { windsAloftKt: speed, station: s.windStation, altitudeFt: s.altitudeFt },
        thresholds: { maxWindsAloftKt: ctx.minimums.maxWindsAloftKt },
        confidence: "medium",
        explanation: `Forecast winds aloft ${speed} kt (${s.windStation}, ${s.altitudeFt} ft) exceed your ${ctx.minimums.maxWindsAloftKt} kt limit`,
        isHardStop: true,
        sourceRecordIds: s.windSourceRecordId ? [s.windSourceRecordId] : [],
      });
    }
    return ev(this, {
      result: "pass",
      measured: { windsAloftKt: speed, station: s.windStation },
      thresholds: { maxWindsAloftKt: ctx.minimums.maxWindsAloftKt },
      confidence: "medium",
      explanation: `Winds aloft ${speed} kt within your ${ctx.minimums.maxWindsAloftKt} kt limit`,
      isHardStop: false,
      sourceRecordIds: s.windSourceRecordId ? [s.windSourceRecordId] : [],
    });
  },
};

const nightRestriction: RuleDefinition = {
  id: "night-restriction",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    if (ctx.minimums.nightOk) return null;
    const t = ctx.segment.time;
    if (t.entryDaylight === "night" || t.exitDaylight === "night") {
      return ev(this, {
        result: "red",
        measured: { entryDaylight: t.entryDaylight, exitDaylight: t.exitDaylight, exitLocal: t.exitLocal },
        thresholds: { nightOk: false },
        confidence: "high",
        explanation: `Segment is flown in darkness (${t.exitLocal}) and your minimums exclude night flight`,
        isHardStop: true,
        sourceRecordIds: [],
      });
    }
    return null;
  },
};

const dutyTimeLimit: RuleDefinition = {
  id: "duty-time-limit",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    const assumed = ctx.dutyStartUtc === null;
    const dutyStart = ctx.dutyStartUtc
      ? Date.parse(ctx.dutyStartUtc)
      : Date.parse(ctx.departureTimeUtc) - 60 * 60_000;
    const dutyMinAtExit = (Date.parse(ctx.segment.time.exitUtc) - dutyStart) / 60_000;
    if (dutyMinAtExit > ctx.minimums.maxDutyMin) {
      return ev(this, {
        result: "red",
        measured: { dutyMinAtExit: Math.round(dutyMinAtExit), dutyStartAssumed: assumed },
        thresholds: { maxDutyMin: ctx.minimums.maxDutyMin },
        confidence: assumed ? "medium" : "high",
        explanation: `Duty time reaches ${Math.round(dutyMinAtExit / 60 * 10) / 10} h here, over your ${Math.round(ctx.minimums.maxDutyMin / 60 * 10) / 10} h limit${assumed ? " (duty start assumed 1 h before departure)" : ""}`,
        isHardStop: true,
        sourceRecordIds: [],
      });
    }
    return null;
  },
};

const fuelReserve: RuleDefinition = {
  id: "fuel-reserve",
  version: 1,
  ruleClass: "hard-limit",
  safetyCritical: false,
  evaluate(ctx) {
    // Endurance vs (airborne since last fuel stop + flight remaining to the
    // next stop) must leave the pilot's reserve intact.
    const needed =
      ctx.segment.time.fuelUsedMinAtExit + ctx.segment.time.fuelAheadMin + ctx.minimums.fuelReserveMin;
    if (needed > ctx.aircraft.fuelEnduranceMin) {
      return ev(this, {
        result: "red",
        measured: {
          fuelUsedMinAtExit: Math.round(ctx.segment.time.fuelUsedMinAtExit),
          minutesToNextStop: Math.round(ctx.segment.time.fuelAheadMin),
        },
        thresholds: {
          fuelEnduranceMin: ctx.aircraft.fuelEnduranceMin,
          fuelReserveMin: ctx.minimums.fuelReserveMin,
        },
        confidence: "medium",
        explanation: `Reaching the next stop from here would leave less than your ${ctx.minimums.fuelReserveMin} min fuel reserve`,
        isHardStop: true,
        sourceRecordIds: [],
      });
    }
    return null;
  },
};

// --- Advisories ----------------------------------------------------------

const convectiveSigmet: RuleDefinition = {
  id: "convective-sigmet-intersect",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: true,
  evaluate(ctx) {
    if (!ctx.hazardFeedsOk) {
      return ev(this, {
        result: "unknown",
        measured: { hazardFeedsOk: false },
        thresholds: {},
        confidence: "low",
        explanation: "Convective SIGMET feed unavailable — convective status of this segment is unknown",
        isHardStop: false,
        sourceRecordIds: [],
      });
    }
    const hits = ctx.hazards.filter(
      (h) => h.product === "AIRSIGMET" && h.hazard === "CONVECTIVE",
    );
    if (hits.length === 0) return null;
    const h = hits.sort((a, b) => b.clipNm - a.clipNm)[0]!;
    return ev(this, {
      result: "red",
      measured: { clipNm: Math.round(h.clipNm), validTo: h.validTo, count: hits.length },
      thresholds: { policy: "no flight through active convective SIGMET areas" },
      confidence: "high",
      explanation: `Active Convective SIGMET (valid until ${h.validTo.slice(11, 16)}Z) overlaps this segment during your ETA${h.clipNm > 0 ? `, crossing ${Math.round(h.clipNm)} nm of your track` : ""}`,
      isHardStop: true,
      sourceRecordIds: hits.map((x) => x.sourceRecordId),
    });
  },
};

const sigmetIntersect: RuleDefinition = {
  id: "sigmet-intersect",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: true,
  evaluate(ctx) {
    if (!ctx.hazardFeedsOk) return null; // convective rule already reports the unknown
    const hits = ctx.hazards.filter(
      (h) => h.product === "AIRSIGMET" && (h.hazard === "TURB" || h.hazard === "ICE"),
    );
    if (hits.length === 0) return null;
    const h = hits[0]!;
    return ev(this, {
      result: "red",
      measured: { hazard: h.hazard, clipNm: Math.round(h.clipNm) },
      thresholds: { policy: "SIGMET-level turbulence/icing exceeds light-aircraft capability" },
      confidence: "high",
      explanation: `SIGMET for ${h.hazard === "TURB" ? "severe turbulence" : "severe icing"} intersects this segment during your ETA window`,
      isHardStop: true,
      sourceRecordIds: hits.map((x) => x.sourceRecordId),
    });
  },
};

const cwaIntersect: RuleDefinition = {
  id: "cwa-intersect",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    const hits = ctx.hazards.filter((h) => h.product === "CWA");
    if (hits.length === 0) return null;
    const convective = hits.some((h) => h.hazard === "CONVECTIVE");
    const h = hits[0]!;
    return ev(this, {
      result: convective ? "red" : "yellow",
      measured: { hazards: hits.map((x) => x.hazard), qualifier: h.qualifier },
      thresholds: { policy: "Center Weather Advisories flag near-term operational hazards" },
      confidence: "high",
      explanation: `Center Weather Advisory (${h.qualifier ?? h.hazard}) covers this segment during your ETA`,
      isHardStop: convective,
      sourceRecordIds: hits.map((x) => x.sourceRecordId),
    });
  },
};

const gairmetIntersect: RuleDefinition = {
  id: "gairmet-intersect",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    const hits = ctx.hazards.filter(
      (h) => h.product === "GAIRMET" && ["TURB", "ICE", "IFR", "MTN_OBSC"].includes(h.hazard),
    );
    if (hits.length === 0) return null;
    const kinds = [...new Set(hits.map((h) => h.hazard))];
    const label: Record<string, string> = {
      TURB: "moderate turbulence", ICE: "moderate icing",
      IFR: "IFR conditions", MTN_OBSC: "mountain obscuration",
    };
    return ev(this, {
      result: "yellow",
      measured: { hazards: kinds },
      thresholds: { policy: "G-AIRMET areas indicate widespread advisory-level hazards" },
      confidence: "medium",
      explanation: `G-AIRMET for ${kinds.map((k) => label[k] ?? k).join(", ")} covers this segment at your altitude and ETA`,
      isHardStop: false,
      sourceRecordIds: hits.map((x) => x.sourceRecordId),
    });
  },
};

const adverse = (p: { turbulence: { intensity: string }[]; icing: { intensity: string }[]; urgent: boolean }) =>
  p.urgent ||
  p.turbulence.some((t) => /MOD|SEV|EXTRM/.test(t.intensity)) ||
  p.icing.some((i) => /MOD|SEV/.test(i.intensity));

const pirepTurb: RuleDefinition = {
  id: "pirep-turb",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    const severe = ctx.pireps.filter((p) =>
      p.turbulence.some((t) => /SEV|EXTRM/.test(t.intensity)),
    );
    const moderate = ctx.pireps.filter((p) =>
      p.turbulence.some((t) => /MOD/.test(t.intensity) && !/SEV|EXTRM/.test(t.intensity)),
    );
    if (severe.length === 0 && moderate.length === 0) return null;
    const worst = (severe[0] ?? moderate[0])!;
    return ev(this, {
      result: severe.length > 0 ? "red" : "yellow",
      measured: {
        severeCount: severe.length, moderateCount: moderate.length,
        nearest: `${Math.round(worst.distanceNm)} nm, ${worst.ageMin} min ago, ${worst.aircraftType ?? "unknown type"}`,
      },
      thresholds: { relevance: "≤50 nm, ≤90 min, ±4,000 ft" },
      confidence: "medium",
      explanation:
        severe.length > 0
          ? `Severe turbulence reported ${Math.round(worst.distanceNm)} nm from your track ${worst.ageMin} min ago (${worst.aircraftType ?? "type unknown"})`
          : `Moderate turbulence reported near this segment (${moderate.length} report${moderate.length > 1 ? "s" : ""}, nearest ${Math.round(worst.distanceNm)} nm)`,
      isHardStop: severe.length > 0,
      sourceRecordIds: [...severe, ...moderate].map((p) => p.sourceRecordId),
    });
  },
};

const pirepCluster: RuleDefinition = {
  id: "pirep-cluster",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    const bad = ctx.pireps.filter(adverse);
    if (bad.length < 3) return null;
    return ev(this, {
      result: "yellow",
      measured: { adverseReports: bad.length },
      thresholds: { clusterThreshold: 3, window: "2 h, corridor" },
      confidence: "medium",
      explanation: `${bad.length} adverse pilot reports near this segment in the last two hours — conditions are actively being reported`,
      isHardStop: false,
      sourceRecordIds: bad.map((p) => p.sourceRecordId),
    });
  },
};

const tafConvectiveArrival: RuleDefinition = {
  id: "taf-convective-arrival",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    if (!isTerminal(ctx)) return null;
    const ts = ctx.forecastGroups.filter((f) => /TS/.test(f.wxString ?? ""));
    if (ts.length === 0) return null;
    const g = ts[0]!;
    return ev(this, {
      result: "yellow",
      measured: { group: `${g.station} ${g.groupType}${g.probability ? ` ${g.probability}%` : ""}`, wx: g.wxString },
      thresholds: { policy: "thunderstorms forecast during the arrival/departure window" },
      confidence: "medium",
      explanation: `${g.station} TAF forecasts thunderstorms (${g.wxString}) during your window — plan a decision gate with fuel to hold or divert`,
      isHardStop: false,
      sourceRecordIds: ts.map((x) => x.sourceRecordId),
    });
  },
};

const sourceConflict: RuleDefinition = {
  id: "source-conflict",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    const order = ["VFR", "MVFR", "IFR", "LIFR"];
    for (const o of ctx.observations) {
      if (o.freshness === "stale" || !o.flightCategory) continue;
      const f = ctx.forecastGroups.find((g) => g.station === o.station);
      if (!f) continue;
      const fCat =
        f.ceilingFtAgl !== null || f.visibilitySm !== null
          ? order[
              Math.max(
                f.ceilingFtAgl !== null ? (f.ceilingFtAgl < 500 ? 3 : f.ceilingFtAgl < 1000 ? 2 : f.ceilingFtAgl <= 3000 ? 1 : 0) : 0,
                f.visibilitySm !== null ? (f.visibilitySm < 1 ? 3 : f.visibilitySm < 3 ? 2 : f.visibilitySm <= 5 ? 1 : 0) : 0,
              )
            ]
          : null;
      if (!fCat) continue;
      const gap = order.indexOf(o.flightCategory) - order.indexOf(fCat);
      if (gap >= 2) {
        return ev(this, {
          result: "yellow",
          measured: { station: o.station, observed: o.flightCategory, forecast: fCat },
          thresholds: { conflictGap: 2 },
          confidence: "low",
          explanation: `${o.station} is observing ${o.flightCategory} while its TAF expected ${fCat} — sources disagree; trust is reduced`,
          isHardStop: false,
          sourceRecordIds: [o.sourceRecordId, f.sourceRecordId],
        });
      }
    }
    return null;
  },
};

const arrivalNearTwilight: RuleDefinition = {
  id: "arrival-after-twilight-advisory",
  version: 1,
  ruleClass: "advisory",
  safetyCritical: false,
  evaluate(ctx) {
    if (!ctx.isLast || !ctx.minimums.nightOk) return null;
    const d = ctx.segment.time.exitDaylight;
    if (d === "civil-twilight" || d === "night") {
      return ev(this, {
        result: "yellow",
        measured: { arrivalDaylight: d, arrivalLocal: ctx.segment.time.exitLocal },
        thresholds: { policy: "arrival at/after civil twilight erodes divert options" },
        confidence: "high",
        explanation: `Arrival at ${ctx.segment.time.exitLocal} is ${d === "night" ? "after dark" : "in fading twilight"} — any delay en route lands you in darker conditions`,
        isHardStop: false,
        sourceRecordIds: [],
      });
    }
    return null;
  },
};

export const RULES: RuleDefinition[] = [
  ceilingBelowMinimum,
  visibilityBelowMinimum,
  surfaceWindLimit,
  crosswindLimit,
  windsAloftLimit,
  nightRestriction,
  dutyTimeLimit,
  fuelReserve,
  convectiveSigmet,
  sigmetIntersect,
  cwaIntersect,
  gairmetIntersect,
  pirepTurb,
  pirepCluster,
  tafConvectiveArrival,
  sourceConflict,
  arrivalNearTwilight,
];
