import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelatedWallets, normalizeTransactionLookup, normalizeTransactions } from '../server/nansen/client.ts';

describe('Nansen normalization', () => {
  it('keeps related-wallet observation ids unique per source wallet', () => {
    const result = normalizeRelatedWallets(
      {
        status: 200,
        payload: { data: [{ address: '0x0000000000000000000000000000000000000002' }] },
      },
      '0x0000000000000000000000000000000000000001',
    );
    assert.equal(result[0]?.id, 'nansen-related-0x0000000000000000000000000000000000000001-1');
  });

  it('marks a successful lookup as verified and retains transfer fields', () => {
    const result = normalizeTransactionLookup(
      {
        status: 200,
        payload: {
          data: [
            {
              transaction_hash: '0xabc',
              block_timestamp: '2026-09-20 12:00:00',
              from_address: '0x0000000000000000000000000000000000000001',
              to_address: '0x0000000000000000000000000000000000000002',
              token_address: '0x0000000000000000000000000000000000000003',
            },
          ],
        },
      },
      {
        address: '0x0000000000000000000000000000000000000001',
        transactionHash: '0xabc',
      },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.verified, true);
    assert.equal(result[0]?.transactionHash, '0xabc');
    assert.equal(result[0]?.assetContract, '0x0000000000000000000000000000000000000003');
  });

  it('normalizes provider transaction transfer arrays into recipient observations', () => {
    const result = normalizeTransactions(
      {
        status: 200,
        payload: {
          data: [
            {
              transaction_hash: '0xdef',
              block_timestamp: '2026-09-22T10:00:00Z',
              tokens_received: [
                {
                  from_address: '0x0000000000000000000000000000000000000001',
                  to_address: '0x0000000000000000000000000000000000000002',
                  token_address: '0x0000000000000000000000000000000000000003',
                },
              ],
            },
          ],
        },
      },
      '0x0000000000000000000000000000000000000002',
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.from, '0x0000000000000000000000000000000000000001');
    assert.equal(result[0]?.to, '0x0000000000000000000000000000000000000002');
    assert.equal(result[0]?.direction, 'in');
    assert.equal(result[0]?.verified, true);
  });

  it('normalizes Nansen token_transfer_array lookup responses', () => {
    const result = normalizeTransactionLookup(
      {
        status: 200,
        payload: {
          data: [
            {
              transaction_hash: '0xabc',
              block_timestamp: '2026-09-20 12:00:00',
              from_address: '0x0000000000000000000000000000000000000009',
              to_address: '0x0000000000000000000000000000000000000008',
              token_transfer_array: [
                {
                  from_address: '0x0000000000000000000000000000000000000001',
                  to_address: '0x0000000000000000000000000000000000000002',
                  token_address: '0x0000000000000000000000000000000000000003',
                },
              ],
            },
          ],
        },
      },
      {
        address: '0x0000000000000000000000000000000000000001',
        transactionHash: '0xabc',
      },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.from, '0x0000000000000000000000000000000000000001');
    assert.equal(result[0]?.to, '0x0000000000000000000000000000000000000002');
  });
});
