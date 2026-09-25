# Diamond Lakes Skywarn — Severe Weather Email Alert Service

Emails subscribers when the Storm Prediction Center issues a **Marginal
risk or higher** (MRGL/SLGT/ENH/MDT/HIGH) on the Day 1, 2, or 3 convective
outlook covering Garland, Montgomery, Hot Spring, Pike, or Polk County, AR.

Runs as a [Cloudflare Worker](https://workers.cloudflare.com/) — free tier
covers this easily (cron trigger + D1 database). Email sending is via
[Resend](https://resend.com), also free at this scale: 3,000 emails/month,
100/day, no credit card required. **Total cost: $0/month.**

## One-time setup

### 1. Cloudflare (free)

1. Create a free account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Install Node.js if you don't have it ([nodejs.org](https://nodejs.org)), then in this
   `service/` folder run:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
   This opens a browser window to authorize the CLI against your Cloudflare account.
3. Create the database:
   ```bash
   wrangler d1 create dlas-alerts
   ```
   It prints a `database_id` — paste it into `wrangler.toml` in place of
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
4. Load the schema:
   ```bash
   wrangler d1 execute dlas-alerts --file=schema.sql
   ```

### 2. Resend (free)

1. Sign up at [resend.com](https://resend.com) — no credit card needed for
   the free tier.
2. Console → API Keys → Create API Key. Copy it (you'll paste it once,
   below — Resend won't show it again).
3. That's it to get started. Emails will send from
   `onboarding@resend.dev`, which works immediately and can go to any
   recipient, though it's meant for getting started rather than long-term
   use — some inboxes are more likely to flag it as spam than a real
   domain would.
   **Optional, later:** if DLAS or Arkansas AUXCOMM ever gets a domain (or
   already controls one, e.g. a subdomain of `arkansasauxcomm.org`), verify
   it under Console → Domains and switch `FROM_EMAIL` in `wrangler.toml` to
   `Diamond Lakes Skywarn <alerts@your-domain>` — no added cost, just
   better deliverability.

### 3. Wire the secret into the Worker

From the `service/` folder:
```bash
wrangler secret put RESEND_API_KEY
```
(Paste the key from step 2 when prompted. Secrets never get written to a
file, so this is safe to run even in this shared repo.)

### 4. Deploy

```bash
wrangler deploy
```
This prints your Worker's URL, something like:
```
https://dlas-severe-alerts.<your-subdomain>.workers.dev
```
Copy that URL into `wrangler.toml`'s `SELF_URL` (replacing the
`REPLACE.workers.dev` placeholder) and run `wrangler deploy` once more so
unsubscribe links in emails point to the right place.

### 5. Connect the frontend

Open `../index.html`, find `DLAS_ALERT_API` near the bottom of the file,
and replace the placeholder with the URL from step 4. Commit and push —
the signup form on the live site will now call your deployed Worker.

## How it decides when to send

Every 30 minutes, the Worker fetches SPC's public Day 1/2/3 categorical
outlook GeoJSON and tests each county's centroid against every risk
polygon. The first time a county crosses into Marginal-or-higher for a
given outlook issuance, everyone on the active subscriber list gets one
email; the `sent_alerts` table prevents re-sending for outlooks that
haven't changed since the last check.

## Unsubscribing

Every email includes a one-click unsubscribe link
(`/unsubscribe?token=…`) tied to that subscriber's own token — no login
required, satisfying CAN-SPAM's working-unsubscribe requirement.

## Local testing

```bash
wrangler dev
```
Runs the Worker locally; `wrangler tail` after deploying shows live logs,
useful for confirming the cron job is firing and matching correctly.
