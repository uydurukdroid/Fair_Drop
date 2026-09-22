import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { validateImport, resolveDuplicates } from './domain/import.ts';
import { parseDisplayMinorUnits, parseMinorUnits } from '../shared/decimal.ts';
import { deriveEvidence } from './domain/evidence/rules.ts';
import { defaultInfrastructureRegistry, registryAddresses } from './domain/evidence/registry.ts';
import { calculateAllocation, allocationInvariant } from './domain/allocation/allocator.ts';
import { allocationCsv, allocationManifest, jsonWithBigInts } from './export/serialize.ts';
import {
  analysisRecipientLimit,
  configuredAnalysisMode,
  enqueueAnalysis,
  type AnalysisMode,
} from './jobs/enrichment.ts';
import type { AllocationReviewDecision } from '../shared/types.ts';
import {
  acceptedGroups,
  addReviewEvent,
  createAnalysisJob,
  createCampaign,
  db,
  deleteCampaign,
  getAnalysisJob,
  getCampaign,
  getCampaignByAllocationRun,
  getAllocationRun,
  getLatestAllocation,
  getObservations,
  getRecipients,
  getSuggestedGroups,
  saveAllocation,
  saveRecipients,
  setCampaignStatus,
  setDuplicatePolicy,
  updateSuggestedGroup,
} from './db/database.ts';

const appPort = Number(process.env.APP_PORT ?? 8313);
const apiPort = Number(process.env.API_PORT ?? 8413);
const appOrigin = `http://127.0.0.1:${Number.isInteger(appPort) && appPort > 0 ? appPort : 8313}`;
const defaultBudgetMinor = (
  process.env.DEFAULT_REWARD_BUDGET?.trim()
    ? parseDisplayMinorUnits(process.env.DEFAULT_REWARD_BUDGET)
    : parseMinorUnits('10000000000')
).toString();
const configuredUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 10_000_000);
const apiBodyLimit =
  Number.isInteger(configuredUploadBytes) && configuredUploadBytes > 0 ? configuredUploadBytes + 256_000 : 10_256_000;
const app = Fastify({ logger: true, bodyLimit: apiBodyLimit });
const distRoot = resolve('dist');

type SessionRequest = { headers: Record<string, string | string[] | undefined> };
type ImportBody = { csv?: string; budgetMinor?: string | number; unitLabel?: string; precision?: number };

function sessionId(request: SessionRequest, reply: { header: (name: string, value: string) => void }): string {
  const raw = request.headers['x-fairdrop-session'];
  const existing = Array.isArray(raw) ? raw[0] : raw;
  const value = existing?.trim() || randomUUID();
  reply.header('x-fairdrop-session', value);
  return value;
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(jsonWithBigInts(value));
}

app.addHook('onRequest', async (_request, reply) => {
  reply.header('access-control-allow-origin', appOrigin);
  reply.header('access-control-allow-headers', 'content-type,x-fairdrop-session');
  reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
});

if (existsSync(distRoot)) {
  app.register(fastifyStatic, { root: distRoot, wildcard: false });
}

app.options('*', async (_request, reply) => reply.code(204).send());

app.get('/healthz', async () => ({
  ok: true,
  product: 'fairdrop',
  dataMode: configuredAnalysisMode(),
  defaultBudgetMinor,
}));

app.post<{ Body: ImportBody }>('/api/campaigns/import', async (request, reply) => {
  const owner = sessionId(request, reply);
  const body = request.body ?? {};
  if (!body.csv) return reply.code(400).send({ error: 'csv is required' });
  let preview;
  try {
    preview = validateImport(body.csv);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid CSV' });
  }
  if (preview.issues.length > 0) return reply.code(422).send(jsonValue({ error: 'CSV validation failed', preview }));
  let budgetMinor: bigint;
  try {
    budgetMinor = parseMinorUnits(body.budgetMinor ?? defaultBudgetMinor);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid budget' });
  }
  const now = Date.now();
  const campaignId = createCampaign({
    sessionId: owner,
    inputCsv: body.csv,
    inputHash: preview.inputHash,
    budgetMinor,
    unitLabel: body.unitLabel?.trim() || 'USDC units',
    precision: body.precision ?? 6,
    cutoffStart: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
    cutoffEnd: new Date(now).toISOString(),
  });
  return reply.send(
    jsonValue({
      id: campaignId,
      budgetMinor: budgetMinor.toString(),
      unitLabel: body.unitLabel?.trim() || 'USDC units',
      precision: body.precision ?? 6,
      needsDuplicateDecision: preview.duplicates.length > 0,
      preview,
      message: 'Import preview created. Confirm the duplicate policy before analysis.',
    }),
  );
});

