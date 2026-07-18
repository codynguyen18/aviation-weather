# Putting the app on the internet (step-by-step)

This guide assumes **no technical background**. Follow it top to bottom the
first time; after that, updates deploy themselves whenever the code changes.

The app needs three things to run:

1. **A server** that runs the app itself (we'll use Railway — roughly $5/month).
2. **A database** that remembers briefings and accounts (Railway provides this too; it must be the "PostGIS" flavor, which adds map math).
3. **Three secret keys** you paste in once (explained below — two are free).

---

## Step 1 — Collect your three keys

### 1a. Sign-in email key (free — Resend)

The app signs people in by emailing them a one-time link (no passwords).
Resend is the service that sends those emails.

1. Go to <https://resend.com> and create a free account **using your own email
   address** (the one you'll sign into the app with).
2. In the Resend dashboard, click **API Keys → Create API Key**, name it
   anything, and copy the key (it starts with `re_`). Save it in a note.

> The free plan can deliver sign-in links to **your own** email address
> without any further setup, which is exactly what a personal tool needs.
> If you later invite friends with other email addresses, Resend will ask you
> to verify a domain — that's a later problem, not a today problem.
>
> **No key at all also works**: sign-in links are then printed into the
> server's log (Railway → your app service → *Logs*), and you copy the link
> from there into your browser. Clunky but fine for a first test.

### 1b. AI chat key (paid per use — Anthropic)

This powers "Ask about this briefing". Everything else works without it, so
you can skip this and add it later.

1. Go to <https://console.anthropic.com> and create an account.
2. Add a small amount of credit under **Billing** ($5 goes a long way — a
   typical chat question costs a few cents).
3. Under **API Keys**, create a key (starts with `sk-ant-`) and save it in a
   note.

### 1c. Cookie secret (free — you generate it)

This is a random password the server uses to seal sign-in cookies. Generate
one at <https://generate-secret.vercel.app/32> (refresh for a new one) and
save it in a note. Anything long and random works.

---

## Step 2 — Create the app on Railway

1. Go to <https://railway.app> and sign in **with your GitHub account** (the
   one that owns this repository).
2. Click **New Project → Deploy from GitHub repo** and pick
   `codynguyen18/aviation-weather`. Railway detects it's a Next.js app.
3. Before it finishes, add the database: in the project canvas click
   **Create → Database → Postgres**. After it appears, open its settings and
   make sure the image is a **PostGIS** one — on Railway choose the
   **"PostGIS"** template/image variant (the app's map math requires it; a
   plain Postgres will fail its health check with "postgis missing").
4. Click your **app service → Variables** and add these (Name = left,
   Value = right):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | click "Add reference" and pick the Postgres service's `DATABASE_URL` |
   | `AUTH_SECRET` | the random secret from step 1c |
   | `RESEND_API_KEY` | the `re_...` key from step 1a (or leave out for log-links) |
   | `EMAIL_FROM` | `onboarding@resend.dev` |
   | `ANTHROPIC_API_KEY` | the `sk-ant-...` key from step 1b (optional) |
   | `UPSTREAM_USER_AGENT` | `aviation-weather (your-email@example.com)` — use your real email; the weather services ask for a contact |

5. Still in the app service, open **Settings → Deploy** and set the **Custom
   Start Command** to:

   ```
   npm run start:prod
   ```

   (That runs database setup automatically before every start.)
6. Click **Deploy**. When it goes green, Railway shows your public web
   address under **Settings → Networking → Generate Domain**. Open it.

---

## Step 3 — One-time: load the airport database

The app needs the worldwide airport/navaid list (about 85,000 airports) once.

1. In Railway, open your app service and find the **command/shell** feature
   (on Railway this is easiest via the CLI: install it from
   <https://docs.railway.app/guides/cli>, then `railway link` in the repo
   folder, then run):

   ```
   railway run npm run navdata:import
   ```

   It downloads the current OurAirports dataset and loads it (takes a couple
   of minutes). Re-run it every month or two if you want fresh airport data.

---

## Step 4 — First sign-in and a real briefing

1. Open your app's address → **Sign in** → enter your email.
2. Click the link in the email (or copy it from the app's log if you skipped
   the Resend key).
3. **New flight plan** → enter a route (e.g. `KSTL` → `KOAK`), departure
   time, aircraft numbers, and your personal minimums → **Generate briefing**.
4. On the briefing page, try **Ask about this briefing** (needs the Anthropic
   key) and click any citation chip to see the raw government product it came
   from.

---

## Alternative host: Render

Render works the same way if you prefer it: create a **PostgreSQL** instance
(Render's Postgres supports PostGIS out of the box), then a **Web Service**
from this repo with build command `npm install && npm run build`, start
command `npm run start:prod`, and the same environment variables as above.
Note Render's free database expires after 30 days; the $7/month plan doesn't.

## Things that are safe to know

- **Updates**: every push to the connected GitHub branch redeploys
  automatically. Your data lives in the database and survives deploys.
- **Costs**: Railway ~$5/month, Anthropic pay-per-question (cents), Resend
  free. The government weather APIs are free.
- **Backups**: Railway/Render both offer one-click database backups — turn
  them on in the database settings.
- **Rate limits**: each account can generate 10 briefings and send 60 chat
  messages per hour — protects both your wallet and the free weather APIs.
- **Deleting data**: the Account page has hard-delete buttons for saved items
  and for the whole account. Deletes are immediate and permanent.
