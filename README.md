# FairDrop

FairDrop is a local organizer workspace for reviewing relationships among eligible Base wallets and calculating a reproducible, fixed-budget rewards allocation. It retains every imported recipient, keeps review decisions explicit, and exports an auditable CSV plus JSON manifest.

## 1. Setup

Requires Node.js 24 LTS and npm.

```sh
npm ci
cp .env.example .env
npm run doctor
npm run db:migrate
npm run dev
```

Open `http://127.0.0.1:8313`. The API runs at `http://127.0.0.1:8413`; `GET /healthz` is its health check. The default `DATA_MODE=live` uses bounded provider analysis and requires a local `NANSEN_API_KEY`. Set `DATA_MODE=synthetic` only for the offline guided demo.

## 2. Verification

```sh
npm run typecheck
npm test
npm run build
npm run format:check
npm run doctor
```

Use `npm run usage:export` to write the private provider-call ledger to `usage.csv`. The generated file is ignored and should stay local.

## 3. Use the app

1. Paste or upload a `chain,address,weight` CSV. Only Base is accepted. Omitted weights default to `1`; zero weights remain in the export.
2. Enter a human-readable reward amount such as `10,000.50`. FairDrop converts it to exact six-decimal minor units internally.
3. Review validation and choose `keep-first` or `sum-weights` when duplicate addresses are present.
4. Run bounded live analysis for an approved recipient list. The checked-in feature-tour CSV uses public Base addresses and includes a duplicate plus a zero-weight row; uploading it keeps live provider analysis active.
5. Review pair-level evidence and choose a grouping policy when a suggestion is presented.
6. Set optional group and wallet caps, recalculate the scenario, and compare baseline versus adjusted amounts.
7. Download the CSV distribution and JSON manifest.

## 4. Allocation guarantees

Budget and allocations use integer minor units. The allocator uses deterministic largest remainders and stable recipient keys for ties. It enforces:

```text
sum(recipient allocations) + unallocated_reserve == budget
allocation >= 0
group and individual caps hold
every imported recipient appears exactly once
```

The baseline remains unchanged by review. Each scenario is saved as a new allocation revision.

## 5. Repository map

| Path | Purpose |
| --- | --- |
| `web/` | React import, evidence, review, allocation, and export screens |
| `server/` | Fastify API, SQLite persistence, analysis jobs, provider adapter, and serializers |
| `shared/` | Shared types and exact decimal helpers |
| `fixtures/` | Synthetic tutorial evidence and the public live feature-tour CSV |
| `tests/` | Allocation, import, evidence, export, decimal, and provider-normalization tests |
| `scripts/` | Environment diagnostics and private usage export |

## 6. API

The API provides campaign import and confirmation, analysis jobs, evidence graphs, review decisions, allocation scenarios, CSV and JSON exports, campaign deletion, and `GET /healthz`. The browser sends an `x-fairdrop-session` header so local campaign data stays scoped to the current browser session.

## 7. Privacy and configuration

Campaigns and raw provider payloads remain in the local SQLite database. Never commit `.env`, API keys, wallet credentials, real recipient lists, provider archives, or generated exports. Live provider usage is bounded and recorded for local reconciliation. Synthetic mode is available only when explicitly selected for offline development.
