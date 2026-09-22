import type { EvidenceEdge, EvidenceObservation, Recipient, SuggestedGroup } from '../../../shared/types.ts';

const CATEGORY_WEIGHT: Record<string, number> = {
  direct_recipient: 3,
  shared_funding: 2,
  coordinated_behavior: 1,
};

interface PairEvidence {
  from: string;
  to: string;
  categories: Set<string>;
  relation: string;
  transactionHashes: Set<string>;
  timestamps: Set<string>;
  edgeIds: string[];
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('::');
}

function asRecipientId(address: string, recipientsByAddress: Map<string, Recipient>): string | undefined {
  return recipientsByAddress.get(address.toLowerCase())?.id;
}

/** Convert provider observations into pair-level evidence without turning transitive links into identity claims. */
export function deriveEvidence(
  recipients: Recipient[],
  observations: EvidenceObservation[],
  infrastructureAddresses = new Set<string>(),
): { edges: EvidenceEdge[]; groups: SuggestedGroup[] } {
  const recipientsByAddress = new Map(recipients.map((recipient) => [recipient.normalizedAddress, recipient]));
  const pairs = new Map<string, PairEvidence>();
  const sharedFunderObservations = new Map<string, Array<{ recipientId: string; observation: EvidenceObservation }>>();
  const addToPair = (
    left: string,
    right: string,
    observation: EvidenceObservation,
    category = observation.category,
  ) => {
    const sorted = [left, right].sort();
    const first = sorted[0]!;
    const second = sorted[1]!;
    const key = pairKey(first, second);
    const current = pairs.get(key) ?? {
      from: first,
      to: second,
      categories: new Set<string>(),
      relation: observation.relation ?? 'observed_relationship',
      transactionHashes: new Set<string>(),
      timestamps: new Set<string>(),
      edgeIds: [],
    };
    current.categories.add(category);
    if (observation.transactionHash) current.transactionHashes.add(observation.transactionHash.toLowerCase());
    if (observation.blockTimestamp) current.timestamps.add(observation.blockTimestamp);
    current.edgeIds.push(observation.id);
    pairs.set(key, current);
  };
  for (const observation of observations) {
    if (!observation.verified) continue;
    const from = asRecipientId(observation.from, recipientsByAddress);
    const to = asRecipientId(observation.to, recipientsByAddress);
    const infrastructure =
      observation.infrastructure ||
      infrastructureAddresses.has(observation.from.toLowerCase()) ||
      infrastructureAddresses.has(observation.to.toLowerCase());
    if (infrastructure && observation.category === 'shared_funding') continue;
    if (from && to && from !== to) addToPair(from, to, observation);
    if (observation.category === 'shared_funding') {
      const eligible = from ?? to;
      const external = from ? (to ? undefined : observation.to) : observation.from;
      if (eligible && external) {
        const funding = sharedFunderObservations.get(external.toLowerCase()) ?? [];
        funding.push({ recipientId: eligible, observation });
        sharedFunderObservations.set(external.toLowerCase(), funding);
      }
    }
  }
  for (const funding of sharedFunderObservations.values()) {
    for (let leftIndex = 0; leftIndex < funding.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < funding.length; rightIndex += 1) {
        const left = funding[leftIndex];
        const right = funding[rightIndex];
        if (!left || !right || left.recipientId === right.recipientId) continue;
        addToPair(left.recipientId, right.recipientId, left.observation, 'shared_funding');
        addToPair(left.recipientId, right.recipientId, right.observation, 'shared_funding');
      }
    }
  }

  const edges: EvidenceEdge[] = [...pairs.values()].map((pair, index) => {
    const categoriesSet = new Set(pair.categories);
    const distinctTransactions = pair.transactionHashes.size;
    const repeatedDirectActivity = categoriesSet.has('direct_recipient') && distinctTransactions >= 3;
    if (repeatedDirectActivity) categoriesSet.add('coordinated_behavior');
    const categories = [...categoriesSet];
    const score = categories.reduce((sum, category) => sum + (CATEGORY_WEIGHT[category] ?? 0), 0);
    const suggested = score >= 4 && categories.length >= 2 && distinctTransactions >= 3;
    const explanation = suggested
      ? repeatedDirectActivity && !pair.categories.has('coordinated_behavior')
        ? 'Repeated verified direct transfers warrant organizer review as a coordination cue.'
        : 'Multiple verified evidence categories and three or more distinct transactions warrant organizer review.'
      : 'Evidence is retained for context but does not meet the review suggestion threshold.';
    return {
      id: `edge-${index + 1}`,
      from: pair.from,
      to: pair.to,
      relation: pair.relation,
      categories,
      transactionHashes: [...pair.transactionHashes].sort(),
      timestamps: [...pair.timestamps].sort(),
      score,
      distinctTransactions,
      suggested,
      explanation,
    };
  });

  const suggestedEdges = edges.filter((edge) => edge.suggested);
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    const current = parent.get(value);
    if (!current || current === value) {
      parent.set(value, value);
      return value;
    }
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const edge of suggestedEdges) union(edge.from, edge.to);
  const components = new Map<string, { members: Set<string>; edgeIds: string[]; score: number }>();
  for (const edge of suggestedEdges) {
    const root = find(edge.from);
    const component = components.get(root) ?? { members: new Set<string>(), edgeIds: [], score: 0 };
    component.members.add(edge.from);
    component.members.add(edge.to);
    component.edgeIds.push(edge.id);
    component.score += edge.score;
    components.set(root, component);
  }
  const groups = [...components.values()].map((component, index) => ({
    id: `suggested-${index + 1}`,
    recipientIds: [...component.members].sort(),
    edgeIds: component.edgeIds.sort(),
    state: 'suggested' as const,
    score: component.score,
    reason: 'Suggested review set only. Pair-level evidence must be inspected before accepting policy.',
  }));
  return { edges, groups };
}

export const evidenceVocabulary = {
  categoryWeights: CATEGORY_WEIGHT,
  threshold: { score: 4, categories: 2, distinctTransactions: 3 },
};
