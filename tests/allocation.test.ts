import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAllocation, allocationInvariant } from '../server/domain/allocation/allocator.ts';
import type { AllocationPolicy, Recipient } from '../shared/types.ts';

function recipient(id: string, weight: bigint): Recipient {
  return {
    id,
    sourceRow: Number(id.slice(-1)),
    chain: 'base',
    address: `0x${id.padStart(40, '0')}`,
    normalizedAddress: `0x${id.padStart(40, '0')}`,
    weightUnits: weight,
    weightText: weight.toString(),
  };
}

describe('integer allocation', () => {
  it('conserves a tiny budget with deterministic largest remainders', () => {
    const recipients = [recipient('1', 1n), recipient('2', 1n), recipient('3', 1n)];
    const policy: AllocationPolicy = { acceptedGroups: [] };
    const result = calculateAllocation(2n, recipients, policy);
    assert.deepEqual(
      result.rows.map((row) => row.adjustedMinor),
      [1n, 1n, 0n],
    );
    assert.equal(result.unallocatedReserve, 0n);
    assert.equal(allocationInvariant(result, policy), true);
  });

  it('caps an accepted group and redistributes to remaining capacity', () => {
    const recipients = [recipient('1', 1n), recipient('2', 1n), recipient('3', 1n)];
    const policy: AllocationPolicy = {
      acceptedGroups: [{ id: 'suggested-1', recipientIds: ['1', '2'] }],
      groupCapMinor: 3n,
    };
    const result = calculateAllocation(9n, recipients, policy);
    assert.deepEqual(
      result.rows.map((row) => row.adjustedMinor),
      [2n, 1n, 6n],
    );
    assert.equal(result.unallocatedReserve, 0n);
    assert.equal(allocationInvariant(result, policy), true);
  });

  it('keeps separate and split choices distinct in the audit reason', () => {
    const recipients = [recipient('1', 1n), recipient('2', 1n)];
    const separatePolicy: AllocationPolicy = { acceptedGroups: [], reviewDecision: 'dismissed' };
    const splitPolicy: AllocationPolicy = { acceptedGroups: [], reviewDecision: 'split' };
    const separate = calculateAllocation(10n, recipients, separatePolicy);
    const split = calculateAllocation(10n, recipients, splitPolicy);

    assert.deepEqual(
      separate.rows.map((row) => row.adjustedMinor),
      split.rows.map((row) => row.adjustedMinor),
    );
    assert.match(separate.rows[0]?.reason ?? '', /kept separate/);
    assert.match(split.rows[0]?.reason ?? '', /split into separate wallets/);
  });

  it('keeps a reserve when member caps exhaust the budget', () => {
    const recipients = [recipient('1', 1n), recipient('2', 1n)];
    const policy: AllocationPolicy = {
      acceptedGroups: [{ id: 'suggested-1', recipientIds: ['1', '2'] }],
      groupCapMinor: 100n,
      individualCapMinor: 2n,
    };
    const result = calculateAllocation(9n, recipients, policy);
    assert.equal(
      result.rows.reduce((sum, row) => sum + row.adjustedMinor, 0n),
      4n,
    );
    assert.equal(result.unallocatedReserve, 5n);
    assert.equal(allocationInvariant(result, policy), true);
  });

  it('rejects overlapping accepted groups', () => {
    const recipients = [recipient('1', 1n), recipient('2', 1n)];
    assert.throws(() =>
      calculateAllocation(10n, recipients, {
        acceptedGroups: [
          { id: 'a', recipientIds: ['1'] },
          { id: 'b', recipientIds: ['1'] },
        ],
      }),
    );
  });
});
