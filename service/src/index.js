// Diamond Lakes Skywarn — SPC Convective Outlook Email Alert Service
//
// Runs on Cloudflare Workers. On a cron schedule, fetches the SPC's public
// Day 1/2/3 categorical convective outlook GeoJSON, checks whether any of
// the five covered counties fall inside a risk polygon at or above the
// alert threshold, and emails every active subscriber when a new outlook
// issuance crosses that threshold.
//
// Endpoints:
//   POST /subscribe            { email: "you@example.com", consent: true }
//   GET  /unsubscribe?token=…  one-click unsubscribe link included in every email
//
// Scheduled: see wrangler.toml `[triggers] crons`.

const COUNTIES = [
  { name: "Garland", lon: -93.1275, lat: 34.5836 },
  { name: "Montgomery", lon: -93.65953, lat: 34.53879 },
  { name: "Hot Spring", lon: -92.95389, lat: 34.31861 },
  { name: "Pike", lon: -93.6575, lat: 34.16667 },
  { name: "Polk", lon: -94.24083, lat: 34.50194 },
];

// SPC categorical outlook risk levels, in ascending order of severity.
const RISK_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const LABEL_NAMES = {
  MRGL: "Marginal Risk",
  SLGT: "Slight Risk",
  ENH: "Enhanced Risk",
  MDT: "Moderate Risk",
  HIGH: "High Risk",
};
const ALERT_THRESHOLD = RISK_RANK.MRGL; // Marginal or worse, per DLAS request
const OUTLOOK_DAYS = [1, 2, 3];

// ---------------------------------------------------------------------------
// Geometry: standard ray-casting point-in-polygon test on a county centroid.
// ---------------------------------------------------------------------------

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") {
    return pointInRing(lon, lat, geometry.coordinates[0]);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly) => pointInRing(lon, lat, poly[0]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// SPC outlook fetch + county matching
// ---------------------------------------------------------------------------

async function fetchOutlook(day) {
  const url = `https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`;
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`SPC day${day} outlook fetch failed: ${res.status}`);
  return res.json();
}

// Returns { [countyName]: { day, label, rank, issue } } — the highest-rank
// hit per county across all three outlook days.
async function checkOutlooks() {
  const hits = {};

  for (const day of OUTLOOK_DAYS) {
    let geo;
    try {
      geo = await fetchOutlook(day);
    } catch (err) {
      console.error(err.message);
      continue;
    }

    for (const feature of geo.features || []) {
      const label = feature.properties && feature.properties.LABEL;
      const issue = feature.properties && feature.properties.ISSUE;
      const rank = RISK_RANK[label];
      if (!rank || rank < ALERT_THRESHOLD) continue;

      for (const county of COUNTIES) {
        if (!pointInGeometry(county.lon, county.lat, feature.geometry)) continue;
        const existing = hits[county.name];
        if (!existing || rank > existing.rank) {
          hits[county.name] = { day, label, rank, issue };
        }
      }
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Resend (email)
// ---------------------------------------------------------------------------

async function sendEmail(env, to, subject, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL, // e.g. "Diamond Lakes Skywarn <onboarding@resend.dev>"
      to: [to],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    console.error(`Resend send to ${to} failed: ${res.status} ${await res.text()}`);
  }
}

function unsubscribeUrl(env, token) {
  return `${env.SELF_URL}/unsubscribe?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Email validation + tokens
// ---------------------------------------------------------------------------

function normalizeEmail(raw) {
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase();
  // Simple, deliberately permissive RFC-5322-ish check — good enough to
  // reject obvious typos without rejecting valid-but-unusual addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function newToken() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Scheduled job
// ---------------------------------------------------------------------------

async function runOutlookCheck(env) {
  const hits = await checkOutlooks();
  const counties = Object.keys(hits);
  if (counties.length === 0) return;

  const newHits = [];
  for (const county of counties) {
    const info = hits[county];
    const already = await env.DB.prepare(
      "SELECT 1 FROM sent_alerts WHERE day_num = ? AND county = ? AND issue = ?"
    )
      .bind(info.day, county, info.issue || "")
      .first();

    if (already) continue;

    newHits.push({ county, ...info });
    await env.DB.prepare(
      "INSERT INTO sent_alerts (day_num, county, label, issue, sent_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(info.day, county, info.label, info.issue || "", new Date().toISOString())
      .run();
  }

  if (newHits.length === 0) return;

  // Highest-severity hit first, then by day.
  newHits.sort((a, b) => b.rank - a.rank || a.day - b.day);

  const highest = LABEL_NAMES[newHits[0].label] || newHits[0].label;
  const lines = newHits.map(
    (h) => `${h.county} County: Day ${h.day} outlook — ${LABEL_NAMES[h.label] || h.label}`
  );
  const bodyIntro =
    `The Storm Prediction Center has posted a ${highest} or higher for part of the ` +
    `Diamond Lakes coverage area:\n\n${lines.join("\n")}\n\n` +
    `Full outlook: https://www.spc.noaa.gov/products/outlook/\n` +
    `This is an automated notice, not an official NWS warning — always follow official NWS guidance.\n`;

  const subs = await env.DB.prepare(
    "SELECT email, unsubscribe_token FROM subscribers WHERE status = 'active'"
  ).all();

  for (const row of subs.results) {
    const body = `${bodyIntro}\nUnsubscribe: ${unsubscribeUrl(env, row.unsubscribe_token)}\n`;
    await sendEmail(env, row.email, `Diamond Lakes Skywarn: SPC ${highest} issued`, body);
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleSubscribe(request, env) {
  const headers = { ...corsHeaders(env), "Content-Type": "application/json" };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers,
    });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return new Response(JSON.stringify({ error: "Enter a valid email address." }), {
      status: 400,
      headers,
    });
  }
  if (!body.consent) {
    return new Response(
      JSON.stringify({ error: "Consent to receive alert emails is required." }),
      { status: 400, headers }
    );
  }

  try {
    const token = newToken();
    await env.DB.prepare(
      `INSERT INTO subscribers (email, unsubscribe_token, created_at, status)
       VALUES (?, ?, ?, 'active')
       ON CONFLICT(email) DO UPDATE SET status = 'active'`
    )
      .bind(email, token, new Date().toISOString())
      .run();

    // On a re-subscribe, keep the existing token rather than the fresh one
    // just generated, so old unsubscribe links already sent still work.
    const row = await env.DB.prepare(
      "SELECT unsubscribe_token FROM subscribers WHERE email = ?"
    )
      .bind(email)
      .first();
    const activeToken = (row && row.unsubscribe_token) || token;

    await sendEmail(
      env,
      email,
      "You're subscribed to Diamond Lakes Skywarn alerts",
      "You'll get an email whenever the Storm Prediction Center posts a " +
        "Marginal risk or higher on the Day 1-3 convective outlook for " +
        "Garland, Montgomery, Hot Spring, Pike, or Polk County, AR.\n\n" +
        "This is a volunteer service, not an official NWS product — " +
        "always follow official NWS warnings first.\n\n" +
        `Unsubscribe any time: ${unsubscribeUrl(env, activeToken)}\n`
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Server error, try again." }), {
      status: 500,
      headers,
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers });
}

async function handleUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  const html = (message) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>Diamond Lakes Skywarn</title>` +
        `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;">` +
        `<p>${message}</p></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );

  if (!token) return html("Missing unsubscribe token.");

  await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE unsubscribe_token = ?")
    .bind(token)
    .run();

  return html("You've been unsubscribed from Diamond Lakes Skywarn alerts.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }
    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      return handleUnsubscribe(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runOutlookCheck(env));
  },
};
