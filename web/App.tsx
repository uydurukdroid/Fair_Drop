import { useEffect, useMemo, useRef, useState } from 'react';
import { syntheticCsv, syntheticAddresses } from '../fixtures/synthetic/observations.ts';
import liveFeatureTourCsv from '../fixtures/demo/fairdrop-feature-tour.csv?raw';
import { formatAmountInput, formatDisplayMinorUnits, parseDisplayMinorUnits } from '../shared/decimal.ts';

const API = `http://127.0.0.1:${import.meta.env.VITE_API_PORT ?? '8413'}`;
const fallbackBudgetMinor = '10000000000';
const budgetStorageKey = 'fairdrop-budget-input';

function formatMinor(value: string, precision = 6): string {
  return formatDisplayMinorUnits(BigInt(value), precision);
}

function parseAmount(value: string, precision = 6): string {
  return parseDisplayMinorUnits(value, precision).toString();
}

function suggestedGroupCapInput(budgetMinor: string, precision = 6): string {
  const budget = BigInt(budgetMinor);
  const conventionalCap = parseDisplayMinorUnits('300', precision);
  const proportionalCap = (budget * 30n) / 100n;
  const suggested = proportionalCap > 0n && proportionalCap < conventionalCap ? proportionalCap : conventionalCap;
  return formatMinor((suggested > budget ? budget : suggested).toString(), precision);
}

function friendlyRequestError(error: unknown): string {
  if (!(error instanceof Error)) return 'The request failed. Please check the input and try again.';
  if (/failed to fetch|networkerror|load failed/i.test(error.message)) {
    return `FairDrop could not reach the API at ${API}. Check that the server is running, then try again.`;
  }
  return error.message;
}

function storedBudgetInput(): string {
  try {
    const value = window.localStorage.getItem(budgetStorageKey);
    if (value && /^[\d.,]*$/.test(value)) return value;
  } catch {
    // Storage may be disabled; the configured server default still works.
  }
  return formatMinor(fallbackBudgetMinor);
}

function hasStoredBudgetInput(): boolean {
  try {
    const value = window.localStorage.getItem(budgetStorageKey);
    return Boolean(value && /^[\d.,]*$/.test(value));
  } catch {
    return false;
  }
}

function saveBudgetInput(value: string): void {
  try {
    if (value) window.localStorage.setItem(budgetStorageKey, value);
    else window.localStorage.removeItem(budgetStorageKey);
  } catch {
    // Storage is optional; the current React state remains authoritative.
  }
}

type Campaign = { id: string; budgetMinor: string; unitLabel: string; precision: number; status: string };
type Health = { defaultBudgetMinor?: string };
type AnalysisMode = 'synthetic' | 'live';
type ReviewAction = 'accepted_for_policy' | 'dismissed' | 'split' | 'needs_more_evidence';
type Preview = {
  recipients: Array<{ id: string; address: string; weightText: string; sourceRow: number }>;
  duplicates: Array<{ normalizedAddress: string; rows: number[] }>;
  issues: Array<{ message: string }>;
};
type Coverage = {
  mode?: string;
  importedRecipients?: number;
  analyzedRecipients?: number;
  failedRecipients?: number;
  verificationLookups?: number;
  failures?: string[];
};
type ObservationPreview = {
  id: string;
  from: string;
  to: string;
  relation: string;
  category: string;
  verified: boolean;
  source: string;
  transactionHash: string | null;
};
type ReviewGroup = {
  id: string;
  recipientIds: string[];
  state: string;
  score: number;
  reason: string;
};
type Graph = {
  observations: number;
  observationPreview: ObservationPreview[];
  analysis?: { status: string; stage: string; coverage: Coverage };
  nodes: Array<{ id: string; address: string; kind: string }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    categories: string[];
    score: number;
    distinctTransactions: number;
    suggested: boolean;
    explanation: string;
  }>;
  groups: ReviewGroup[];
};
type Allocation = {
  runId: string;
  result: {
    budgetMinor: string;
    redistributedMinor: string;
    unallocatedReserve: string;
    rows: Array<{
      recipientId: string;
      address: string;
      baselineMinor: string;
      adjustedMinor: string;
      deltaMinor: string;
      groupId: string;
      reason: string;
    }>;
  };
};

