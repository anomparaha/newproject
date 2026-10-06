# VIN — a cross-border vehicle market

Listings lock to a chassis number, money sits in **escrow**, inspection reports attach to the same
number, and completed deals are recorded as **digital proof that cannot be overwritten**.

> **VIN does not transfer legal ownership.** Title, registration, customs, tax, and re-registration
> stay under the law of the country of origin and the destination country. **The NFT is not a
> vehicle title.** **Vehicle money never runs through a volatile token.** The token is only used for
> bonds and access.

---

## 1. Where this repo stands — what runs and what does not

Stated up front, so nothing here is an overclaim:

**Running and tested in this repo**

- Hono API + `node:sqlite`: actors, corridors, listings, deals, two-leg escrow, inspection reports,
  odometer anomalies, handover, receipts, disputes, arbitration, reputation, corridor metrics.
- **The full flow passes an integration test**: listing → escrow → inspection → report → buyer
  acceptance → handover → vehicle fund release → receipt recorded, plus one **odometer anomaly**
  case that ends in a **dispute** with the **bond slashed** (`npm run seed:reset`).
- **63 tests** (`npm test`): 11 core rules tests (decimal money arithmetic, the state machine,
  release preconditions, odometer anomalies, bond slashing) + **11 property tests** for the escrow
  ledger model (thousands of random combinations: over-release, double refund, an inexact ruling,
  a freeze bypass, and a deal that must complete before a receipt can be recorded) + **19 on-chain
  rule tests** produced by reconciling against the five-contract design spec: the mandatory call
  order (anything out of order is rejected), one deal per VIN, odometer anomalies computed from the
  highest point and not resettable by a lower reading, and the handover confirmation window.
  The remaining 22 cover authentication (SIWS: real ed25519 keypairs, replay, expiry, revocation,
  demo-mode rejection), content-addressed evidence storage, and three anti-regression guards.
- **The Anchor program is compiled and tested in CI**: `anchor build`, the SBF stack-frame gate,
  and `anchor test` (17 tests: 13 escrow/state-machine cases + 4 VIN registry cases) all pass.
  Nothing is deployed yet - `declare_id!` is still the placeholder.
- Next.js frontend: dashboard, listings, deal console, VIN page, inspection market, corridors, and
  policy. The action buttons (fund escrow, upload a report, accept a report, handover, release
  funds, open a dispute, arbiter ruling) call the real API.

**Not running / not verified**

- `programs/vin-anchor/` (Rust + Anchor) — **never compiled or deployed**. The Rust and Solana
  toolchain is not available in this development environment (hosts such as rust-lang.org and
  crates.io are blocked in the sandbox). Run `anchor build && anchor test` before claiming anything
  about on-chain funds. Details, including the **3 review findings that were fixed** and the list of
  what does not exist yet: **`docs/PROGRAM.md`**.
- Until the program is deployed, vault rules are still tested through the **TypeScript ledger model**
  (`packages/shared/src/vault-spec.ts`) with property tests — see `npm test`.
- The escrow running today is `MockEscrowProvider` (it imitates a licensed provider ledger).
  No real money moves anywhere yet.
- **No NFT has been minted.** `note_completed` records `noteAssetId: null`, and the receipt metadata
  is already prepared to be Metaplex Core compatible (`GET /api/notes/:id/metadata`).
- Authentication: **Sign-In With Solana is implemented** (`services/api/src/auth.ts`). The wallet
  signs a single-use nonce, the API verifies the ed25519 signature, and writes carry a session token
  (`Authorization: Bearer`). The `x-actor-id` header still exists for the seeded demo flow and is
  rejected the moment `VIN_DEMO_MODE=false`. Google/X buttons are UI-only: social login needs OAuth
  credentials **and** an embedded-wallet provider, and neither exists yet.
- No KYC/KYB vendor, no security audit, and no OJK licence yet (see `docs/LEGAL.md`).

## 2. Repo layout

```
apps/web/                  Next.js 15 (App Router, React 19, Tailwind v4)
services/api/              Hono API + node:sqlite (schema portable to Postgres)
packages/shared/           Types, state machine rules, money arithmetic, hashing (used by API + web)
programs/vin-anchor/       Solana program (Rust + Anchor): escrow, bonds, receipt registry
docs/                      Architecture, tech choices, API, roadmap, legal boundaries
```

