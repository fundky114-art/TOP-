CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  clicked_at INTEGER NOT NULL,
  country TEXT,
  referer TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_clicked_at ON clicks(clicked_at);

CREATE TABLE IF NOT EXISTS hourly_reports (
  report_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  click_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT
);
