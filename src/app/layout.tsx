import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import { auth, signOut } from "@/auth";

import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata: Metadata = {
  title: "Aviation Weather Route Planner",
  description:
    "Route-aware general-aviation weather decision support. Advisory only — not an official weather briefing.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const user = session?.user ?? null;

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex", alignItems: "center", gap: 16, padding: "10px 18px",
            borderBottom: "1px solid var(--border)", background: "var(--panel)",
            flexWrap: "wrap",
          }}
        >
          <Link href="/" style={{ fontWeight: 700, color: "var(--text)", textDecoration: "none" }}>
            ✈ Route Weather
          </Link>
          {user && (
            <>
              <Link href="/plan">New flight plan</Link>
              <Link href="/briefings">Briefing history</Link>
              <Link href="/account">Account</Link>
            </>
          )}
          <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
            Advisory only — not an official weather briefing. PIC retains final responsibility.
          </span>
          {user ? (
            <form action={doSignOut} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="muted mono" style={{ fontSize: 12 }}>{user.email}</span>
              <button type="submit" style={{ fontSize: 12 }}>Sign out</button>
            </form>
          ) : (
            <Link href="/signin">Sign in</Link>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