function walletLabel(address: string): string {
  const demoEntry = Object.entries(syntheticAddresses).find(
    ([, value]) => value.toLowerCase() === address.toLowerCase(),
  );
  const demoName = demoEntry?.[0];
  if (demoName) return `${demoName[0]?.toUpperCase() ?? ''}${demoName.slice(1)}`;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function graphWalletLabel(graph: Graph | null | undefined, id: string): string {
  const node = graph?.nodes.find((candidate) => candidate.id === id);
  return walletLabel(node?.address ?? id);
}

function decisionButtonClass(currentState: string | undefined, action: ReviewAction): string {
  return currentState === action ? 'primary decision-selected' : 'secondary';
}

function DecisionButtons({
  group,
  busy,
  onReview,
}: {
  group?: ReviewGroup;
  busy: boolean;
  onReview: (action: ReviewAction, group: ReviewGroup) => void;
}) {
  const currentState = group?.state;
  return (
    <div className="decision-grid">
      <button
        className={decisionButtonClass(currentState, 'accepted_for_policy')}
        aria-pressed={currentState === 'accepted_for_policy'}
        disabled={busy || !group}
        onClick={() => group && onReview('accepted_for_policy', group)}
      >
        Group them for policy
        <small>Apply one combined cap in the next step</small>
      </button>
      <button
        className={decisionButtonClass(currentState, 'dismissed')}
        aria-pressed={currentState === 'dismissed'}
        disabled={busy || !group}
        onClick={() => group && onReview('dismissed', group)}
      >
        Keep them separate
        <small>Use the normal baseline for each wallet</small>
      </button>
      <button
        className={decisionButtonClass(currentState, 'split')}
        aria-pressed={currentState === 'split'}
        disabled={busy || !group}
        onClick={() => group && onReview('split', group)}
      >
        Split this review set
        <small>Do not apply one shared group policy</small>
      </button>
      <button
        className={decisionButtonClass(currentState, 'needs_more_evidence')}
        aria-pressed={currentState === 'needs_more_evidence'}
        disabled={busy || !group}
        onClick={() => group && onReview('needs_more_evidence', group)}
      >
        Need more evidence
        <small>Pause the grouping decision for now</small>
      </button>
    </div>
  );
}

function sessionHeaders(): Record<string, string> {
  const existing = window.localStorage.getItem('fairdrop-session');
  const session = existing || crypto.randomUUID();
  window.localStorage.setItem('fairdrop-session', session);
  return { 'content-type': 'application/json', 'x-fairdrop-session': session };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...sessionHeaders(), ...(init.headers ?? {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const summary = typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status})`;
    const issues = Array.isArray(payload?.preview?.issues)
      ? payload.preview.issues
          .map((issue: { row?: number; message?: string }) =>
            issue.row && issue.row > 0 ? `Row ${issue.row}: ${issue.message ?? 'Invalid value'}` : issue.message,
          )
          .filter(Boolean)
      : [];
    throw new Error(issues.length > 0 ? `${summary}. ${issues.join(' ')}` : summary);
  }
  return payload as T;
}

async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API}${path}`, { headers: sessionHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Step({ number, title, active, done }: { number: string; title: string; active?: boolean; done?: boolean }) {
  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <span>{done ? '✓' : number}</span>
      <strong>{title}</strong>
    </div>
  );
}

export default function App() {
  const [csv, setCsv] = useState(liveFeatureTourCsv);
  const [fileName, setFileName] = useState('');
  const [defaultBudget, setDefaultBudget] = useState(fallbackBudgetMinor);
  const [budgetInput, setBudgetInput] = useState(storedBudgetInput);
  const [unitLabel, setUnitLabel] = useState('USDC units');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [allocationStatus, setAllocationStatus] = useState('');
  const [groupCapInput, setGroupCapInput] = useState(() => suggestedGroupCapInput(fallbackBudgetMinor));
  const [individualCapInput, setIndividualCapInput] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('live');
  const [reviewStatus, setReviewStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'import' | 'evidence' | 'allocation'>('import');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvTextAreaRef = useRef<HTMLTextAreaElement>(null);

  const suggestedGroup = useMemo(() => graph?.groups.find((group) => group.state === 'suggested'), [graph]);
  const reviewedGroup = useMemo(() => graph?.groups.find((group) => group.state !== 'suggested'), [graph]);
  const primaryReviewGroup = suggestedGroup ?? reviewedGroup;
  const reviewGroups = useMemo(() => graph?.groups ?? [], [graph]);
  const acceptedGroupCount = useMemo(
    () => graph?.groups.filter((group) => group.state === 'accepted_for_policy').length ?? 0,
    [graph],
  );
  const allocationPolicy = useMemo(() => {
    if (reviewedGroup?.state === 'accepted_for_policy') {
      return {
        label: 'Group them for policy',
        description: 'This accepted review set can share one combined cap below.',
      };
    }
    if (reviewedGroup?.state === 'dismissed') {
      return {
        label: 'Keep them separate',
        description: 'The review cue is dismissed; each wallet uses the normal baseline policy.',
      };
    }
    if (reviewedGroup?.state === 'split') {
      return {
        label: 'Split this review set',
        description: 'The review set is intentionally split; each wallet uses the normal baseline policy.',
      };
    }
    return {
      label: 'Baseline policy',
      description: 'No grouping policy is applied. Each wallet is allocated independently by weight.',
    };
  }, [reviewedGroup]);
  const evidenceComplete = jobStatus.startsWith('evidence-ready');

  const chooseAnalysisMode = (mode: AnalysisMode) => {
    setAnalysisMode(mode);
  };

  const loadCsvContents = (contents: string, sourceName = '', mode?: AnalysisMode) => {
    setCsv(contents);
    setFileName(sourceName);
    chooseAnalysisMode(mode ?? 'live');
    setPreview(null);
    setCampaign(null);
    setGraph(null);
    setAllocation(null);
    setAllocationStatus('');
    setJobStatus('');
    setReviewStatus('');
    setError('');
    setTab('import');
  };

  const loadCsvFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      setError('Please choose a .csv file.');
      return;
    }
    try {
      const contents = await file.text();
      if (!contents.trim()) throw new Error('The selected CSV file is empty.');
      loadCsvContents(contents, file.name);
    } catch (fileError) {
      setError(friendlyRequestError(fileError));
    }
  };

  const updateBudget = (value: string) => {
    const formatted = formatAmountInput(value);
    setBudgetInput(formatted);
    saveBudgetInput(formatted);
    setError('');
  };

  const focusCsvInput = () => {
    setTab('import');
    window.setTimeout(() => csvTextAreaRef.current?.focus(), 0);
  };

  const importCampaign = async () => {
    setBusy(true);
    setError('');
    setPreview(null);
    setCampaign(null);
    setGraph(null);
    setAllocation(null);
    setAllocationStatus('');
    setJobStatus('');
    try {
      const budgetMinor = parseAmount(budgetInput);
      const response = await api<{
        id: string;
        budgetMinor: string;
        unitLabel: string;
        precision: number;
        preview: Preview;
        needsDuplicateDecision: boolean;
      }>('/api/campaigns/import', {
        method: 'POST',
        body: JSON.stringify({ csv, budgetMinor, unitLabel, precision: 6 }),
      });
      setPreview(response.preview);
      updateBudget(formatMinor(response.budgetMinor, response.precision));
      setGroupCapInput(suggestedGroupCapInput(response.budgetMinor, response.precision));
      setUnitLabel(response.unitLabel);
      setCampaign({
        id: response.id,
        budgetMinor: response.budgetMinor,
        unitLabel: response.unitLabel,
        precision: response.precision,
        status: 'draft',
      });
      if (response.needsDuplicateDecision) setError('Choose how to handle duplicates before continuing.');
      else await confirmImport(response.id, 'keep-first');
    } catch (requestError) {
      setError(friendlyRequestError(requestError));
    } finally {
      setBusy(false);
    }
  };

  const resetWorkspace = () => {
    setCsv(liveFeatureTourCsv);
    setFileName('');
    saveBudgetInput('');
    setBudgetInput(formatMinor(defaultBudget));
    setUnitLabel('USDC units');
    setPreview(null);
    setCampaign(null);
    setGraph(null);
    setAllocation(null);
    setAllocationStatus('');
    setGroupCapInput(suggestedGroupCapInput(defaultBudget));
    setIndividualCapInput('');
    setJobStatus('');
    setReviewStatus('');
    chooseAnalysisMode('live');
    setBusy(false);
    setError('');
    setTab('import');
  };

  const confirmImport = async (id = campaign?.id, duplicatePolicy: 'keep-first' | 'sum-weights' = 'keep-first') => {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/campaigns/${id}/confirm-import`, { method: 'POST', body: JSON.stringify({ duplicatePolicy }) });
      setCampaign((current) => (current ? { ...current, status: 'ready' } : current));
      setTab('evidence');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Confirmation failed');
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    if (!campaign) return;
    setBusy(true);
    setError('');
    setJobStatus('Starting bounded analysis…');
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/campaigns/${campaign.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({ mode: analysisMode }),
      });
      const poll = async (): Promise<void> => {
        const job = await api<{ status: string; stage: string; completed: number; total: number; error?: string }>(
          `/api/jobs/${jobId}`,
        );
        setJobStatus(`${job.stage} · ${job.completed}/${job.total}`);
        if (job.status === 'complete') {
          setJobStatus(`evidence-ready · ${job.completed}/${job.total}`);
          const nextGraph = await api<Graph>(`/api/campaigns/${campaign.id}/graph`);
          setGraph(nextGraph);
          setTab('evidence');
          setBusy(false);
          return;
        }
        if (job.status === 'failed') throw new Error(job.error ?? 'Analysis failed');
        window.setTimeout(() => void poll(), 1000);
      };
      await poll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Analysis failed');
      setBusy(false);
    }
  };

  const review = async (action: ReviewAction, selectedGroup?: ReviewGroup) => {
    const reviewGroup = selectedGroup ?? suggestedGroup ?? reviewedGroup;
    if (!campaign || !reviewGroup) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/campaigns/${campaign.id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          groupId: reviewGroup.id,
          action,
          reason:
            action === 'accepted_for_policy'
              ? `Reviewed ${analysisMode} evidence and accepted the group for campaign policy`
              : action === 'needs_more_evidence'
                ? 'Organizer requested more evidence before applying a group policy'
                : action === 'split'
                  ? 'Organizer chose to keep this review set separate'
                  : 'Organizer kept the wallets separate; evidence remains contextual',
        }),
      });
      const nextGraph = await api<Graph>(`/api/campaigns/${campaign.id}/graph`);
      setGraph(nextGraph);
      setAllocation(null);
      setAllocationStatus('');
      if (action === 'accepted_for_policy') {
        setReviewStatus('Group accepted for this campaign. Set a combined cap, then continue to allocation.');
      } else {
        setReviewStatus(
          action === 'needs_more_evidence'
            ? 'More evidence requested. The group will not change rewards until you accept it.'
            : 'These wallets will remain separate for this campaign. You can continue with the baseline allocation.',
        );
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  };

  const calculate = async () => {
    if (!campaign) return;
    setBusy(true);
    setError('');
    setAllocationStatus('Calculating scenario…');
    try {
      const groupCapMinor = groupCapInput.trim() ? parseAmount(groupCapInput, campaign.precision) : undefined;
      const individualCapMinor = individualCapInput.trim()
        ? parseAmount(individualCapInput, campaign.precision)
        : undefined;
      const next = await api<Allocation>(`/api/campaigns/${campaign.id}/allocations`, {
        method: 'POST',
        body: JSON.stringify({ groupCapMinor, individualCapMinor }),
      });
      setAllocation(next);
      const changedRows = next.result.rows.some((row) => row.deltaMinor !== '0');
      if (acceptedGroupCount > 0) {
        const capDescription =
          groupCapMinor === undefined
            ? 'no group cap'
            : `${formatMinor(groupCapMinor, campaign.precision)} ${unitLabel}`;
        setAllocationStatus(
          changedRows
            ? `Scenario recalculated with ${acceptedGroupCount} accepted group${acceptedGroupCount === 1 ? '' : 's'} capped at ${capDescription}.`
            : `Group policy is active, but the ${capDescription} cap does not bind at this budget. Choose a lower cap to change proportions.`,
        );
      } else if (individualCapMinor !== undefined) {
        setAllocationStatus('Scenario recalculated with an individual wallet cap.');
      } else {
        setAllocationStatus(
          'Scenario recalculated. Separate and split policies intentionally use the baseline proportions because no group cap is applied.',
        );
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Allocation failed');
      setAllocationStatus('');
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async (kind: 'csv' | 'json') => {
    if (!campaign || busy) return;
    setBusy(true);
    setError('');
    try {
      await downloadFile(
        kind === 'json'
          ? `/api/allocations/${campaign.id}/manifest.json`
          : `/api/allocations/${campaign.id}/export.csv`,
        `fairdrop-${campaign.id}.${kind}`,
      );
      setAllocationStatus(`${kind.toUpperCase()} export downloaded successfully.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void fetch(`${API}/healthz`)
      .then((response) => response.json() as Promise<Health>)
      .then((health) => {
        if (health.defaultBudgetMinor && /^\d+$/.test(health.defaultBudgetMinor)) {
          setDefaultBudget(health.defaultBudgetMinor);
          if (!hasStoredBudgetInput()) {
            setBudgetInput(formatMinor(health.defaultBudgetMinor));
            setGroupCapInput(suggestedGroupCapInput(health.defaultBudgetMinor));
          }
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const preventBrowserFileNavigation = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', preventBrowserFileNavigation);
    window.addEventListener('drop', preventBrowserFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventBrowserFileNavigation);
      window.removeEventListener('drop', preventBrowserFileNavigation);
    };
  }, []);

  useEffect(() => {
    if (campaign?.status === 'ready' && !graph) void analyze();
  }, [campaign?.status]);

  return (
    <main className="shell">
      <header className="topbar">
        <button
          className="brand brand-button"
          type="button"
          onClick={resetWorkspace}
          aria-label="Reset FairDrop workspace"
        >
          <span className="mark">F</span>
          <span>FairDrop</span>
          <small>evidence → allocation</small>
        </button>
        <div className={`mode ${analysisMode === 'live' ? 'live-mode' : ''}`}>
          <span className="pulse" /> {analysisMode === 'live' ? 'LIVE PROVIDER' : 'GUIDED DEMO'}{' '}
          <span className="divider" /> Base
        </div>
        <button className="restart-button" type="button" onClick={resetWorkspace}>
          Start over
        </button>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">COMMUNITY REWARDS / REVIEW WORKSPACE</p>
          <h1>
            Make every allocation
            <br />
            <em>explainable.</em>
          </h1>
          <p className="lede">
            Inspect wallet relationships, make an explicit policy decision, and export a distribution you can replay.
          </p>
        </div>
        <div className="hero-note">
          <span className="note-line" /> <strong>No identity claims.</strong>
          <br />
          Evidence is a review cue, not proof of ownership or fraud.
        </div>
      </section>

      <nav className="steps" aria-label="Campaign steps">
        <Step number="01" title="Import" active={tab === 'import'} done={Boolean(campaign)} />
        <i />
        <Step number="02" title="Inspect evidence" active={tab === 'evidence'} done={Boolean(graph)} />
        <i />
        <Step number="03" title="Shape allocation" active={tab === 'allocation'} done={Boolean(allocation)} />
        <i />
        <Step number="04" title="Export" />
      </nav>

      {error && (
        <div className="alert" role="alert">
          <span>!</span>
          <div className="alert-message">{error}</div>
          <div className="alert-actions">
            {tab === 'import' && (
              <button className="alert-action" type="button" onClick={focusCsvInput}>
                Edit CSV
              </button>
            )}
            <button className="alert-action" type="button" onClick={resetWorkspace}>
              Start over
            </button>
          </div>
        </div>
      )}
      {jobStatus && (
        <div className={`status-line ${evidenceComplete ? 'complete' : ''}`}>
          <span className={evidenceComplete ? 'status-check' : 'spinner'}>{evidenceComplete ? '✓' : ''}</span>
          {jobStatus}
        </div>
      )}
      {reviewStatus && tab === 'evidence' && (
        <p className="review-status" role="status">
          {reviewStatus}
        </p>
      )}

      {tab === 'import' && (
        <section className="workspace two-col">
          <div className="card import-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">STEP 01 / SOURCE LIST</p>
                <h2>Bring your eligible wallets</h2>
              </div>
              <span className="badge">CSV · max 25,000</span>
            </div>
            {analysisMode === 'synthetic' && csv === syntheticCsv && (
              <p className="import-mode-note">
                Full feature tour selected. Alpha and Beta show direct transfers, a shared funder, and repeated
                coordinated activity; Gamma touches a router only; Delta is independent; Zero has zero weight. This demo
                uses no provider credits.
              </p>
            )}
            {analysisMode === 'live' && csv === liveFeatureTourCsv && (
              <p className="import-mode-note">
                Live provider mode is active. This public feature-tour CSV includes a duplicate and a zero-weight row;
                analysis, evidence, allocation, and exports use the configured provider.
              </p>
            )}
            <div
              className={`dropzone ${dragActive ? 'drag-active' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                void loadCsvFile(event.dataTransfer.files?.[0]);
              }}
            >
              <span className="upload-icon">↑</span>
              <strong>{dragActive ? 'Release to load the CSV' : 'Drop a CSV here'}</strong>
              <span>or browse for a file, or paste a list below</span>
              <div className="import-actions">
                <button className="secondary browse-button" type="button" onClick={() => fileInputRef.current?.click()}>
                  Browse CSV
                </button>
                <button
                  className="text-button demo-button"
                  type="button"
                  onClick={() => loadCsvContents(syntheticCsv, 'Guided relationship demo', 'synthetic')}
                >
                  Take guided tour (synthetic)
                </button>
                <button
                  className="text-button live-fixture-button"
                  type="button"
                  onClick={() => loadCsvContents(liveFeatureTourCsv, 'fairdrop-feature-tour.csv', 'live')}
                >
                  Use live feature-tour CSV
                </button>
              </div>
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void loadCsvFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <small>chain,address,weight</small>
              <textarea
                ref={csvTextAreaRef}
                value={csv}
                onChange={(event) => {
                  setCsv(event.target.value);
                  setFileName('');
                  chooseAnalysisMode('live');
                  setError('');
                }}
                aria-label="Recipient CSV"
              />
              {fileName && <small className="file-name">Loaded: {fileName}</small>}
            </div>
            <div className="form-row">
              <label>
                <span>
                  Reward budget <i>{unitLabel}; . decimals, , thousands</i>
                </span>
                <input
                  value={budgetInput}
                  onChange={(event) => updateBudget(event.target.value)}
                  inputMode="decimal"
                  placeholder="10,000.00"
                  aria-label={`Reward budget in ${unitLabel}`}
                />
              </label>
              <label>
                <span>Unit label</span>
                <input
                  value={unitLabel}
                  onChange={(event) => {
                    setUnitLabel(event.target.value);
                    setError('');
                  }}
                />
              </label>
            </div>
            <p className="budget-help">
              Enter the reward amount people understand: for example, <strong>10,000.50</strong> means 10,000.50{' '}
              {unitLabel}. The configured starting value is {formatMinor(defaultBudget)} {unitLabel}. Exact six-decimal
              accounting happens behind the scenes. Your value is saved in this browser and locked when you validate;
              use Edit import, then Validate import, to change it.
            </p>
            <button className="primary" disabled={busy || !csv || !budgetInput} onClick={() => void importCampaign()}>
              {busy ? 'Preparing…' : 'Validate import'} <span>→</span>
            </button>
            {error && !campaign && (
              <div className="import-error" role="alert">
                <strong>We could not validate this CSV.</strong>
                <span>{error}</span>
                <small>Fix the row or address above, then press Validate import again.</small>
              </div>
            )}
            {preview && campaign && preview.duplicates.length > 0 && (
              <div className="duplicate-panel">
                <div>
                  <strong>Duplicate addresses found</strong>
                  <span>
                    {preview.duplicates.map((duplicate) => duplicate.rows.join(' + ')).join(' · ')} · choose a policy
                  </span>
                </div>
                <div className="review-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void confirmImport(campaign.id, 'keep-first')}
                  >
                    Keep first
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void confirmImport(campaign.id, 'sum-weights')}
                  >
                    Sum weights <span>→</span>
                  </button>
                </div>
              </div>
            )}
          </div>
          <aside className="side-stack">
            <div className="card rule-card">
              <p className="eyebrow">BEFORE ANALYSIS</p>
              <h3>What FairDrop keeps visible</h3>
              <ul>
                <li>Every input row, including zero-weight wallets</li>
                <li>Exact UTC cutoff and provider coverage</li>
                <li>Baseline allocation before any review</li>
                <li>Reasons and deltas in the final export</li>
              </ul>
            </div>
            <div className="quote-card">
              <span>“</span>
              <p>A shared exchange, router, or funder is context—not a verdict.</p>
            </div>
          </aside>
        </section>
      )}

      {tab === 'evidence' && (
        <section className="workspace evidence-layout">
          <div className="card graph-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">STEP 02 / EVIDENCE MAP</p>
                <h2>Relationships, with receipts</h2>
              </div>
              <span className="badge blue">{graph?.observations ?? 0} observations</span>
            </div>
            <div className="evidence-summary">
              <div>
                <small>Analysis</small>
                <strong>{graph?.analysis?.status === 'complete' ? 'Complete' : 'Waiting'}</strong>
              </div>
              <div>
                <small>Wallets</small>
                <strong>
                  {graph?.analysis?.coverage.analyzedRecipients ?? 0}/
                  {graph?.analysis?.coverage.importedRecipients ?? 0}
                </strong>
              </div>
              <div>
                <small>Verified lookups</small>
                <strong>{graph?.analysis?.coverage.verificationLookups ?? 0}</strong>
              </div>
              <div>
                <small>Suggestions</small>
                <strong>{graph?.groups.length ?? 0}</strong>
              </div>
            </div>
            <div className="graph-stage">
              <div className="graph-grid" />
              {graph?.nodes
                .filter((node) => node.kind === 'recipient')
                .map((node, index) => (
                  <div className={`node n${index + 1}`} key={node.id}>
                    <span>{walletLabel(node.address)}</span>
                    <b>{index === 0 ? 'A' : index === 1 ? 'B' : index === 2 ? 'C' : 'D'}</b>
                  </div>
                ))}
              {graph?.edges.map((edge) => (
                <div className={`edge-label e${edge.id.slice(-1)}`} key={edge.id}>
                  {edge.suggested ? 'review cue' : 'context only'}
                </div>
              ))}
              <div className="graph-legend">
                <span className="legend-dot recipient" /> eligible recipient <span className="legend-dot context" />{' '}
                contextual node
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th>Evidence categories</th>
                    <th>Txs</th>
                    <th>Score</th>
                    <th>Reading</th>
                  </tr>
                </thead>
                <tbody>
                  {graph?.edges.length ? (
                    graph.edges.map((edge) => (
                      <tr key={edge.id}>
                        <td>
                          {graphWalletLabel(graph, edge.from)} · {graphWalletLabel(graph, edge.to)}
                        </td>
                        <td>{edge.categories.join(' + ')}</td>
                        <td>{edge.distinctTransactions}</td>
                        <td>
                          <span className={`score ${edge.suggested ? 'copper' : ''}`}>{edge.score}</span>
                        </td>
                        <td>{edge.suggested ? 'Suggested review' : 'Context only'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-table">
                          <strong>No eligible-recipient pair was found.</strong>
                          <span>
                            The provider returned {graph?.observations ?? 0} observation
                            {graph?.observations === 1 ? '' : 's'}, but none currently connect two eligible wallets with
                            enough verified evidence for a review cue.
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {graph?.observationPreview.length ? (
              <div className="observation-section">
                <div className="observation-heading">
                  <div>
                    <p className="eyebrow">PROVIDER RECORDS</p>
                    <h3>What was actually observed</h3>
                  </div>
                  <span className="muted">Showing up to 50 records</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>From</th>
                        <th>To</th>
                        <th>Relation</th>
                        <th>Verification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.observationPreview.map((observation) => (
                        <tr key={observation.id}>
                          <td>{walletLabel(observation.from)}</td>
                          <td>{walletLabel(observation.to)}</td>
                          <td>{observation.relation}</td>
                          <td>
                            <span className={`verification ${observation.verified ? 'verified' : ''}`}>
                              {observation.verified ? 'Verified' : 'Context only'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
          <aside className="card review-card">
            <p className="eyebrow">REVIEW PANEL</p>
            <h2>
              {reviewGroups.length > 0
                ? `${reviewGroups.length} suggested group${reviewGroups.length === 1 ? '' : 's'}`
                : 'No suggested group'}
            </h2>
            {suggestedGroup ? (
              <>
                <div className="group-token">
                  {suggestedGroup.recipientIds.length} recipients <span>·</span> score {suggestedGroup.score}
                </div>
                <div className="group-members">
                  <strong>Wallets in this review set</strong>
                  <ul>
                    {suggestedGroup.recipientIds.map((recipientId) => (
                      <li key={recipientId}>{graphWalletLabel(graph, recipientId)}</li>
                    ))}
                  </ul>
                </div>
                <p className="muted">{suggestedGroup.reason}</p>
                <div className="evidence-list">
                  <div>
                    <b>✓</b>
                    <span>
                      Verified transaction evidence
                      <br />
                      <small>actual hashes retained in audit record</small>
                    </span>
                  </div>
                  <div>
                    <b>✓</b>
                    <span>
                      At least two evidence categories
                      <br />
                      <small>pair support remains inspectable</small>
                    </span>
                  </div>
                  <div>
                    <b className="neutral">i</b>
                    <span>
                      Timing is a review cue
                      <br />
                      <small>never identity proof</small>
                    </span>
                  </div>
                </div>
                <div className="decision-box">
                  <strong>How should this affect rewards?</strong>
                  <p>Choose a campaign policy. None of these choices proves that the wallets share an owner.</p>
                  <DecisionButtons
                    group={suggestedGroup}
                    busy={busy}
                    onReview={(action, group) => void review(action, group)}
                  />
                </div>
              </>
            ) : (
              <>
                {reviewedGroup && (
                  <div className="decision-box recorded-decision">
                    <div className="group-token">Decision: {reviewedGroup.state.replaceAll('_', ' ')}</div>
                    <p>Decisions are reversible. Choose a different policy below if your interpretation changes.</p>
                    <DecisionButtons
                      group={reviewedGroup}
                      busy={busy}
                      onReview={(action, group) => void review(action, group)}
                    />
                  </div>
                )}
                <p className="muted">
                  {reviewedGroup
                    ? reviewedGroup.state === 'needs_more_evidence'
                      ? 'More evidence is requested. Allocation is paused until you choose a policy that can be applied to this campaign.'
                      : reviewedGroup.state === 'accepted_for_policy'
                        ? 'This decision is saved. Continue to allocation to set a combined cap and calculate the campaign scenario.'
                        : 'This decision is saved. Continue to allocation to calculate the baseline with these wallets kept separate.'
                    : graph
                      ? `No pair currently meets the review threshold. ${graph.observations} provider observation${graph.observations === 1 ? '' : 's'} remain visible above; this is not proof of independence.`
                      : 'Waiting for the evidence map to finish loading.'}
                </p>
                {graph && !reviewedGroup && !suggestedGroup && analysisMode === 'live' && (
                  <div className="decision-box recorded-decision">
                    <strong>Live result: context found, no safe grouping</strong>
                    <p>
                      The provider returned records, but none verified a relationship between two imported wallets
                      strongly enough for a review cue. That is not proof that the wallets are independent.
                    </p>
                  </div>
                )}
                {graph && (
                  <>
                    {reviewedGroup?.state === 'needs_more_evidence' ? (
                      <p className="muted allocation-next-note">
                        Allocation is paused for this review. Choose Group them for policy, Keep them separate, or Split
                        this review set to continue.
                      </p>
                    ) : (
                      <>
                        <p className="muted allocation-next-note">
                          {reviewedGroup
                            ? 'Your decision is saved. Continue to allocation to calculate the current campaign scenario.'
                            : 'Review is optional. You can still calculate the baseline allocation for every imported wallet.'}
                        </p>
                        <div className="review-actions">
                          <button className="primary" onClick={() => setTab('allocation')}>
                            Continue to allocation <span>→</span>
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {reviewGroups.length > 1 && (
              <div className="additional-review-groups">
                <p className="eyebrow">OTHER REVIEW SETS</p>
                {reviewGroups
                  .filter((group) => group.id !== primaryReviewGroup?.id)
                  .map((group) => (
                    <div className="review-group" key={group.id}>
                      <div className="group-token">
                        {group.recipientIds.length} recipients <span>·</span> score {group.score}
                      </div>
                      <div className="group-members">
                        <strong>Wallets in this review set</strong>
                        <ul>
                          {group.recipientIds.map((recipientId) => (
                            <li key={recipientId}>{graphWalletLabel(graph, recipientId)}</li>
                          ))}
                        </ul>
                      </div>
                      {group.state !== 'suggested' && (
                        <div className="group-decision-label">Decision: {group.state.replaceAll('_', ' ')}</div>
                      )}
                      <p className="muted">{group.reason}</p>
                      <div className="decision-box">
                        <strong>
                          {group.state === 'suggested' ? 'How should this affect rewards?' : 'Change this decision'}
                        </strong>
                        <p>Choose a campaign policy. None of these choices proves that the wallets share an owner.</p>
                        <DecisionButtons
                          group={group}
                          busy={busy}
                          onReview={(action, selectedGroup) => void review(action, selectedGroup)}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <div className="review-footer-actions">
              <button className="text-button" onClick={() => setTab('import')}>
                ← Edit import
              </button>
              <button className="restart-button" type="button" onClick={resetWorkspace}>
                Start over
              </button>
            </div>
          </aside>
        </section>
      )}

      {tab === 'allocation' && (
        <section className="workspace allocation-layout">
          <div className="card allocation-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">STEP 03 / ALLOCATION LAB</p>
                <h2>See the policy consequence</h2>
              </div>
              <span className="badge copper-badge">reversible scenario</span>
            </div>
            <div className="allocation-nav">
              <button className="text-button" type="button" onClick={() => setTab('evidence')}>
                ← Change policy / back to evidence
              </button>
              <button className="text-button" type="button" onClick={() => setTab('import')}>
                Edit import
              </button>
              <button className="restart-button" type="button" onClick={resetWorkspace}>
                Start over
              </button>
            </div>
            <p className="allocation-budget">
              Campaign budget: {formatMinor(campaign?.budgetMinor ?? '0', campaign?.precision ?? 6)}{' '}
              {campaign?.unitLabel}
            </p>
            <div className="allocation-policy" role="status">
              <strong>Policy selected: {allocationPolicy.label}</strong>
              <span>{allocationPolicy.description}</span>
              {reviewedGroup?.state === 'dismissed' || reviewedGroup?.state === 'split' ? (
                <small>The amounts may match because both choices intentionally remove the combined group cap.</small>
              ) : null}
            </div>
            <div className="allocation-decision-box">
              <strong>How should this affect rewards?</strong>
              <span>
                {primaryReviewGroup
                  ? 'Choose a campaign policy. None of these choices proves that the wallets share an owner.'
                  : 'No verified review group is available. The choices stay visible but disabled until evidence supports a review set.'}
              </span>
              <DecisionButtons
                group={primaryReviewGroup}
                busy={busy}
                onReview={(action, group) => void review(action, group)}
              />
            </div>
            <div className="allocation-explainer">
              <strong>Caps change the scenario, not the budget.</strong>
              <span>
                The baseline is calculated first. A cap limits rewards for an accepted group; anything above that limit
                is redistributed to other eligible wallets. A blank cap means no limit.
              </span>
            </div>
            <div className="cap-control">
              <label>
                <span>
                  Group cap <i>combined maximum for one accepted group</i>
                </span>
                <div className="cap-input">
                  <input
                    value={groupCapInput}
                    placeholder="300"
                    onChange={(event) => {
                      setGroupCapInput(formatAmountInput(event.target.value));
                      setError('');
                      if (allocation) setAllocationStatus('Cap changed — recalculate scenario to update the result.');
                    }}
                    inputMode="decimal"
                    aria-label={`Maximum combined reward for an accepted group in ${unitLabel}`}
                  />
                  <span>{unitLabel}</span>
                </div>
              </label>
              <p>
                Example: <strong>300</strong> means all wallets in an accepted group share at most 300 {unitLabel};{' '}
                single wallets are not affected by this field.
              </p>
              <label className="individual-cap-label">
                <span>
                  Optional wallet cap <i>maximum for each wallet</i>
                </span>
                <div className="cap-input">
                  <input
                    value={individualCapInput}
                    placeholder="No limit"
                    onChange={(event) => {
                      setIndividualCapInput(formatAmountInput(event.target.value));
                      setError('');
                      if (allocation)
                        setAllocationStatus('Wallet cap changed — recalculate scenario to update the result.');
                    }}
                    inputMode="decimal"
                    aria-label={`Optional maximum reward per wallet in ${unitLabel}`}
                  />
                  <span>{unitLabel}</span>
                </div>
              </label>
              <p className="cap-steps">
                1. Choose a group policy on the evidence screen. 2. Set a cap here. 3. Recalculate and compare the
                baseline with the adjusted amounts.
              </p>
            </div>
            <button className="primary" disabled={busy} onClick={() => void calculate()}>
              {busy ? 'Calculating…' : 'Recalculate scenario'} <span>→</span>
            </button>
            {allocationStatus && (
              <p className="allocation-status" role="status">
                {allocationStatus}
              </p>
            )}
            {allocation && (
              <>
                <div className="metric-grid">
                  <div>
                    <small>Budget · {campaign?.unitLabel}</small>
                    <strong>{formatMinor(allocation.result.budgetMinor, campaign?.precision ?? 6)}</strong>
                  </div>
                  <div>
                    <small>Redistributed · {campaign?.unitLabel}</small>
                    <strong className="copper-text">
                      {formatMinor(allocation.result.redistributedMinor, campaign?.precision ?? 6)}
                    </strong>
                  </div>
                  <div>
                    <small>Reserve · {campaign?.unitLabel}</small>
                    <strong>{formatMinor(allocation.result.unallocatedReserve, campaign?.precision ?? 6)}</strong>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Recipient</th>
                        <th>Baseline</th>
                        <th>Adjusted</th>
                        <th>Delta</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocation.result.rows.map((row) => (
                        <tr key={row.recipientId}>
                          <td className="address">
                            {row.address.slice(0, 8)}…{row.address.slice(-4)}
                          </td>
                          <td>{formatMinor(row.baselineMinor, campaign?.precision ?? 6)}</td>
                          <td>{formatMinor(row.adjustedMinor, campaign?.precision ?? 6)}</td>
                          <td className={row.deltaMinor.startsWith('-') ? 'negative' : 'positive'}>
                            {row.deltaMinor.startsWith('-') ? '-' : '+'}
                            {formatMinor(row.deltaMinor.replace('-', ''), campaign?.precision ?? 6)}
                          </td>
                          <td>{row.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
          <aside className="side-stack">
            <div className="card export-card">
              <p className="eyebrow">STEP 04 / AUDIT EXPORT</p>
              <h3>Ready to take with you?</h3>
              <p className="muted">Export all recipients, amounts, reasons, coverage, policy, and algorithm version.</p>
              <div className="export-buttons">
                {campaign && allocation ? (
                  <>
                    <a
                      className="download"
                      href={`${API}/api/allocations/${campaign.id}/export.csv`}
                      download
                      aria-disabled={busy}
                      onClick={(event) => {
                        event.preventDefault();
                        void exportFile('csv');
                      }}
                    >
                      CSV distribution <span>↓</span>
                    </a>
                    <a
                      className="download"
                      href={`${API}/api/allocations/${campaign.id}/manifest.json`}
                      download
                      aria-disabled={busy}
                      onClick={(event) => {
                        event.preventDefault();
                        void exportFile('json');
                      }}
                    >
                      JSON manifest <span>↓</span>
                    </a>
                  </>
                ) : (
                  <span className="disabled-download">Run a scenario to unlock exports</span>
                )}
              </div>
            </div>
            <div className="card limit-card">
              <p className="eyebrow">LIMITS THAT MATTER</p>
              <p>Relationship results are current observations. They are not an exhaustive historical map.</p>
              <p>Evidence can change. Old allocation revisions remain immutable.</p>
            </div>
          </aside>
        </section>
      )}

      <footer>
        <span>FairDrop / private organizer workspace</span>
        <span>
          Derived evidence · deterministic integer accounting ·{' '}
          {campaign
            ? `campaign ${campaign.id.slice(0, 8)}`
            : analysisMode === 'live'
              ? 'live provider mode'
              : 'synthetic tutorial'}
        </span>
      </footer>
    </main>
  );
}
