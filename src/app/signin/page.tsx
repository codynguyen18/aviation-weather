import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

// Passwordless sign-in (PLAN.md §17): enter an email, get a one-time link.
// Without an email provider configured, the link lands in the server log.
export default async function SignInPage(props: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/plan");
  const { sent } = await props.searchParams;
  const emailConfigured = Boolean(env().RESEND_API_KEY);

  async function send(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    if (!email) return;
    await signIn("resend", { email, redirectTo: "/plan" });
  }

  return (
    <main style={{ maxWidth: 460, margin: "4rem auto", padding: "0 16px", display: "grid", gap: 14 }}>
      <h1>Sign in</h1>
      {sent ? (
        <div className="panel" style={{ display: "grid", gap: 8 }}>
          <b>Check your email.</b>
          <span className="muted">
            We sent you a one-time sign-in link. It expires in 24 hours.
            {!emailConfigured && (
              <>
                {" "}(Email isn&apos;t configured on this server, so the link was
                printed to the <b>server log</b> instead — open the log and paste
                the link into your browser.)
              </>
            )}
          </span>
        </div>
      ) : (
        <form action={send} className="panel" style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 4 }}>
            Email address
            <input name="email" type="email" required placeholder="you@example.com" autoComplete="email" />
          </label>
          <button className="primary" type="submit">Email me a sign-in link</button>
          <span className="muted" style={{ fontSize: 12 }}>
            No password needed — we email you a one-time link. Your account keeps
            your saved aircraft, minimums, flight plans, and briefing history.
          </span>
        </form>
      )}
    </main>
  );
}
