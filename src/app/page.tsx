import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "3rem auto", padding: "0 16px", display: "grid", gap: 16 }}>
      <h1>Aviation Weather Route Planner</h1>
      <p className="muted">
        Enter a route, departure time, aircraft performance, and your personal
        minimums. The app computes where you will be and when, gathers the
        official weather along the way, and grades every segment
        green / yellow / red — or honestly <b>unknown</b> when the data
        isn&apos;t there.
      </p>
      <p>
        <Link href="/plan">
          <button className="primary">Plan a flight →</button>
        </Link>
      </p>
      <div className="advisory-banner">
        <strong>Advisory only.</strong> This application is not an official
        weather briefing and does not replace Flight Service, ForeFlight,
        Garmin Pilot, ATC, or pilot judgment. Weather data may be delayed,
        incomplete, or unavailable. Datalink and internet weather are
        strategic tools, not tactical ones. The pilot in command retains
        final responsibility for every flight decision.
      </div>
    </main>
  );
}
