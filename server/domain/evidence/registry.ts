export interface InfrastructureReview {
  address: string;
  kind: 'exchange' | 'bridge' | 'router' | 'distributor' | 'service' | 'unknown';
  source: string;
  reviewerNotes: string;
  reviewedAt: string;
}

export const defaultInfrastructureRegistry: InfrastructureReview[] = [
  {
    address: '0x00000000000000000000000000000000000000f0',
    kind: 'router',
    source: 'synthetic-fixture',
    reviewerNotes: 'Synthetic shared router used to verify service-node exclusion.',
    reviewedAt: '2026-09-20T00:00:00.000Z',
  },
];

export function registryAddresses(registry: InfrastructureReview[] = defaultInfrastructureRegistry): Set<string> {
  return new Set(registry.map((entry) => entry.address.toLowerCase()));
}