app.post<{ Params: { id: string }; Body: { duplicatePolicy?: 'keep-first' | 'sum-weights' } }>(
  '/api/campaigns/:id/confirm-import',
  async (request, reply) => {
    const owner = sessionId(request, reply);
    const campaign = getCampaign(request.params.id, owner);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    let preview;
    try {
      preview = validateImport(campaign.inputCsv);
      if (preview.duplicates.length > 0 && !request.body?.duplicatePolicy)
        return reply.code(400).send({ error: 'Choose keep-first or sum-weights explicitly' });
      const policy = request.body?.duplicatePolicy ?? 'keep-first';
      const existingRecipients = getRecipients(request.params.id);
      if (existingRecipients.length > 0) {
        if (campaign.duplicatePolicy && campaign.duplicatePolicy !== policy) {
          return reply.code(409).send({ error: 'Import is already confirmed with a different duplicate policy' });
        }
        setDuplicatePolicy(request.params.id, policy);
        return reply.send(
          jsonValue({
            campaign: getCampaign(request.params.id, owner),
            duplicatePolicy: policy,
            recipients: existingRecipients,
          }),
        );
      }
      const recipients = resolveDuplicates(preview, policy);
      const persistedRecipients = saveRecipients(request.params.id, recipients);
      setDuplicatePolicy(request.params.id, policy);
      return reply.send(
        jsonValue({
          campaign: getCampaign(request.params.id, owner),
          duplicatePolicy: policy,
          recipients: persistedRecipients,
        }),
      );
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'Import confirmation failed' });
    }
  },
);

app.get<{ Params: { id: string } }>('/api/campaigns/:id', async (request, reply) => {
  const owner = sessionId(request, reply);
  const campaign = getCampaign(request.params.id, owner);
  if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
  return reply.send(
    jsonValue({
      campaign,
      recipientCount: getRecipients(campaign.id).length,
      suggestedGroups: getSuggestedGroups(campaign.id),
    }),
  );
});

app.post<{ Params: { id: string }; Body: { mode?: AnalysisMode } }>(
  '/api/campaigns/:id/analyze',
  async (request, reply) => {
    const owner = sessionId(request, reply);
    const campaign = getCampaign(request.params.id, owner);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    const recipients = getRecipients(campaign.id);
    if (recipients.length === 0) return reply.code(409).send({ error: 'Confirm the import before analysis' });
    const mode = request.body?.mode ?? configuredAnalysisMode();
    if (mode !== 'synthetic' && mode !== 'live')
      return reply.code(400).send({ error: 'Analysis mode must be synthetic or live' });
    const jobId = createAnalysisJob(campaign.id, analysisRecipientLimit(recipients.length, mode));
    setCampaignStatus(campaign.id, 'analyzing');
    enqueueAnalysis(jobId, campaign.id, mode);
    return reply.send({ jobId, status: 'queued', mode });
  },
);

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  const owner = sessionId(request, reply);
  const job = getAnalysisJob(request.params.id, owner);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.send(jsonValue(job));
});

