import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analysisRecipientLimit, configuredAnalysisMode } from '../server/jobs/enrichment.ts';

describe('analysis mode defaults', () => {
  it('uses bounded live analysis unless synthetic mode is explicitly configured', () => {
    const previousMode = process.env.DATA_MODE;
    const previousLimit = process.env.MAX_ANALYSIS_WALLETS;
    delete process.env.DATA_MODE;
    process.env.MAX_ANALYSIS_WALLETS = '200';
    try {
      assert.equal(configuredAnalysisMode(), 'live');
      assert.equal(analysisRecipientLimit(250), 200);
      assert.equal(analysisRecipientLimit(250, 'live'), 200);
    } finally {
      if (previousMode === undefined) delete process.env.DATA_MODE;
      else process.env.DATA_MODE = previousMode;
      if (previousLimit === undefined) delete process.env.MAX_ANALYSIS_WALLETS;
      else process.env.MAX_ANALYSIS_WALLETS = previousLimit;
    }
  });

  it('keeps synthetic mode available only when selected explicitly', () => {
    const previousMode = process.env.DATA_MODE;
    process.env.DATA_MODE = 'synthetic';
    try {
      assert.equal(configuredAnalysisMode(), 'synthetic');
      assert.equal(analysisRecipientLimit(250), 250);
      assert.equal(analysisRecipientLimit(250, 'live'), 200);
    } finally {
      if (previousMode === undefined) delete process.env.DATA_MODE;
      else process.env.DATA_MODE = previousMode;
    }
  });
});
