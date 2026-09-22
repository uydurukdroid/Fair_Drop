import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDuplicates, validateImport } from '../server/domain/import.ts';

const a = '0x0000000000000000000000000000000000000001';
const b = '0x0000000000000000000000000000000000000002';

describe('CSV import', () => {
  it('requires an explicit duplicate policy and can sum weights', () => {
    const preview = validateImport(`chain,address,weight\nbase,${a},1\nbase,${a.toUpperCase()},2\nbase,${b},0\n`);
    assert.equal(preview.duplicates.length, 1);
    assert.equal(resolveDuplicates(preview, 'keep-first')[0]?.weightUnits, 1_000_000n);
    assert.equal(resolveDuplicates(preview, 'sum-weights')[0]?.weightUnits, 3_000_000n);
  });

  it('rejects malformed addresses and unsupported chains', () => {
    const preview = validateImport('chain,address,weight\nethereum,0x123,1\n');
    assert.deepEqual(
      preview.issues.map((issue) => issue.code),
      ['unsupported_chain', 'invalid_address'],
    );
  });

  it('defaults omitted weight to one and retains zero weights', () => {
    const preview = validateImport(`chain,address,weight\nbase,${a},\nbase,${b},0\n`);
    assert.equal(preview.issues.length, 0);
    assert.equal(preview.recipients[0]?.weightUnits, 1_000_000n);
    assert.equal(preview.recipients[1]?.weightUnits, 0n);
  });

  it('uses configurable row limits instead of a hard-coded 200-row cap', () => {
    const previous = process.env.MAX_CAMPAIGN_WALLETS;
    process.env.MAX_CAMPAIGN_WALLETS = '2';
    try {
      assert.throws(
        () =>
          validateImport(
            `chain,address,weight\nbase,${a},1\nbase,${b},1\nbase,0x0000000000000000000000000000000000000003,1\n`,
          ),
        /more than 2 recipients/,
      );
    } finally {
      if (previous === undefined) delete process.env.MAX_CAMPAIGN_WALLETS;
      else process.env.MAX_CAMPAIGN_WALLETS = previous;
    }
  });
});
