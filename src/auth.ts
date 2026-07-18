import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { db, sql } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/auth-schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/account/store";

// Auth.js v5 (PLAN.md §17): passwordless email magic links, JWT session
// cookies (httpOnly, SameSite=Lax by default). With RESEND_API_KEY set the
// link is emailed; without it the link is printed to the server log so the
// app is usable before any email provider is configured.

async function sendMagicLink(params: { identifier: string; url: string }) {
  const key = env().RESEND_API_KEY;
  if (!key) {
    logger.warn(
      { email: params.identifier, signInUrl: params.url },
      "RESEND_API_KEY not set — copy this sign-in link from the log into your browser",
    );
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env().EMAIL_FROM,
      to: params.identifier,
      subject: "Your Route Weather sign-in link",
      text: `Sign in to Route Weather:\n\n${params.url}\n\nThis link expires in 24 hours. If you didn't request it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`email delivery failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  secret: env().AUTH_SECRET ?? "dev-only-secret-change-me",
  trustHost: true,
  pages: { signIn: "/signin", verifyRequest: "/signin?sent=1" },
  providers: [
    Resend({
      from: env().EMAIL_FROM,
      apiKey: env().RESEND_API_KEY ?? "unset",
      sendVerificationRequest: (params) =>
        sendMagicLink({ identifier: params.identifier, url: params.url }),
    }),
  ],
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      await audit(sql, user.id ?? null, "auth.signin", { email: user.email });
    },
  },
});