app.get<{ Params: { id: string } }>('/api/campaigns/:id/graph', async (request, reply) => {
  const owner = sessionId(request, reply);
  const campaign = getCampaign(request.params.id, owner);
  if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
  const recipients = getRecipients(campaign.id);
  const observations = getObservations(campaign.id);
  const graph = deriveEvidence(recipients, observations, registryAddresses(defaultInfrastructureRegistry));
  const latestJob = db()
    .prepare(
      'SELECT status, stage, coverage_json FROM analysis_jobs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(campaign.id) as { status?: string; stage?: string; coverage_json?: string } | undefined;
  const coverage = latestJob?.coverage_json ? JSON.parse(latestJob.coverage_json) : {};
  const eligibleAddresses = new Set(recipients.map((recipient) => recipient.normalizedAddress));
  const contextualAddresses = new Set<string>();
  for (const observation of observations) {
    for (const address of [observation.from, observation.to]) {
      if (!eligibleAddresses.has(address.toLowerCase())) contextualAddresses.add(address.toLowerCase());
    }
  }
  return reply.send(
    jsonValue({
      nodes: [
        ...recipients.map((recipient) => ({ id: recipient.id, address: recipient.address, kind: 'recipient' })),
        ...[...contextualAddresses].map((address) => ({ id: address, address, kind: 'context' })),
      ],
      edges: graph.edges,
      groups: graph.groups.map(
        (group) => getSuggestedGroups(campaign.id).find((saved) => saved.id === group.id) ?? group,
      ),
      observations: observations.length,
      observationPreview: observations.slice(0, 50).map((observation) => ({
        id: observation.id,
        from: observation.from,
        to: observation.to,
        relation: observation.relation ?? 'observed relationship',
        category: observation.category,
        verified: observation.verified,
        source: observation.source,
        transactionHash: observation.transactionHash ?? null,
      })),
      analysis: {
        status: latestJob?.status ?? 'unknown',
        stage: latestJob?.stage ?? 'unknown',
        coverage,
      },
    }),
  );
});

app.post<{ Params: { id: string }; Body: { groupId?: string; action?: string; reason?: string } }>(
  '/api/campaigns/:id/reviews',
  async (request, reply) => {
    const owner = sessionId(request, reply);
    const campaign = getCampaign(request.params.id, owner);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    const { groupId, action, reason } = request.body ?? {};
    const allowed = new Set(['accepted_for_policy', 'dismissed', 'split', 'needs_more_evidence']);
    const group = getSuggestedGroups(campaign.id).find((candidate) => candidate.id === groupId);
    if (!group || !groupId || !action || !allowed.has(action))
      return reply.code(400).send({ error: 'Valid groupId and review action are required' });
    updateSuggestedGroup(campaign.id, groupId, action as typeof group.state);
    addReviewEvent({
      campaignId: campaign.id,
      sessionId: owner,
      groupId,
      action,
      reason: reason?.trim() || 'Organizer review decision',
      evidenceVersion: campaign.analysisVersion,
    });
    return reply.send({ ok: true, groupId, state: action });
  },
);

app.post<{ Params: { id: string }; Body: { groupCapMinor?: string | number; individualCapMinor?: string | number } }>(
  '/api/campaigns/:id/allocations',
  async (request, reply) => {
    const owner = sessionId(request, reply);
    const campaign = getCampaign(request.params.id, owner);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    const body = request.body ?? {};
    let groupCapMinor: bigint | undefined;
    let individualCapMinor: bigint | undefined;
    try {
      if (body.groupCapMinor !== undefined && String(body.groupCapMinor).trim() !== '')
        groupCapMinor = parseMinorUnits(body.groupCapMinor);
      if (body.individualCapMinor !== undefined && String(body.individualCapMinor).trim() !== '')
        individualCapMinor = parseMinorUnits(body.individualCapMinor);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid cap' });
    }
    const currentReview = getSuggestedGroups(campaign.id).find((group) => group.state !== 'suggested');
    if (currentReview?.state === 'needs_more_evidence') {
      return reply.code(409).send({ error: 'Choose a review policy before starting allocation' });
    }
    const reviewDecision: AllocationReviewDecision =
      currentReview?.state === 'accepted_for_policy' ||
      currentReview?.state === 'dismissed' ||
      currentReview?.state === 'split'
        ? currentReview.state
        : 'unreviewed';
    const policy = {
      groupCapMinor,
      individualCapMinor,
      acceptedGroups: acceptedGroups(campaign.id),
      reviewDecision,
    };
    try {
      const result = calculateAllocation(campaign.budgetMinor, getRecipients(campaign.id), policy);
      if (!allocationInvariant(result, policy)) throw new Error('Allocation invariant failed');
      const runId = saveAllocation({
        campaignId: campaign.id,
        policy,
        budgetMinor: result.budgetMinor,
        reserveMinor: result.unallocatedReserve,
        redistributedMinor: result.redistributedMinor,
        algorithmVersion: result.algorithmVersion,
        inputHash: campaign.inputHash,
        rows: result.rows,
      });
      return reply.send(jsonValue({ runId, policy, result }));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'Allocation failed' });
    }
  },
);

