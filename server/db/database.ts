import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EvidenceObservation, Recipient, SuggestedGroup } from '../../shared/types.ts';

export interface CampaignRecord {
  id: string;
  sessionId: string;
  status: string;
  inputCsv: string;
  inputHash: string;
  chain: string;
  budgetMinor: bigint;
  unitLabel: string;
  precision: number;
  duplicatePolicy: string | null;
  cutoffStart: string;
  cutoffEnd: string;
  analysisVersion: string;
  createdAt: string;
}

let database: DatabaseSync | undefined;

function now(): string {
  return new Date().toISOString();
}

function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? './data/fairdrop.sqlite');
}

export function db(): DatabaseSync {
  if (!database) {
    const path = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path);
    database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    database.exec('PRAGMA journal_mode = WAL;');
  }
  return database;
}

export function ensureSession(sessionId: string): void {
  db().prepare('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)').run(sessionId, now());
}

export function createCampaign(input: {
  sessionId: string;
  inputCsv: string;
  inputHash: string;
  budgetMinor: bigint;
  unitLabel: string;
  precision: number;
  cutoffStart: string;
  cutoffEnd: string;
}): string {
  ensureSession(input.sessionId);
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO campaigns
    (id, session_id, input_csv, input_hash, chain, budget_minor, unit_label, precision, cutoff_start, cutoff_end, analysis_version, created_at)
    VALUES (?, ?, ?, ?, 'base', ?, ?, ?, ?, ?, 'analysis-v1', ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.inputCsv,
      input.inputHash,
      input.budgetMinor.toString(),
      input.unitLabel,
      input.precision,
      input.cutoffStart,
      input.cutoffEnd,
      now(),
    );
  return id;
}

export function setDuplicatePolicy(campaignId: string, policy: 'keep-first' | 'sum-weights'): void {
  db().prepare('UPDATE campaigns SET duplicate_policy = ?, status = ? WHERE id = ?').run(policy, 'ready', campaignId);
}

