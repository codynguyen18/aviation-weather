import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata: Metadata = {
  title: "Aviation Weather Route Planner",
  description:
    "Route-aware general-aviation weather decision support. Advisory only — not an official weather briefing.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex", alignItems: "center", gap: 16, padding: "10px 18px",
            borderBottom: "1px solid var(--border)", background: "var(--panel)",
          }}
        >
          <Link href="/" style={{ fontWeight: 700, color: "var(--text)", textDecoration: "none" }}>
            ✈ Route Weather
          </Link>
          <Link href="/plan">New flight plan</Link>
          <Link href="/briefings">Briefing history</Link>
          <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
            Advisory only — not an official weather briefing. PIC retains final responsibility.
          </span>
        </header>
        {children}
      </body>
    </html>
  );
}
