"use client";

import { useCallback, useEffect, useState } from "react";

// Saved data + deletion flows: aircraft profiles, minimums profiles, flight
// plans, and full account deletion. All deletes are hard deletes.

interface Row { id: string; name: string; created_at: string }

function useList(url: string, key: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(() => {
    fetch(url)
      .then((r) => (r.ok ? r.json() : { [key]: [] }))
      .then((d) => setRows(d[key] ?? []))
      .catch(() => {});
  }, [url, key]);
  useEffect(load, [load]);
  return { rows, load };
}

function Section(props: {
  title: string;
  hint: string;
  url: string;
  listKey: string;
}) {
  const { rows, load } = useList(props.url, props.listKey);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="panel" style={{ display: "grid", gap: 8 }}>
      <h3>{props.title}</h3>
      {rows.length === 0 && <span className="muted" style={{ fontSize: 13 }}>{props.hint}</span>}
      {rows.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <b>{r.name}</b>
          <span className="muted mono" style={{ fontSize: 11.5 }}>
            saved {new Date(r.created_at).toISOString().slice(0, 10)}
          </span>
          <button
            style={{ marginLeft: "auto", fontSize: 12 }}
            disabled={busy === r.id}
            onClick={async () => {
              if (!confirm(`Delete "${r.name}"? This cannot be undone.`)) return;
              setBusy(r.id);
              await fetch(`${props.url}?id=${r.id}`, { method: "DELETE" }).catch(() => {});
              setBusy(null);
              load();
            }}
          >
            delete
          </button>
        </div>
      ))}
    </section>
  );
}

export default function AccountManager(props: { email: string }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  return (
    <main style={{ maxWidth: 720, margin: "1.5rem auto", padding: "0 16px", display: "grid", gap: 14 }}>
      <h1>Account</h1>
      <div className="muted">Signed in as <b className="mono">{props.email}</b></div>

      <Section
        title="Aircraft profiles"
        hint="No saved aircraft yet — save one from the flight plan form."
        url="/api/profiles/aircraft"
        listKey="profiles"
      />
      <Section
        title="Personal minimums profiles"
        hint="No saved minimums yet — save them from the flight plan form."
        url="/api/profiles/minimums"
        listKey="profiles"
      />
      <Section
        title="Saved flight plans"
        hint="No saved plans yet — save one from the flight plan form."
        url="/api/plans"
        listKey="plans"
      />

      <section className="panel" style={{ display: "grid", gap: 8, borderColor: "var(--red)" }}>
        <h3>Delete account</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          Permanently deletes your account and everything in it: saved aircraft,
          minimums, flight plans, briefing history, and chat conversations.
          There is no undo. Type <b className="mono">delete</b> to confirm.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="type: delete"
            style={{ width: 140 }}
          />
          <button
            disabled={confirmText !== "delete" || deleting}
            onClick={async () => {
              setDeleting(true);
              const res = await fetch("/api/account", { method: "DELETE" }).catch(() => null);
              if (res?.ok) window.location.href = "/api/auth/signout";
              else setDeleting(false);
            }}
          >
            {deleting ? "Deleting…" : "Delete my account & all data"}
          </button>
        </div>
      </section>
    </main>
  );
}
