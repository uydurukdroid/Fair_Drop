import type { Chain, EvidenceObservation } from '../../shared/types.ts';
import type { NansenAdapter, NansenRequestContext, NansenResult } from './types.ts';

const API_BASE = 'https://api.nansen.ai';

function defaultDate(): { from: string; to: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function requestTimeoutMs(): number {
  const value = Number(process.env.NANSEN_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : 60_000;
}

function requestMaxAttempts(): number {
  const value = Number(process.env.NANSEN_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

async function postJson(
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs = requestTimeoutMs(),
): Promise<NansenResult> {
  const maxAttempts = requestMaxAttempts();
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', apikey: apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        continue;
      }
      const creditsHeader =
        response.headers.get('x-nansen-credits-used') ?? response.headers.get('x-nansen-credits-cost') ?? undefined;
      const creditsUsed = creditsHeader === undefined ? undefined : Number(creditsHeader);
      return {
        status: response.status,
        requestId,
        ...(creditsUsed !== undefined && Number.isFinite(creditsUsed) ? { creditsUsed } : {}),
        payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Nansen request ${path} failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Nansen request ${path} exceeded its retry budget`);
}

function records(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const candidate = payload as Record<string, unknown>;
  for (const key of ['data', 'results', 'records']) {
    if (Array.isArray(candidate[key]))
      return candidate[key].filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
      );
    if (candidate[key] && typeof candidate[key] === 'object') return [candidate[key] as Record<string, unknown>];
  }
  return Array.isArray(payload)
    ? payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

function text(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function childRecords(record: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  return keys.flatMap((key) => {
    const value = record[key];
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      : [];
  });
}

/** Validate and normalize the provider's variable response envelope without inventing fields. */
export function normalizeRelatedWallets(result: NansenResult, address: string): EvidenceObservation[] {
  return records(result.payload).flatMap((record, index) => {
    const related = text(record, ['address', 'related_address', 'wallet_address']);
    if (!related) return [];
    const transactionHash = text(record, ['transaction_hash', 'tx_hash']);
    return [
      {
        id: `nansen-related-${address.toLowerCase()}-${index + 1}`,
        chain: 'base' as Chain,
        from: address,
        to: related,
        relatedAddress: related,
        relation: text(record, ['relation', 'relationship']) ?? 'provider_related_wallet',
        ...(transactionHash ? { transactionHash } : {}),
        ...(text(record, ['block_timestamp', 'timestamp'])
          ? { blockTimestamp: text(record, ['block_timestamp', 'timestamp']) }
          : {}),
        category: 'context' as const,
        verified: false,
        source: 'nansen.related-wallets',
      } satisfies EvidenceObservation,
    ];
  });
}

export function normalizeTransactions(result: NansenResult, address: string): EvidenceObservation[] {
  return records(result.payload).flatMap((record, index) => {
    const nestedTransfers = [
      ...childRecords(record, ['tokens_sent', 'sent_tokens']).map((transfer) => ({
        transfer,
        direction: 'out' as const,
      })),
      ...childRecords(record, ['tokens_received', 'received_tokens']).map((transfer) => ({
        transfer,
        direction: 'in' as const,
      })),
      ...childRecords(record, ['token_transfer_array', 'token_transfers']).map((transfer) => ({
        transfer,
        direction: 'unknown' as const,
      })),
    ];
    const transfers =
      nestedTransfers.length > 0 ? nestedTransfers : [{ transfer: record, direction: 'unknown' as const }];
    const transactionHash = text(record, ['transaction_hash', 'tx_hash']);
    const blockTimestamp = text(record, ['block_timestamp', 'timestamp']);
    const relation = text(record, ['relation', 'method', 'source_type']) ?? 'provider_transaction';
    return transfers.flatMap(({ transfer, direction }, transferIndex) => {
      const from =
        text(transfer, ['from_address', 'from', 'sender']) ?? text(record, ['from_address', 'from']) ?? address;
      const to = text(transfer, ['to_address', 'to', 'recipient']) ?? text(record, ['to_address', 'to']);
      if (!to) return [];
      return [
        {
          id: `nansen-transaction-${address.toLowerCase()}-${index + 1}-${transferIndex + 1}`,
          chain: 'base' as Chain,
          from,
          to,
          relation,
          ...(transactionHash ? { transactionHash } : {}),
          ...(blockTimestamp ? { blockTimestamp } : {}),
          ...((text(transfer, ['token_address', 'asset_contract']) ?? text(record, ['token_address', 'asset_contract']))
            ? {
                assetContract:
                  text(transfer, ['token_address', 'asset_contract']) ??
                  text(record, ['token_address', 'asset_contract']),
              }
            : {}),
          direction,
          category: 'context' as const,
          verified: result.status === 200 && Boolean(transactionHash && blockTimestamp),
          source: 'nansen.transactions',
        } satisfies EvidenceObservation,
      ];
    });
  });
}

/** Normalize a targeted lookup response; only successful provider responses become verified observations. */
export function normalizeTransactionLookup(
  result: NansenResult,
  fallback: { address: string; transactionHash: string; blockTimestamp?: string },
): EvidenceObservation[] {
  return records(result.payload).flatMap((record, index) => {
    const from = text(record, ['from_address', 'from', 'sender']) ?? fallback.address;
    const to = text(record, ['to_address', 'to', 'recipient']);
    if (!from || !to) return [];
    const transactionHash = text(record, ['transaction_hash', 'tx_hash']) ?? fallback.transactionHash;
    const blockTimestamp = text(record, ['block_timestamp', 'timestamp']) ?? fallback.blockTimestamp;
    const tokenTransfers = childRecords(record, ['token_transfer_array', 'token_transfers', 'tokenTransfers']);
    const transfers = tokenTransfers.length > 0 ? tokenTransfers : [record];
    return transfers.flatMap((transfer, transferIndex) => {
      const transferFrom = text(transfer, ['from_address', 'from']) ?? from;
      const transferTo = text(transfer, ['to_address', 'to']) ?? to;
      return [
        {
          id: `nansen-lookup-${transactionHash.toLowerCase()}-${index + 1}-${transferIndex + 1}`,
          chain: 'base' as Chain,
          from: transferFrom,
          to: transferTo,
          ...(transactionHash ? { transactionHash } : {}),
          ...(blockTimestamp ? { blockTimestamp } : {}),
          ...(text(transfer, ['token_address', 'asset_contract'])
            ? { assetContract: text(transfer, ['token_address', 'asset_contract']) }
            : {}),
          category: 'context' as const,
          verified: result.status === 200,
          source: 'nansen.transaction-lookup',
        } satisfies EvidenceObservation,
      ];
    });
  });
}

export class NansenClient implements NansenAdapter {
  constructor(private readonly apiKey: string) {}

  relatedWallets(chain: Chain, address: string, context: NansenRequestContext): Promise<NansenResult> {
    return postJson(this.apiKey, '/api/v1/profiler/address/related-wallets', {
      chain,
      address,
      pagination: { page: 1, per_page: 100 },
    });
  }

  transactions(chain: Chain, address: string, context: NansenRequestContext): Promise<NansenResult> {
    return postJson(this.apiKey, '/api/v1/profiler/address/transactions', {
      chain,
      address,
      date: context.date ?? defaultDate(),
      hide_spam_token: true,
      pagination: { page: 1, per_page: 100 },
    });
  }

  transactionLookup(
    chain: Chain,
    transactionHash: string,
    blockTimestamp: string,
    _context: NansenRequestContext,
  ): Promise<NansenResult> {
    return postJson(this.apiKey, '/api/v1/transaction-with-token-transfer-lookup', {
      chain,
      transaction_hash: transactionHash,
      block_timestamp: blockTimestamp,
    });
  }
}
