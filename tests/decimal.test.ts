import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAmountInput, formatDisplayMinorUnits, parseDisplayMinorUnits } from '../shared/decimal.ts';

describe('human-readable amounts', () => {
  it('round-trips commas and decimal points without floating point math', () => {
    const minor = parseDisplayMinorUnits('10,000.50');
    assert.equal(minor, 10_000_500_000n);
    assert.equal(formatDisplayMinorUnits(minor), '10,000.5');
  });

  it('supports exact six-decimal amounts', () => {
    assert.equal(parseDisplayMinorUnits('0.000001'), 1n);
    assert.equal(formatDisplayMinorUnits(1n), '0.000001');
  });

  it('formats the field while a person types', () => {
    assert.equal(formatAmountInput('1000'), '1,000');
    assert.equal(formatAmountInput('1000000.5'), '1,000,000.5');
    assert.equal(formatAmountInput('10,000.'), '10,000.');
  });

  it('rejects malformed grouping and excessive precision', () => {
    assert.throws(() => parseDisplayMinorUnits('10,00.50'), /Enter an amount/);
    assert.throws(() => parseDisplayMinorUnits('1.0000001'), /Enter an amount/);
  });
});
