# Putting the app on the internet (step-by-step)

This guide assumes **no technical background**. Follow it top to bottom the
first time; after that, updates deploy themselves whenever the code changes.

The app needs three things to run:

1. **A server** that runs the app itself.
2. **A database** that remembers briefings and accounts — it must be the
   "PostGIS" flavor, which adds the map math.
3. **A few secret keys** you paste in once (most are free).

There are two supported hosting setups — pick one:

- **Vercel + Neon** — run the app on Vercel (great if you already have an
  account) with a free Neon database. See **[the Vercel guide below](#deploying-on-vercel--neon)**.
- **Railway (all-in-one)** — app + database in one place, ~$5/month, no
  code changes. See **[the Railway guide](#deploying-on-railway)**.

Both need the same secret keys, collected in **Step 1** just below.

---

## Step 1 — Collect your keys

These are the same whichever host you pick. The **cookie secret (1c)** is
required; the Resend and Anthropic keys are optional and can be added later.

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
> **No key at all also works**: sign-in links are then printed into your
> host's logs (Vercel: project → *Logs*; Railway: app service → *Logs*), and
> you copy the link from there into your browser. Clunky but fine for a first
> test.

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

## Deploying on Vercel + Neon

You'll run the app on **Vercel** and its database on **Neon** — both have free
tiers. First collect your keys from **[Step 1](#step-1--collect-your-keys)**
(the cookie secret is required; the Resend and Anthropic keys are optional),
then come back here.

### V1 — Create the database (Neon)

1. Go to <https://neon.tech>, sign in (your GitHub login works), and click
   **New Project**. Pick a region near you and create it.
2. Open your project's **SQL Editor** (left sidebar), paste this line, and
   click Run — it switches on the map-math engine the app needs:

   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```

3. Click **Connect** (top of the dashboard) and copy the **Pooled**
   connection string — it's the one with `-pooler` in the address. Save it in
   a note; this is your `DATABASE_URL`.

### V2 — Put the app on Vercel

1. Go to <https://vercel.com>, click **Add New… → Project**, and import your
   `codynguyen18/aviation-weather` repo.
2. Before clicking Deploy, open **Environment Variables** and add these
   (Name on the left, Value on the right):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon **pooled** string from V1 |
   | `AUTH_SECRET` | the random secret from Step 1c |
   | `UPSTREAM_USER_AGENT` | `aviation-weather (your-email@example.com)` — your real email |
   | `RESEND_API_KEY` | your `re_...` key (optional — leave out for log-links) |
   | `EMAIL_FROM` | `onboarding@resend.dev` |
   | `ANTHROPIC_API_KEY` | your `sk-ant-...` key (optional) |

3. Click **Deploy**. The build automatically creates your database tables.
   When it goes green, Vercel shows your public address (like
   `your-app.vercel.app`). Open it.

   > If the very first build fails with a database error, it just means the
   > env vars weren't saved before it started — add them under
   > **Settings → Environment Variables**, then **Deployments → Redeploy**.

### V3 — Load the airport list (one time)

The app needs the worldwide airport database (~85,000 airports) loaded once.
There's a one-click loader built in:

1. On GitHub, open your repo → **Settings → Secrets and variables → Actions
   → New repository secret**. Name it `DATABASE_URL`, paste your Neon pooled
   string as the value, and save.
2. Go to the repo's **Actions** tab → **Load airport data** (left list) →
   **Run workflow**. It loads the airports into Neon (a couple of minutes).
   Re-run it every month or two whenever you want fresh airport data.

### V4 — First sign-in and a briefing

1. Open your Vercel address → **Sign in** → enter your email → click the link
   in the email. (No Resend key? The link is printed in Vercel under your
   project → **Logs** — copy it into your browser.)
2. **New flight plan** → enter a route (e.g. `KSTL` → `KOAK`), a departure
   time, your aircraft numbers, and your personal minimums → **Generate
   briefing**.

### Good to know on Vercel

- **Updates**: every push to your `main` branch redeploys automatically; your
  data lives in Neon and survives deploys.
- **Time limit**: Vercel's free plan caps each request at ~60 seconds. A
  briefing usually finishes well under that, but if a government weather
  server is slow, one might occasionally time out — just click Generate again.
- **Costs**: Vercel free tier, Neon free tier, weather APIs free; only the
  optional AI chat (Anthropic) costs a few cents per question.

---

## Deploying on Railway

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
