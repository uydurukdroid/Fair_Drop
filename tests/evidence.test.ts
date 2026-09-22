import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEvidence } from '../server/domain/evidence/rules.ts';
import { syntheticAddresses, syntheticCsv, syntheticObservations } from '../fixtures/synthetic/observations.ts';
import type { Recipient } from '../shared/types.ts';

const recipients: Recipient[] = [syntheticAddresses.alpha, syntheticAddresses.beta, syntheticAddresses.gamma].map(
  (address, index) => ({
    id: `recipient-${index + 1}`,
    sourceRow: index + 2,
    chain: 'base',
    address,
    normalizedAddress: address,
    weightUnits: 1n,
    weightText: '1',
  }),
);

describe('evidence rules', () => {
  it('ships a live feature-tour fixture with duplicate and zero-weight rows', () => {
    const csv = readFileSync(new URL('../fixtures/demo/fairdrop-feature-tour.csv', import.meta.url), 'utf8');
    assert.match(csv, /0x4200000000000000000000000000000000000016/);
    assert.equal(
      csv.split('\n').filter((line) => line.includes('0x4200000000000000000000000000000000000016')).length,
      2,
    );
    assert.match(csv, /0x4200000000000000000000000000000000000010,1/);
    assert.match(csv, /0x4200000000000000000000000000000000000006,0/);
  });

  it('suggests a pair with three evidence categories and seven distinct transactions', () => {
    const graph = deriveEvidence(recipients, syntheticObservations, new Set([syntheticAddresses.router]));
    const pair = graph.edges.find((edge) => edge.suggested);
    assert.ok(pair);
    assert.equal(pair?.distinctTransactions, 7);
    assert.deepEqual(pair?.categories.sort(), ['coordinated_behavior', 'direct_recipient', 'shared_funding']);
  });

  it('does not suggest a service hub as shared-owner evidence', () => {
    const graph = deriveEvidence(recipients, syntheticObservations, new Set([syntheticAddresses.router]));
    assert.equal(
      graph.edges.some((edge) => edge.from === 'recipient-1' && edge.to === 'recipient-3'),
      false,
    );
  });

  it('does not turn a weak bridge into a transitive suggestion', () => {
    const weak = syntheticObservations.filter((observation) => observation.id.startsWith('synthetic-direct-1'));
    const graph = deriveEvidence(recipients, weak);
    assert.equal(graph.groups.length, 0);
  });

  it('suggests repeated verified direct transfers as a live review cue', () => {
    const graph = deriveEvidence(
      recipients.slice(0, 2),
      Array.from({ length: 3 }, (_, index) => ({
        id: `live-direct-${index + 1}`,
        chain: 'base' as const,
        from: syntheticAddresses.alpha,
        to: syntheticAddresses.beta,
        transactionHash: `0x${String(index + 1).repeat(64)}`,
        blockTimestamp: `2026-09-22T10:0${index}:00.000Z`,
        category: 'direct_recipient' as const,
        verified: true,
        source: 'nansen.transaction-lookup',
      })),
    );
    assert.equal(graph.groups.length, 1);
    assert.deepEqual(graph.edges[0]?.categories.sort(), ['coordinated_behavior', 'direct_recipient']);
  });
});
