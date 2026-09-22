import { createHash } from 'node:crypto';
import type { AllocationResult } from '../../shared/types.ts';
import type { CampaignRecord } from '../db/database.ts';

function cell(value: string | number | bigint): string {
  const text = String(value);
  const safe = typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Serialize every imported recipient, including zero allocations, into the audit CSV contract. */
export function allocationCsv(campaign: CampaignRecord, result: AllocationResult): string {
  const header = [
    'recipient_id',
    'chain',
    'address',
    'weight',
    'baseline',
    'adjusted_amount',
    'delta',
    'group_id',
    'policy_reason',
    'allocation_version',
  ];
  const lines = [header.join(',')];
  for (const row of result.rows) {
    lines.push(
      [
        row.recipientId,
        row.chain,
        row.address,
        row.weightUnits,
        row.baselineMinor,
        row.adjustedMinor,
        row.deltaMinor,
        row.groupId,
        row.reason,
        result.algorithmVersion,
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function allocationManifest(
  campaign: CampaignRecord,
  result: AllocationResult,
  policy: unknown,
  dataCoverage: unknown = { mode: process.env.DATA_MODE === 'synthetic' ? 'synthetic' : 'live' },
): Record<string, unknown> {
  const inputHash = createHash('sha256').update(campaign.inputCsv).digest('hex');
  return {
    product: 'FairDrop',
    campaignId: campaign.id,
    inputHash,
    units: { label: campaign.unitLabel, precision: campaign.precision, integerMinorUnits: true },
    chain: campaign.chain,
    cutoff: {
      start: campaign.cutoffStart,
      end: campaign.cutoffEnd,
      relationshipCoverage: 'current observation; not exhaustive at historical cutoff',
    },
    policy,
    algorithmVersion: result.algorithmVersion,
    dataCoverage,
    totals: {
      budgetMinor: result.budgetMinor.toString(),
      redistributedMinor: result.redistributedMinor.toString(),
      unallocatedReserve: result.unallocatedReserve.toString(),
      recipientCount: result.rows.length,
    },
    sourceAttribution:
      'Nansen evidence is used only where returned and retained; this manifest is a derived campaign export.',
    limitations: [
      'Suggested groups are review cues, not identity or fraud findings.',
      'A shared funder, exchange, bridge, router, or timing pattern alone does not establish common ownership.',
    ],
  };
}

export function jsonWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, current) => (typeof current === 'bigint' ? current.toString() : current), 2);
}
