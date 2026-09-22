import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocationCsv, jsonWithBigInts } from '../server/export/serialize.ts';
import type { AllocationResult } from '../shared/types.ts';
import type { CampaignRecord } from '../server/db/database.ts';

const campaign = {
  id: 'campaign-1',
  sessionId: 'session-1',
  status: 'ready',
  inputCsv: 'chain,address,weight\n',
  inputHash: 'hash',
  chain: 'base',
  budgetMinor: 10n,
  unitLabel: 'USDC units',
  precision: 6,
  duplicatePolicy: 'keep-first',
  cutoffStart: '2026-01-01T00:00:00.000Z',
  cutoffEnd: '2026-01-02T00:00:00.000Z',
  analysisVersion: 'analysis-v1',
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies CampaignRecord;
const result: AllocationResult = {
  budgetMinor: 10n,
  unallocatedReserve: 0n,
  redistributedMinor: 1n,
  algorithmVersion: 'fairdrop-allocation-v1',
  rows: [
    {
      recipientId: 'recipient-1',
      chain: 'base',
      address: '0x0000000000000000000000000000000000000001',
      weightUnits: 1n,
      baselineMinor: 5n,
      adjustedMinor: 6n,
      deltaMinor: 1n,
      groupId: 'singleton:recipient-1',
      reason: '=suspicious text',
    },
  ],
};

describe('exports', () => {
  it('sanitizes formula-like reason cells and preserves integer fields', () => {
    const csv = allocationCsv(campaign, result);
    assert.match(csv, /'=suspicious text/);
    assert.match(csv, /fairdrop-allocation-v1/);
  });

  it('serializes bigint manifest values as strings', () => {
    assert.match(jsonWithBigInts({ budget: 10n }), /"budget": "10"/);
  });
});
