import type { Chain, EvidenceObservation } from '../../shared/types.ts';

export interface NansenRequestContext {
  endpoint: string;
  purpose: string;
  campaignId: string;
  date?: { from: string; to: string };
}

export interface NansenResult {
  status: number;
  requestId?: string;
  creditsUsed?: number;
  payload: unknown;
}

export interface NansenAdapter {
  relatedWallets(chain: Chain, address: string, context: NansenRequestContext): Promise<NansenResult>;
  transactions(chain: Chain, address: string, context: NansenRequestContext): Promise<NansenResult>;
  transactionLookup(
    chain: Chain,
    transactionHash: string,
    blockTimestamp: string,
    context: NansenRequestContext,
  ): Promise<NansenResult>;
}

export interface NormalizedProviderData {
  observations: EvidenceObservation[];
  coverage: 'complete' | 'partial' | 'empty' | 'failed';
  requestIds: string[];
  creditsUsed: number;
}