## 3. Running it

```bash
npm install

# 1. Build the shared domain package
npm run build:shared

# 2. Load demo data (this also exercises the full flow end to end)
npm run seed:reset

# 3. Run the API and the web app (two terminals)
npm run dev:api     # http://0.0.0.0:8080
npm run dev:web     # http://0.0.0.0:3000

# Core rules tests
npm test

# API regression: the Postman flow folders, run without the Postman app
# (with the API from step 3 still running)
npm run collection:run
```

`npm run collection:run` executes the `E2E Happy Path`, `E2E Dispute Path`, and
`Regression - Odometer Baseline` folders of the collection in
`postman/collections/VIN API`; see `docs/COLLECTION.md` (Indonesian) for
variants and for how to prove a regression folder is red on pre-fix code.

The frontend calls the backend through relative `/api/*` routes forwarded by the Next rewrite
(`apps/web/next.config.ts`), so the browser never calls `localhost` directly.

### Walk the flow as three people

The sidebar has a **Sign in** button (Google / X / connect wallet, Gmgn style). Those buttons are a
UI-first mock: the API authenticates with the `x-actor-id` header, so the dialog also exposes a **demo
binding** picker that binds this browser to one actor. Pick an actor, then work through the steps:

1. **Buyer** → open a listing → *Lock deal & fund escrow*. Two separate escrows are created.
2. **Apex Vehicle Inspections** → upload a report (the *example* button fills in a sha256 hash).
   To see an anomaly: enter an odometer reading lower than the seller's record for that VIN.
3. **Buyer** → accept the report (the anomaly warning must be ticked when one exists).
4. **Buyer & Seller** → confirm handover → **release vehicle funds** → the receipt is recorded.
5. For a dispute: sign in as the **Arbiter** and rule. Also try choosing the **Crescent Motors** workshop
   when locking a deal — it is affiliated with the seller and **blocked** by the system.

## 4. Rules the machine enforces (not just intentions in a document)

| Rule | Where it is enforced |
| --- | --- |
| Vehicle funds do not release before the handover terms are met | `vehicleReleasePreconditions` + `POST /deals/:id/release-vehicle` (409 until they are) |
| Inspection funds do not release before a complete report | `inspectionReleasePreconditions` + `POST /deals/:id/reports/:rid/accept` |
| The seller cannot pick the inspector; affiliated workshops are blocked | `INSPECTOR_CONFLICT` on `POST /listings/:id/deals` |
| Past events cannot be edited | Append-only `events` table + sequence `UNIQUE (vin, seq)` |
| An odometer anomaly stays visible | `odometer_anomaly` + report acceptance must acknowledge it |
| A dispute freezes escrow and the receipt | `freeze_deal` + the `frozen` status rejects releases |
| A slashed bond goes to the dispute fund | `slashBond()` + `dispute_fund`, never the team wallet |
| Two separate escrows (vehicle money vs inspection) | `escrows` unique per `(deal_id, leg)`; two vaults in Anchor |
| Corridor expansion halts when four numbers go bad at once | `evaluateCorridorHealth()` + `expansionHalted` |

## 5. Key endpoints

```
GET  /api/meta/policy                  all public policy (fees, bonds, stages, event taxonomy)
GET  /api/metrics/token                locked bonds (the only "token metric" claimed)
GET  /api/listings                     listings plus the corridors served
GET  /api/vin/:vin                     event chain, reports, receipts, anomalies, claim boundary
POST /api/listings/:id/deals           the buyer locks a deal (two escrows are created)
POST /api/deals/:id/fund               escrow funding (production: a licensed provider webhook)
POST /api/deals/:id/reports            the workshop uploads a report (hash only)
POST /api/deals/:id/reports/:rid/accept  the buyer accepts the report -> inspection funds release
POST /api/deals/:id/handover           handover confirmation per party
POST /api/deals/:id/release-vehicle    release vehicle funds + record the receipt
POST /api/deals/:id/disputes           open a dispute (freezes escrow)
POST /api/disputes/:id/resolve         arbiter ruling
GET  /api/inspectors                   inspection market (ranked by performance, not bought)
GET  /api/corridors/:id/metrics        public metrics + expansion halt triggers
GET  /api/notes/:id/metadata           Metaplex Core compatible receipt metadata
```

Full reference: `docs/API.md`.

## 6. On Rust, Go, and "the language Google made"

