import type { AcceptedGroup, AllocationPolicy, AllocationResult, Recipient } from '../../../shared/types.ts';

export const ALGORITHM_VERSION = 'fairdrop-allocation-v1';

interface WeightedItem {
  key: string;
  weight: bigint;
  cap?: bigint;
}

function largestRemainder(total: bigint, items: WeightedItem[]): Map<string, bigint> {
  const result = new Map(items.map((item) => [item.key, 0n]));
  const positive = items.filter((item) => item.weight > 0n);
  const weightTotal = positive.reduce((sum, item) => sum + item.weight, 0n);
  if (total <= 0n || weightTotal === 0n) return result;

  const remainders = positive.map((item) => {
    const numerator = total * item.weight;
    const whole = numerator / weightTotal;
    result.set(item.key, whole);
    return { key: item.key, remainder: numerator % weightTotal };
  });
  let leftover = total - [...result.values()].reduce((sum, value) => sum + value, 0n);
  remainders.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  for (const item of remainders) {
    if (leftover === 0n) break;
    result.set(item.key, (result.get(item.key) ?? 0n) + 1n);
    leftover -= 1n;
  }
  return result;
}

/** Allocate a pool repeatedly, freezing items that exceed their capacity. */
export function allocateWithCaps(
  total: bigint,
  items: WeightedItem[],
): {
  allocations: Map<string, bigint>;
  reserve: bigint;
} {
  const allocations = new Map(items.map((item) => [item.key, 0n]));
  let remaining = total;
  let active = items.filter((item) => item.weight > 0n && (item.cap === undefined || item.cap > 0n));

  while (remaining > 0n && active.length > 0) {
    const proposed = largestRemainder(remaining, active);
    const capped = active.filter((item) => item.cap !== undefined && (proposed.get(item.key) ?? 0n) > item.cap);
    if (capped.length === 0) {
      for (const item of active) {
        const amount = proposed.get(item.key) ?? 0n;
        allocations.set(item.key, (allocations.get(item.key) ?? 0n) + amount);
      }
      remaining = 0n;
      break;
    }

    const cappedKeys = new Set(capped.map((item) => item.key));
    for (const item of capped) {
      const capacity = item.cap ?? 0n;
      allocations.set(item.key, (allocations.get(item.key) ?? 0n) + capacity);
      remaining -= capacity;
    }
    active = active.filter((item) => !cappedKeys.has(item.key));
  }

  return { allocations, reserve: remaining > 0n ? remaining : 0n };
}

function groupMap(recipients: Recipient[], groups: AcceptedGroup[]): Map<string, string> {
  const membership = new Map<string, string>();
  for (const group of groups) {
    for (const recipientId of group.recipientIds) {
      if (membership.has(recipientId)) {
        throw new Error(`Recipient ${recipientId} belongs to more than one accepted group`);
      }
      membership.set(recipientId, group.id);
    }
  }
  for (const recipient of recipients) {
    if (!membership.has(recipient.id)) membership.set(recipient.id, `singleton:${recipient.id}`);
  }
  return membership;
}

function groupCap(policy: AllocationPolicy, groupId: string, recipientCount: number): bigint | undefined {
  return groupId.startsWith('singleton:') || recipientCount < 2 ? undefined : policy.groupCapMinor;
}

