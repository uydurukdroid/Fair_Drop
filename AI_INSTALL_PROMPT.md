# AI installation and verification prompt

You are setting up the FairDrop application from this repository. Work only inside the repository and keep the implementation focused on FairDrop. Do not add unrelated files, provider secrets, or other products.

## Required environment

- Node.js 24 LTS
- npm
- A local shell with permission to install dependencies in this repository

## Setup

Run these commands from the repository root:

```sh
npm ci
cp .env.example .env
npm run doctor
npm run db:migrate
```

Keep `.env` local. The submission setup uses `DATA_MODE=live`; add an approved `NANSEN_API_KEY` to the local `.env` file before recording. Set `DATA_MODE=synthetic` only when intentionally running the offline guided demo.

## Verify the application

Run every check below and stop to diagnose any failure:

```sh
npm run typecheck
npm test
npm run build
npm run format:check
npm run doctor
```

Start the application with:

```sh
npm run dev
```

Confirm that `http://127.0.0.1:8313` loads and that:

```sh
curl -fsS http://127.0.0.1:8413/healthz
```

returns JSON with `"ok":true`.

## Functional smoke test

In the browser:

1. Upload `fixtures/demo/fairdrop-feature-tour.csv` through the CSV picker. It uses public Base addresses, includes a duplicate and a zero-weight row, and must keep live provider mode.
2. Validate the import and select `Keep first` or `Sum weights` when the duplicate prompt appears.
3. Run analysis and confirm the status says `LIVE PROVIDER` before waiting for the evidence view.
4. Review the live provider observations, then continue to allocation.
5. Recalculate the scenario with the default caps.
6. Download both the CSV distribution and JSON manifest.

The **Take guided tour (synthetic)** button is the only UI path that uses the synthetic fixture. Do not use it for a live submission recording.

The application must retain every imported recipient, preserve integer accounting, and keep the allocation invariant:

```text
sum(recipient allocations) + unallocated_reserve == budget
```

## Completion rules

Report the Node.js version, the result of each verification command, the local URLs, and any unresolved issue. Do not commit `.env`, SQLite files, `dist/`, `node_modules/`, `usage.csv`, wallet lists from a real campaign, or provider credentials. Do not add files that are not required by the application, tests, setup, or this prompt.
