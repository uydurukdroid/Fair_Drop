PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  input_csv TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  chain TEXT NOT NULL,
  budget_minor TEXT NOT NULL,
  unit_label TEXT NOT NULL,
  precision INTEGER NOT NULL,
  duplicate_policy TEXT,
  cutoff_start TEXT NOT NULL,
  cutoff_end TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  source_row INTEGER NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  weight_units TEXT NOT NULL,
  weight_text TEXT NOT NULL,
  UNIQUE(campaign_id, chain, normalized_address)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  coverage_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status INTEGER NOT NULL,
  request_id TEXT,
  credits_used INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  valid_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS infrastructure_reviews (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  reviewer_notes TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggested_groups (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_ids_json TEXT NOT NULL,
  edge_ids_json TEXT NOT NULL,
  state TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocation_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  budget_minor TEXT NOT NULL,
  reserve_minor TEXT NOT NULL,
  redistributed_minor TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocation_rows (
  id TEXT PRIMARY KEY,
  allocation_run_id TEXT NOT NULL REFERENCES allocation_runs(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  baseline_minor TEXT NOT NULL,
  adjusted_minor TEXT NOT NULL,
  delta_minor TEXT NOT NULL,
  group_id TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  allocation_run_id TEXT NOT NULL REFERENCES allocation_runs(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