app.get<{ Params: { id: string } }>('/api/allocations/:id/export.csv', async (request, reply) => {
  const owner = sessionId(request, reply);
  const campaignById = getCampaign(request.params.id, owner);
  const campaign = campaignById ?? getCampaignByAllocationRun(request.params.id, owner);
  if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
  const stored = campaignById ? getLatestAllocation(campaign.id) : getAllocationRun(request.params.id, owner);
  if (!stored) return reply.code(404).send({ error: 'Run an allocation before exporting' });
  const recipients = getRecipients(campaign.id);
  const result = {
    budgetMinor: BigInt(String(stored.run.budget_minor)),
    rows: stored.rows.map((row) => {
      const recipient = recipients.find((candidate) => candidate.id === String(row.recipient_id));
      return {
        recipientId: String(row.recipient_id),
        chain: 'base' as const,
        address: recipient?.address ?? '',
        weightUnits: recipient?.weightUnits ?? 0n,
        baselineMinor: BigInt(String(row.baseline_minor)),
        adjustedMinor: BigInt(String(row.adjusted_minor)),
        deltaMinor: BigInt(String(row.delta_minor)),
        groupId: String(row.group_id),
        reason: String(row.reason),
      };
    }),
    unallocatedReserve: BigInt(String(stored.run.reserve_minor)),
    redistributedMinor: BigInt(String(stored.run.redistributed_minor)),
    algorithmVersion: String(stored.run.algorithm_version),
  };
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="fairdrop-${campaign.id}.csv"`);
  return reply.send(allocationCsv(campaign, result));
});

app.get<{ Params: { id: string } }>('/api/allocations/:id/manifest.json', async (request, reply) => {
  const owner = sessionId(request, reply);
  const campaignById = getCampaign(request.params.id, owner);
  const campaign = campaignById ?? getCampaignByAllocationRun(request.params.id, owner);
  if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
  const stored = campaignById ? getLatestAllocation(campaign.id) : getAllocationRun(request.params.id, owner);
  if (!stored) return reply.code(404).send({ error: 'Run an allocation before exporting' });
  const recipients = getRecipients(campaign.id);
  const result = {
    budgetMinor: BigInt(String(stored.run.budget_minor)),
    rows: stored.rows.map((row) => ({
      recipientId: String(row.recipient_id),
      chain: 'base' as const,
      address: recipients.find((candidate) => candidate.id === String(row.recipient_id))?.address ?? '',
      weightUnits: recipients.find((candidate) => candidate.id === String(row.recipient_id))?.weightUnits ?? 0n,
      baselineMinor: BigInt(String(row.baseline_minor)),
      adjustedMinor: BigInt(String(row.adjusted_minor)),
      deltaMinor: BigInt(String(row.delta_minor)),
      groupId: String(row.group_id),
      reason: String(row.reason),
    })),
    unallocatedReserve: BigInt(String(stored.run.reserve_minor)),
    redistributedMinor: BigInt(String(stored.run.redistributed_minor)),
    algorithmVersion: String(stored.run.algorithm_version),
  };
  const latestAnalysis = db()
    .prepare('SELECT coverage_json FROM analysis_jobs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(campaign.id) as { coverage_json?: string } | undefined;
  const dataCoverage = latestAnalysis?.coverage_json
    ? JSON.parse(latestAnalysis.coverage_json)
    : { mode: configuredAnalysisMode() };
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="fairdrop-${campaign.id}-manifest.json"`);
  return reply.send(
    allocationManifest(
      campaign,
      result,
      stored.run.policy_json ? JSON.parse(String(stored.run.policy_json)) : 'stored policy version',
      dataCoverage,
    ),
  );
});

app.get('/api/admin/usage', async (request, reply) => {
  if (!process.env.ADMIN_TOKEN || request.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)
    return reply.code(403).send({ error: 'Forbidden' });
  const rows = db()
    .prepare(
      'SELECT campaign_id, endpoint, purpose, status, request_id, credits_used, cache_hit, valid_data, created_at FROM api_calls ORDER BY created_at',
    )
    .all();
  return reply.send(rows);
});

app.delete<{ Params: { id: string } }>('/api/campaigns/:id', async (request, reply) => {
  const owner = sessionId(request, reply);
  if (!deleteCampaign(request.params.id, owner)) return reply.code(404).send({ error: 'Campaign not found' });
  return reply.code(204).send();
});

if (!existsSync(resolve(distRoot, 'index.html'))) {
  app.get('/', async () => ({ product: 'FairDrop', ui: appOrigin, api: `http://127.0.0.1:${apiPort}` }));
}

db();
app.listen({ host: '127.0.0.1', port: apiPort }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
