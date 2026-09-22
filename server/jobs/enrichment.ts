import { deriveEvidence } from '../domain/evidence/rules.ts';
import { registryAddresses, defaultInfrastructureRegistry } from '../domain/evidence/registry.ts';
import {
  NansenClient,
  normalizeRelatedWallets,
  normalizeTransactionLookup,
  normalizeTransactions,
} from '../nansen/client.ts';
import type { NansenResult } from '../nansen/types.ts';
import {
  getCampaign,
  getRecipients,
  recordApiCall,
  saveObservations,
  saveSuggestedGroups,
  updateAnalysisJob,
} from '../db/database.ts';
import { syntheticObservations } from '../../fixtures/synthetic/observations.ts';
import type { EvidenceObservation, Recipient } from '../../shared/types.ts';

const DEFAULT_MAX_ANALYSIS_WALLETS = 200;
const DEFAULT_MAX_VERIFICATION_LOOKUPS = 5;
const DEFAULT_LOOKUP_CONCURRENCY = 3;
const DEFAULT_RECIPIENT_CONCURRENCY = 3;

export type AnalysisMode = 'synthetic' | 'live';

export function configuredAnalysisMode(): AnalysisMode {
  return process.env.DATA_MODE === 'synthetic' ? 'synthetic' : 'live';
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function analysisRecipientLimit(total: number, mode: AnalysisMode = configuredAnalysisMode()): number {
  return mode === 'live'
    ? Math.min(total, positiveEnvNumber('MAX_ANALYSIS_WALLETS', DEFAULT_MAX_ANALYSIS_WALLETS))
    : total;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nansenTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    return value
      .replace('T', ' ')
      .replace(/\.\d+Z?$/, '')
      .replace(/Z$/, '');
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function resultError(result: NansenResult): string | undefined {
  if (result.status === 200) return undefined;
  if (result.payload && typeof result.payload === 'object') {
    const payload = result.payload as Record<string, unknown>;
    const detail = [payload.error, payload.message, payload.detail].find((value) => typeof value === 'string');
    if (typeof detail === 'string') return `Nansen returned HTTP ${result.status}: ${detail}`;
  }
  return `Nansen returned HTTP ${result.status}`;
}

function classifyVerifiedObservation(
  observation: EvidenceObservation,
  eligibleAddresses: Set<string>,
  relation?: string,
): EvidenceObservation['category'] {
  const fromEligible = eligibleAddresses.has(observation.from.toLowerCase());
  const toEligible = eligibleAddresses.has(observation.to.toLowerCase());
  if (fromEligible && toEligible && observation.from.toLowerCase() !== observation.to.toLowerCase()) {
    return 'direct_recipient';
  }
  if ((fromEligible || toEligible) && /fund|funder|funding/i.test(relation ?? '')) return 'shared_funding';
  return 'context';
}

async function runSynthetic(jobId: string, campaignId: string): Promise<EvidenceObservation[]> {
  const recipients = getRecipients(campaignId);
  updateAnalysisJob(jobId, {
    status: 'running',
    stage: 'synthetic-evidence',
    completed: 0,
    total: recipients.length,
    coverage: { mode: 'synthetic' },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const eligible = new Set(recipients.map((recipient) => recipient.normalizedAddress));
  return syntheticObservations.filter(
    (observation) => eligible.has(observation.from.toLowerCase()) || eligible.has(observation.to.toLowerCase()),
  );
}

interface LiveRun {
  observations: EvidenceObservation[];
  attempted: number;
  completed: number;
  failed: number;
  verificationLookups: number;
  failures: string[];
}

async function runLive(jobId: string, campaignId: string): Promise<LiveRun> {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error('NANSEN_API_KEY is required when DATA_MODE=live');
  const client = new NansenClient(key);
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  const allRecipients = getRecipients(campaignId);
  const recipients = allRecipients.slice(0, analysisRecipientLimit(allRecipients.length, 'live'));
  const eligibleAddresses = new Set(allRecipients.map((recipient) => recipient.normalizedAddress));
  const date = { from: campaign.cutoffStart.slice(0, 10), to: campaign.cutoffEnd.slice(0, 10) };
  const observations: EvidenceObservation[] = [];
  const failures: string[] = [];
  const lookupHashes = new Set<string>();
  const maxVerificationLookups = positiveEnvNumber('MAX_VERIFICATION_LOOKUPS', DEFAULT_MAX_VERIFICATION_LOOKUPS);
  const lookupConcurrency = positiveEnvNumber('NANSEN_LOOKUP_CONCURRENCY', DEFAULT_LOOKUP_CONCURRENCY);
  const recipientConcurrency = positiveEnvNumber('NANSEN_RECIPIENT_CONCURRENCY', DEFAULT_RECIPIENT_CONCURRENCY);
  let verificationLookups = 0;
  let completed = 0;
  let failed = 0;

  updateAnalysisJob(jobId, {
    status: 'running',
    stage: 'provider-enrichment',
    completed: 0,
    total: recipients.length,
    coverage: {
      mode: 'live',
      importedRecipients: allRecipients.length,
      analyzedRecipients: recipients.length,
      completedRecipients: 0,
      failedRecipients: 0,
      verificationLookups: 0,
      maxAnalysisWallets: analysisRecipientLimit(allRecipients.length, 'live'),
    },
  });

  const recordFailedCall = (recipient: Recipient, endpoint: string, purpose: string, error: unknown) => {
    const message = errorMessage(error);
    recordApiCall({ campaignId, endpoint, purpose, status: 0, validData: false });
    failures.push(`${recipient.address} ${endpoint}: ${message}`);
  };

  const recordResult = (
    recipient: Recipient,
    endpoint: string,
    purpose: string,
    result: NansenResult,
  ): string | undefined => {
    recordApiCall({
      campaignId,
      endpoint,
      purpose,
      status: result.status,
      requestId: result.requestId,
      creditsUsed: result.creditsUsed,
      validData: result.status === 200,
    });
    const failure = resultError(result);
    if (failure) failures.push(`${recipient.address} ${endpoint}: ${failure}`);
    return failure;
  };

  const verifyCandidates = async (recipient: Recipient, candidates: EvidenceObservation[]) => {
    const pending: EvidenceObservation[] = [];
    const prioritized = [
      ...candidates.filter((candidate) => {
        const fromEligible = eligibleAddresses.has(candidate.from.toLowerCase());
        const toEligible = eligibleAddresses.has(candidate.to.toLowerCase());
        return fromEligible && toEligible && candidate.from.toLowerCase() !== candidate.to.toLowerCase();
      }),
      ...candidates.filter((candidate) => /fund|funder/i.test(candidate.relation ?? '')),
      ...candidates,
    ];
    for (const candidate of prioritized) {
      if (!candidate.transactionHash || !candidate.blockTimestamp) continue;
      const hash = candidate.transactionHash.toLowerCase();
      if (lookupHashes.has(hash) || verificationLookups >= maxVerificationLookups) continue;
      lookupHashes.add(hash);
      verificationLookups += 1;
      pending.push(candidate);
    }

    let cursor = 0;
    const verifyNext = async () => {
      while (cursor < pending.length) {
        const candidate = pending[cursor++];
        if (!candidate || !candidate.transactionHash || !candidate.blockTimestamp) continue;
        const endpoint = '/api/v1/transaction-with-token-transfer-lookup';
        const purpose = 'targeted transaction verification';
        try {
          const lookup = await client.transactionLookup(
            recipient.chain,
            candidate.transactionHash,
            nansenTimestamp(candidate.blockTimestamp),
            { campaignId, endpoint, purpose, date },
          );
          recordResult(recipient, endpoint, purpose, lookup);
          const verified = normalizeTransactionLookup(lookup, {
            address: recipient.address,
            transactionHash: candidate.transactionHash,
            blockTimestamp: candidate.blockTimestamp,
          }).map((observation) => ({
            ...observation,
            relation: candidate.relation,
            category: classifyVerifiedObservation(observation, eligibleAddresses, candidate.relation),
          }));
          observations.push(...verified);
        } catch (error) {
          recordFailedCall(recipient, endpoint, purpose, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(lookupConcurrency, pending.length) }, () => verifyNext()));
  };

  const processRecipient = async (recipient: Recipient) => {
    let recipientHasSuccessfulEndpoint = false;
    const candidates: EvidenceObservation[] = [];
    const relatedContext = {
      campaignId,
      endpoint: '/api/v1/profiler/address/related-wallets',
      purpose: 'first-degree relationship pass',
      date,
    };
    const relatedPromise = client.relatedWallets(recipient.chain, recipient.address, relatedContext);
    const transactionContext = {
      campaignId,
      endpoint: '/api/v1/profiler/address/transactions',
      purpose: '90-day transaction context',
      date,
    };
    const transactionsPromise = client.transactions(recipient.chain, recipient.address, transactionContext);
    const [relatedResult, transactionsResult] = await Promise.allSettled([relatedPromise, transactionsPromise]);

    if (relatedResult.status === 'fulfilled') {
      const related = relatedResult.value;
      const failure = recordResult(recipient, relatedContext.endpoint, relatedContext.purpose, related);
      const normalized = normalizeRelatedWallets(related, recipient.address);
      observations.push(...normalized);
      candidates.push(...normalized);
      recipientHasSuccessfulEndpoint ||= !failure;
    } else {
      recordFailedCall(recipient, relatedContext.endpoint, relatedContext.purpose, relatedResult.reason);
    }

    if (transactionsResult.status === 'fulfilled') {
      const transactions = transactionsResult.value;
      const failure = recordResult(recipient, transactionContext.endpoint, transactionContext.purpose, transactions);
      const normalized = normalizeTransactions(transactions, recipient.address);
      observations.push(...normalized);
      candidates.push(...normalized);
      recipientHasSuccessfulEndpoint ||= !failure;
    } else {
      recordFailedCall(recipient, transactionContext.endpoint, transactionContext.purpose, transactionsResult.reason);
    }

    await verifyCandidates(recipient, candidates);
    completed += 1;
    if (!recipientHasSuccessfulEndpoint) failed += 1;
    updateAnalysisJob(jobId, {
      status: 'running',
      stage: 'provider-enrichment',
      completed,
      total: recipients.length,
      coverage: {
        mode: 'live',
        importedRecipients: allRecipients.length,
        analyzedRecipients: recipients.length,
        completedRecipients: completed,
        failedRecipients: failed,
        verificationLookups,
        maxAnalysisWallets: analysisRecipientLimit(allRecipients.length, 'live'),
      },
    });
  };

  let recipientCursor = 0;
  const processNextRecipient = async () => {
    while (recipientCursor < recipients.length) {
      const recipient = recipients[recipientCursor++];
      if (recipient) await processRecipient(recipient);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(recipientConcurrency, recipients.length) }, () => processNextRecipient()),
  );

  if (recipients.length > 0 && failed === recipients.length) {
    const firstFailure = failures[0] ?? 'No provider response was accepted';
    throw new Error(`Live analysis failed for all ${recipients.length} analyzed wallets. ${firstFailure}`);
  }
  return { observations, attempted: recipients.length, completed, failed, verificationLookups, failures };
}

export async function runAnalysisJob(
  jobId: string,
  campaignId: string,
  mode: AnalysisMode = configuredAnalysisMode(),
): Promise<void> {
  try {
    const campaign = getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');
    const live = mode === 'live';
    const liveResult = live ? await runLive(jobId, campaignId) : undefined;
    const observations = liveResult?.observations ?? (await runSynthetic(jobId, campaignId));
    saveObservations(campaignId, observations);
    const graph = deriveEvidence(
      getRecipients(campaignId),
      observations,
      registryAddresses(defaultInfrastructureRegistry),
    );
    saveSuggestedGroups(campaignId, graph.groups);
    const recipientCount = getRecipients(campaignId).length;
    updateAnalysisJob(jobId, {
      status: 'complete',
      stage: 'evidence-ready',
      completed: liveResult?.completed ?? recipientCount,
      total: liveResult?.attempted ?? recipientCount,
      coverage: {
        mode,
        importedRecipients: recipientCount,
        analyzedRecipients: liveResult?.attempted ?? recipientCount,
        observationCount: observations.length,
        groupCount: graph.groups.length,
        ...(liveResult
          ? {
              failedRecipients: liveResult.failed,
              verificationLookups: liveResult.verificationLookups,
              maxAnalysisWallets: analysisRecipientLimit(recipientCount, 'live'),
              ...(liveResult.failures.length > 0 ? { failures: liveResult.failures.slice(0, 10) } : {}),
            }
          : {}),
      },
    });
  } catch (error) {
    updateAnalysisJob(jobId, {
      status: 'failed',
      stage: 'error',
      completed: 0,
      total: getRecipients(campaignId).length,
      coverage: {},
      error: errorMessage(error),
    });
  }
}

export function enqueueAnalysis(jobId: string, campaignId: string, mode?: AnalysisMode): void {
  void runAnalysisJob(jobId, campaignId, mode);
}