/** Calculate a reproducible baseline, capped scenario, and reserve using integer minor units. */
export function calculateAllocation(
  budgetMinor: bigint,
  recipients: Recipient[],
  policy: AllocationPolicy,
): AllocationResult {
  if (budgetMinor < 0n) throw new Error('Budget cannot be negative');
  const totalWeight = recipients.reduce((sum, recipient) => sum + recipient.weightUnits, 0n);
  if (totalWeight === 0n) throw new Error('At least one recipient must have positive weight');

  const baselineAmounts = largestRemainder(
    budgetMinor,
    recipients.map((recipient) => ({ key: recipient.id, weight: recipient.weightUnits })),
  );
  const membership = groupMap(recipients, policy.acceptedGroups);
  const grouped = new Map<string, Recipient[]>();
  for (const recipient of recipients) {
    const id = membership.get(recipient.id);
    if (!id) throw new Error(`Recipient ${recipient.id} has no group`);
    const members = grouped.get(id) ?? [];
    members.push(recipient);
    grouped.set(id, members);
  }

  const groupItems: WeightedItem[] = [...grouped.entries()].map(([id, members]) => {
    const weight = members.reduce((sum, member) => sum + member.weightUnits, 0n);
    const memberCapacity =
      policy.individualCapMinor === undefined
        ? undefined
        : BigInt(members.filter((member) => member.weightUnits > 0n).length) * policy.individualCapMinor;
    const cap = [groupCap(policy, id, members.length), memberCapacity]
      .filter((value): value is bigint => value !== undefined)
      .reduce((minimum, value) => (minimum < value ? minimum : value), 2n ** 63n - 1n);
    return { key: id, weight, cap: cap === 2n ** 63n - 1n ? undefined : cap };
  });
  const outer = allocateWithCaps(budgetMinor, groupItems);
  const adjusted = new Map<string, bigint>();
  let reserve = outer.reserve;

  for (const [groupId, members] of grouped) {
    const groupAmount = outer.allocations.get(groupId) ?? 0n;
    const memberItems = members.map((member) => ({
      key: member.id,
      weight: member.weightUnits,
      cap: policy.individualCapMinor,
    }));
    const memberResult = allocateWithCaps(groupAmount, memberItems);
    reserve += memberResult.reserve;
    for (const member of members) adjusted.set(member.id, memberResult.allocations.get(member.id) ?? 0n);
  }

  const rows = recipients.map((recipient) => {
    const baseline = baselineAmounts.get(recipient.id) ?? 0n;
    const adjustedAmount = adjusted.get(recipient.id) ?? 0n;
    const groupId = membership.get(recipient.id) ?? `singleton:${recipient.id}`;
    const reason = groupId.startsWith('singleton:')
      ? policy.reviewDecision === 'dismissed'
        ? 'Baseline policy; review cue dismissed and wallets kept separate'
        : policy.reviewDecision === 'split'
          ? 'Baseline policy; review set split into separate wallets'
          : 'Baseline policy; no accepted multi-recipient group'
      : policy.groupCapMinor === undefined
        ? 'Accepted group; proportional group allocation'
        : `Accepted group; group cap ${policy.groupCapMinor.toString()} minor units`;
    return {
      recipientId: recipient.id,
      chain: recipient.chain,
      address: recipient.address,
      weightUnits: recipient.weightUnits,
      baselineMinor: baseline,
      adjustedMinor: adjustedAmount,
      deltaMinor: adjustedAmount - baseline,
      groupId,
      reason,
    };
  });
  const adjustedTotal = rows.reduce((sum, row) => sum + row.adjustedMinor, 0n);
  const redistributedMinor = rows.reduce((sum, row) => sum + (row.deltaMinor > 0n ? row.deltaMinor : 0n), 0n);
  if (adjustedTotal + reserve !== budgetMinor) {
    throw new Error('Allocation invariant failed: budget is not conserved');
  }
  return {
    budgetMinor,
    rows,
    unallocatedReserve: reserve,
    redistributedMinor,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

export function allocationInvariant(result: AllocationResult, policy: AllocationPolicy): boolean {
  if (result.rows.some((row) => row.adjustedMinor < 0n)) return false;
  if (
    result.rows.reduce((sum, row) => sum + row.adjustedMinor, 0n) + result.unallocatedReserve !==
    result.budgetMinor
  ) {
    return false;
  }
  if (policy.groupCapMinor !== undefined) {
    const groups = new Map<string, bigint>();
    for (const row of result.rows) groups.set(row.groupId, (groups.get(row.groupId) ?? 0n) + row.adjustedMinor);
    for (const [id, amount] of groups) {
      if (!id.startsWith('singleton:') && amount > policy.groupCapMinor) return false;
    }
  }
  const individualCap = policy.individualCapMinor;
  if (individualCap !== undefined && result.rows.some((row) => row.adjustedMinor > individualCap)) return false;
  return true;
}
