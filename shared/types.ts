export type Chain = 'base';

export type CoverageStatus = 'pending' | 'complete' | 'partial' | 'empty' | 'failed';

export type ReviewState = 'suggested' | 'accepted_for_policy' | 'dismissed' | 'split' | 'needs_more_evidence';

export interface Recipient {
  id: string;
  sourceRow: number;
  chain: Chain;
  address: string;
  normalizedAddress: string;
  weightUnits: bigint;
  weightText: string;
}

export interface ImportIssue {
  row: number;
  code: string;
  message: string;
}

export interface DuplicateGroup {
  normalizedAddress: string;
  rows: number[];
}

export interface ImportPreview {
  headers: string[];
  rows: Array<Record<string, string>>;
  recipients: Recipient[];
  issues: ImportIssue[];
  duplicates: DuplicateGroup[];
  totalWeightUnits: bigint;
  inputHash: string;
}

export interface EvidenceObservation {
  id: string;
  chain: Chain;
  from: string;
  to: string;
  relatedAddress?: string;
  relation?: string;
  transactionHash?: string;
  blockTimestamp?: string;
  assetContract?: string;
  direction?: 'in' | 'out' | 'unknown';
  category: 'direct_recipient' | 'shared_funding' | 'coordinated_behavior' | 'context';
  verified: boolean;
  infrastructure?: boolean;
  source: string;
}

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  categories: string[];
  transactionHashes: string[];
  timestamps: string[];
  score: number;
  distinctTransactions: number;
  suggested: boolean;
  explanation: string;
}

export interface SuggestedGroup {
  id: string;
  recipientIds: string[];
  edgeIds: string[];
  state: ReviewState;
  score: number;
  reason: string;
}

export interface AcceptedGroup {
  id: string;
  recipientIds: string[];
}

export type AllocationReviewDecision = 'unreviewed' | 'accepted_for_policy' | 'dismissed' | 'split';

export interface AllocationRow {
  recipientId: string;
  chain: Chain;
  address: string;
  weightUnits: bigint;
  baselineMinor: bigint;
  adjustedMinor: bigint;
  deltaMinor: bigint;
  groupId: string;
  reason: string;
}

export interface AllocationResult {
  budgetMinor: bigint;
  rows: AllocationRow[];
  unallocatedReserve: bigint;
  redistributedMinor: bigint;
  algorithmVersion: string;
}

export interface AllocationPolicy {
  groupCapMinor?: bigint;
  individualCapMinor?: bigint;
  acceptedGroups: AcceptedGroup[];
  reviewDecision?: AllocationReviewDecision;
}
