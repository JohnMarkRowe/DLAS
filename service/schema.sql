-- Diamond Lakes Skywarn email alert service — D1 schema
-- Run once with: wrangler d1 execute dlas-alerts --file=schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  unsubscribe_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'unsubscribed'
);

-- Tracks which SPC outlook issuances have already triggered an email, so a
-- cron run every 30 minutes doesn't re-send for an outlook that hasn't
-- changed since the last check.
CREATE TABLE IF NOT EXISTS sent_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_num INTEGER NOT NULL,   -- 1, 2, or 3 (SPC outlook day)
  county TEXT NOT NULL,
  label TEXT NOT NULL,        -- MRGL | SLGT | ENH | MDT | HIGH
  issue TEXT NOT NULL,        -- SPC's ISSUE timestamp for this outlook version
  sent_at TEXT NOT NULL,
  UNIQUE (day_num, county, issue)
);