export function saveRecipients(campaignId: string, recipients: Recipient[]): Recipient[] {
  const existing = getRecipients(campaignId);
  if (existing.length > 0) return existing;
  const statement = db().prepare(`INSERT INTO recipients
    (id, campaign_id, source_row, chain, address, normalized_address, weight_units, weight_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const persisted = recipients.map((recipient) => ({ ...recipient, id: `${campaignId}:${recipient.id}` }));
  for (const recipient of persisted) {
    statement.run(
      recipient.id,
      campaignId,
      recipient.sourceRow,
      recipient.chain,
      recipient.address,
      recipient.normalizedAddress,
      recipient.weightUnits.toString(),
      recipient.weightText,
    );
  }
  return persisted;
}

function recipientFromRow(row: Record<string, unknown>): Recipient {
  return {
    id: String(row.id),
    sourceRow: Number(row.source_row),
    chain: 'base',
    address: String(row.address),
    normalizedAddress: String(row.normalized_address),
    weightUnits: BigInt(String(row.weight_units)),
    weightText: String(row.weight_text),
  };
}

export function getCampaign(campaignId: string, sessionId?: string): CampaignRecord | undefined {
  const row = (
    sessionId
      ? db().prepare('SELECT * FROM campaigns WHERE id = ? AND session_id = ?').get(campaignId, sessionId)
      : db().prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId)
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    status: String(row.status),
    inputCsv: String(row.input_csv),
    inputHash: String(row.input_hash),
    chain: String(row.chain),
    budgetMinor: BigInt(String(row.budget_minor)),
    unitLabel: String(row.unit_label),
    precision: Number(row.precision),
    duplicatePolicy: row.duplicate_policy === null ? null : String(row.duplicate_policy),
    cutoffStart: String(row.cutoff_start),
    cutoffEnd: String(row.cutoff_end),
    analysisVersion: String(row.analysis_version),
    createdAt: String(row.created_at),
  };
}

export function getRecipients(campaignId: string): Recipient[] {
  const rows = db()
    .prepare('SELECT * FROM recipients WHERE campaign_id = ? ORDER BY source_row')
    .all(campaignId) as Record<string, unknown>[];
  return rows.map(recipientFromRow);
}

export function setCampaignStatus(campaignId: string, status: string): void {
  db().prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, campaignId);
}

export function saveObservations(campaignId: string, observations: EvidenceObservation[]): void {
  const statement = db().prepare(
    'INSERT OR REPLACE INTO observations (id, campaign_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const observation of observations) statement.run(observation.id, campaignId, JSON.stringify(observation), now());
}

export function recordApiCall(input: {
  campaignId: string;
  endpoint: string;
  purpose: string;
  status: number;
  requestId?: string;
  creditsUsed?: number;
  cacheHit?: boolean;
  validData?: boolean;
}): void {
  db()
    .prepare(
      `INSERT INTO api_calls
    (id, campaign_id, endpoint, purpose, status, request_id, credits_used, cache_hit, valid_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.campaignId,
      input.endpoint,
      input.purpose,
      input.status,
      input.requestId ?? null,
      input.creditsUsed ?? 0,
      input.cacheHit ? 1 : 0,
      input.validData ? 1 : 0,
      now(),
    );
}

export function getObservations(campaignId: string): EvidenceObservation[] {
  const rows = db()
    .prepare('SELECT payload_json FROM observations WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json) as EvidenceObservation);
}

export function createAnalysisJob(campaignId: string, total: number): string {
  const id = randomUUID();
  const timestamp = now();
  db()
    .prepare(
      `INSERT INTO analysis_jobs (id, campaign_id, status, stage, completed, total, coverage_json, created_at, updated_at)
    VALUES (?, ?, 'pending', 'queued', 0, ?, '{}', ?, ?)`,
    )
    .run(id, campaignId, total, timestamp, timestamp);
  return id;
}

export function updateAnalysisJob(
  jobId: string,
  input: { status: string; stage: string; completed: number; total: number; coverage: unknown; error?: string },
): void {
  db()
    .prepare(
      'UPDATE analysis_jobs SET status = ?, stage = ?, completed = ?, total = ?, coverage_json = ?, error = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      input.status,
      input.stage,
      input.completed,
      input.total,
      JSON.stringify(input.coverage),
      input.error ?? null,
      now(),
      jobId,
    );
}

export function getAnalysisJob(jobId: string, sessionId?: string): Record<string, unknown> | undefined {
  const row = (
    sessionId
      ? db()
          .prepare(
            'SELECT analysis_jobs.* FROM analysis_jobs JOIN campaigns ON campaigns.id = analysis_jobs.campaign_id WHERE analysis_jobs.id = ? AND campaigns.session_id = ?',
          )
          .get(jobId, sessionId)
      : db().prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId)
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { ...row, coverage: JSON.parse(String(row.coverage_json)) };
}

export function saveSuggestedGroups(campaignId: string, groups: SuggestedGroup[]): void {
  const statement = db().prepare(`INSERT OR REPLACE INTO suggested_groups
    (id, campaign_id, recipient_ids_json, edge_ids_json, state, score, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const group of groups)
    statement.run(
      group.id,
      campaignId,
      JSON.stringify(group.recipientIds),
      JSON.stringify(group.edgeIds),
      group.state,
      group.score,
      group.reason,
      now(),
    );
}

export function getSuggestedGroups(campaignId: string): SuggestedGroup[] {
  const rows = db()
    .prepare('SELECT * FROM suggested_groups WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    recipientIds: JSON.parse(String(row.recipient_ids_json)) as string[],
    edgeIds: JSON.parse(String(row.edge_ids_json)) as string[],
    state: String(row.state) as SuggestedGroup['state'],
    score: Number(row.score),
    reason: String(row.reason),
  }));
}

export function updateSuggestedGroup(campaignId: string, groupId: string, state: SuggestedGroup['state']): void {
  db()
    .prepare('UPDATE suggested_groups SET state = ?, updated_at = ? WHERE id = ? AND campaign_id = ?')
    .run(state, now(), groupId, campaignId);
}

export function addReviewEvent(input: {
  campaignId: string;
  sessionId: string;
  groupId: string;
  action: string;
  reason: string;
  evidenceVersion: string;
}): void {
  db()
    .prepare(
      `INSERT INTO review_events (id, campaign_id, group_id, session_id, action, reason, evidence_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.campaignId,
      input.groupId,
      input.sessionId,
      input.action,
      input.reason,
      input.evidenceVersion,
      now(),
    );
}

export function acceptedGroups(campaignId: string): Array<{ id: string; recipientIds: string[] }> {
  return getSuggestedGroups(campaignId)
    .filter((group) => group.state === 'accepted_for_policy')
    .map((group) => ({ id: group.id, recipientIds: group.recipientIds }));
}

export function saveAllocation(input: {
  campaignId: string;
  policy: unknown;
  budgetMinor: bigint;
  reserveMinor: bigint;
  redistributedMinor: bigint;
  algorithmVersion: string;
  inputHash: string;
  rows: Array<{
    recipientId: string;
    baselineMinor: bigint;
    adjustedMinor: bigint;
    deltaMinor: bigint;
    groupId: string;
    reason: string;
  }>;
}): string {
  const policyVersionId = randomUUID();
  const runId = randomUUID();
  const timestamp = now();
  db()
    .prepare('INSERT INTO policy_versions (id, campaign_id, policy_json, created_at) VALUES (?, ?, ?, ?)')
    .run(
      policyVersionId,
      input.campaignId,
      JSON.stringify(input.policy, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
      timestamp,
    );
  db()
    .prepare(
      `INSERT INTO allocation_runs (id, campaign_id, policy_version_id, budget_minor, reserve_minor, redistributed_minor, algorithm_version, input_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      input.campaignId,
      policyVersionId,
      input.budgetMinor.toString(),
      input.reserveMinor.toString(),
      input.redistributedMinor.toString(),
      input.algorithmVersion,
      input.inputHash,
      timestamp,
    );
  const rowStatement = db()
    .prepare(`INSERT INTO allocation_rows (id, allocation_run_id, recipient_id, baseline_minor, adjusted_minor, delta_minor, group_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of input.rows)
    rowStatement.run(
      randomUUID(),
      runId,
      row.recipientId,
      row.baselineMinor.toString(),
      row.adjustedMinor.toString(),
      row.deltaMinor.toString(),
      row.groupId,
      row.reason,
    );
  return runId;
}

export function getLatestAllocation(
  campaignId: string,
): { run: Record<string, unknown>; rows: Record<string, unknown>[] } | undefined {
  const run = db()
    .prepare(
      `SELECT allocation_runs.*, policy_versions.policy_json
    FROM allocation_runs JOIN policy_versions ON policy_versions.id = allocation_runs.policy_version_id
    WHERE allocation_runs.campaign_id = ? ORDER BY allocation_runs.created_at DESC LIMIT 1`,
    )
    .get(campaignId) as Record<string, unknown> | undefined;
  if (!run) return undefined;
  const rows = db().prepare('SELECT * FROM allocation_rows WHERE allocation_run_id = ?').all(String(run.id)) as Record<
    string,
    unknown
  >[];
  return { run, rows };
}

export function getAllocationRun(
  runId: string,
  sessionId?: string,
): { run: Record<string, unknown>; rows: Record<string, unknown>[] } | undefined {
  const run = (
    sessionId
      ? db()
          .prepare(
            `SELECT allocation_runs.*, policy_versions.policy_json
      FROM allocation_runs JOIN policy_versions ON policy_versions.id = allocation_runs.policy_version_id
      JOIN campaigns ON campaigns.id = allocation_runs.campaign_id
      WHERE allocation_runs.id = ? AND campaigns.session_id = ?`,
          )
          .get(runId, sessionId)
      : db()
          .prepare(
            `SELECT allocation_runs.*, policy_versions.policy_json
      FROM allocation_runs JOIN policy_versions ON policy_versions.id = allocation_runs.policy_version_id
      WHERE allocation_runs.id = ?`,
          )
          .get(runId)
  ) as Record<string, unknown> | undefined;
  if (!run) return undefined;
  const rows = db().prepare('SELECT * FROM allocation_rows WHERE allocation_run_id = ?').all(runId) as Record<
    string,
    unknown
  >[];
  return { run, rows };
}

export function getCampaignByAllocationRun(runId: string, sessionId: string): CampaignRecord | undefined {
  const row = db()
    .prepare(
      'SELECT campaigns.* FROM campaigns JOIN allocation_runs ON allocation_runs.campaign_id = campaigns.id WHERE allocation_runs.id = ? AND campaigns.session_id = ?',
    )
    .get(runId, sessionId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    status: String(row.status),
    inputCsv: String(row.input_csv),
    inputHash: String(row.input_hash),
    chain: String(row.chain),
    budgetMinor: BigInt(String(row.budget_minor)),
    unitLabel: String(row.unit_label),
    precision: Number(row.precision),
    duplicatePolicy: row.duplicate_policy === null ? null : String(row.duplicate_policy),
    cutoffStart: String(row.cutoff_start),
    cutoffEnd: String(row.cutoff_end),
    analysisVersion: String(row.analysis_version),
    createdAt: String(row.created_at),
  };
}

export function apiUsage(): Record<string, unknown>[] {
  return db()
    .prepare(
      'SELECT campaign_id, endpoint, purpose, status, request_id, credits_used, cache_hit, valid_data, created_at FROM api_calls ORDER BY created_at',
    )
    .all() as Record<string, unknown>[];
}

export function deleteCampaign(campaignId: string, sessionId: string): boolean {
  const result = db().prepare('DELETE FROM campaigns WHERE id = ? AND session_id = ?').run(campaignId, sessionId);
  return Number(result.changes) === 1;
}
