export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Aviation Weather Route Planner</h1>
      <p>
        Route-aware general-aviation weather decision support. This is the
        project skeleton (milestone M0) — flight planning features arrive in
        later milestones.
      </p>
      <p style={{ border: "1px solid #b45309", padding: "0.75rem", borderRadius: 6 }}>
        <strong>Advisory only.</strong> This application is not an official
        weather briefing and does not replace Flight Service, ForeFlight,
        Garmin Pilot, ATC, or pilot judgment. Weather data may be delayed,
        incomplete, or unavailable. The pilot in command retains final
        responsibility for every flight decision.
      </p>
    </main>
  );
}