The answer lives in **`docs/TECH_STACK.md`**. Summary:

- **The on-chain program has to be Rust + Anchor** — not a matter of taste, it is the only
  production path on Solana.
- **The MVP backend is TypeScript** (Node 22 + Hono) because cost is decided not by the language but
  by KYC integration, a licensed escrow provider, and disputes; sharing one language with the
  frontend also means shared types.
- **Go stays on the table as a measured exit path**: move only if a deal endpoint's p95 exceeds
  300 ms because of the runtime, or sustained traffic passes 500 rps. Move three services, not all
  of them.
- **Go is a language Google made** — true, and Go is widely used for infrastructure. The mistake is
  assuming Go is used for Solana programs. Solana programs are not compiled from Go.

## 7. Launch order

Four stages from the concept document, mapped to real work:

1. **Proof Stage** — one corridor, mandatory inspection, mandatory escrow, VIN history live, receipt
   NFTs only for completed deals, **no public token sale**, bonds in stablecoin.
2. **Market Stage** — third-party workshops, report standards and dispute freezing running, public
   metrics: completed deals, median time to report, dispute rate.
3. **Token Stage** — a token only once sellers and workshops genuinely need bonds and fee discounts.
   No allocation framed as a claim on revenue.
4. **Expansion Stage** — a second corridor, and the odometer anomaly rules are never rolled back.

Work breakdown, gates, and the mainnet checklist: **`docs/ROADMAP.md`**.

## 8. Other documents

- `docs/KONSEP.md` — **the concept in one place**: the ten non-negotiable rules with where each is
  enforced and tested, roles and authority, money, the real state of the build, and the open
  decisions. Start here.
- `docs/ARCHITECTURE.md` — architecture, data model, money flow, security.
- `docs/TECH_STACK.md` — tech choices + the Rust/Go answer.
- `docs/API.md` — endpoint reference.
- `docs/ROADMAP.md` — stages, gates, production & mainnet checklist.
- `docs/FLOW.md` — **the smart contract flow step by step**: who signs what, the happy path and
  dispute branch diagrams, and what the program does and does not guard.
- `docs/PROGRAM.md` — smart contract reference: accounts, instructions, invariants, review findings,
  what does not exist yet.
- `docs/SPEC_RECONCILIATION.md` — **the five-contract design flow compared against the
  implementation**: 20 differences, two critical logic bugs, an area-by-area assessment, and the
  phased adoption order.
- `docs/DEPLOYMENT.md` — MVP deployment, real-money readiness, and how to turn on the on-chain path.
- `docs/FASE1_ANCHOR.md` — **the Phase 1 spec**: explicit `DealState`, the VIN registry, the
  `maxOdometer` gate, and the test cases that must go red before they go green.
- `docs/SIWS.md` — sign-in: the nonce/signature/session flow, the properties under test, demo mode
  versus session-only mode, and what is deliberately not built.
- `docs/LOCAL_TEST.md` — how to run the Anchor and SIWS checks on your own machine, plus the traps
  already paid for (stale SQLite inode after `seed:reset`, `next/font` needing network).
- `docs/COLLECTION.md` — the Postman collection: folders, variables, and how to prove a regression
  folder is red on pre-fix code.
- `docs/LEGAL.md` — legal boundaries, compliance, and what must **not** be published.

## 9. Repo hygiene

This repository has history and one shared branch (`arena/01a0fdf4-newproject`). To avoid losing it:

- **Never re-run `git init`** or push a freshly initialised repo over this branch. That replaces the
  whole history with a single root commit and every earlier commit becomes unreachable.
- **Pull before you push.** If a push is rejected, pull and resolve - do not force-push.
- **A shallow clone is not lost history.** `git clone --depth` (and some sandboxes) mark the oldest
  fetched commit as a grafted root, so `git log` simply stops there and the commit looks parentless.
  Run `git fetch --unshallow` (or `git cat-file -p <sha>` to read the raw commit) before concluding
  that history was replaced.
- Generated data (`.data/`, `node_modules/`, `.next/`) is gitignored; reset it with `npm run seed:reset`
  instead of committing it.

## 10. Warning

This repository is a **product foundation**, not an investment promise. No token is sold, no price
projection is made, and no return is promised to anyone. Before real money moves: a contract audit,
the applicable provider licences, and legal opinions in both corridor countries.
