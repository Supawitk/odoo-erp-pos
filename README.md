# odoo-erp-pos

> Full ERP + POS for Thailand 🇹🇭 — Odoo 18 backbone, NestJS gateway, React Router v7 dashboard, React Native iPad register.

[![Phase](https://img.shields.io/badge/phase-4%20complete-success)](#progress)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

### Core platform
[![Odoo](https://img.shields.io/badge/Odoo_18-714B67?style=for-the-badge&logo=odoo&logoColor=white)](https://www.odoo.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL_18-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis_8-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io)
[![Meilisearch](https://img.shields.io/badge/Meilisearch_1.12-FF5CAA?style=for-the-badge&logo=meilisearch&logoColor=white)](https://www.meilisearch.com)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

### API gateway
[![NestJS](https://img.shields.io/badge/NestJS_11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com)
[![Node.js](https://img.shields.io/badge/Node.js_22-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript_6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Drizzle](https://img.shields.io/badge/Drizzle_0.45-C5F74F?style=for-the-badge&logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![Socket.IO](https://img.shields.io/badge/Socket.IO_4.8-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io)

### Web dashboard
[![React Router](https://img.shields.io/badge/React_Router_v7-CA4245?style=for-the-badge&logo=reactrouter&logoColor=white)](https://reactrouter.com)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite_8-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-000000?style=for-the-badge&logo=shadcnui&logoColor=white)](https://ui.shadcn.com)
[![TanStack Query](https://img.shields.io/badge/TanStack_Query-FF4154?style=for-the-badge&logo=reactquery&logoColor=white)](https://tanstack.com/query)
[![Recharts](https://img.shields.io/badge/Recharts_3-22B5BF?style=for-the-badge&logo=chartdotjs&logoColor=white)](https://recharts.org)

### iPad register
[![React Native](https://img.shields.io/badge/React_Native_0.85-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://reactnative.dev)
[![Stripe Terminal](https://img.shields.io/badge/Stripe_Terminal-635BFF?style=for-the-badge&logo=stripe&logoColor=white)](https://stripe.com/terminal)
[![PromptPay](https://img.shields.io/badge/PromptPay_QR-005BAC?style=for-the-badge&logo=qrcode&logoColor=white)](https://www.bot.or.th)

### Tooling
[![Turborepo](https://img.shields.io/badge/Turborepo_2.9-EF4444?style=for-the-badge&logo=turborepo&logoColor=white)](https://turbo.build)
[![pnpm](https://img.shields.io/badge/pnpm_10-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)
[![Vitest](https://img.shields.io/badge/Vitest_3.2-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)
[![fast-check](https://img.shields.io/badge/fast--check_4-2C3E50?style=for-the-badge)](https://fast-check.dev)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/features/actions)

---

## What this is

A self-hosted ERP + POS targeting Thai SMEs. Odoo 18 keeps the catalog and standard ERP tables; everything else (POS, accounting GL, withholding tax, fixed assets, branches, Insights, etc.) lives in a `custom.*` Postgres schema and a NestJS API on top.

Three frontends share the same API: a React Router v7 dashboard for managers, a React Native register for iPad cashiers, and Odoo's web UI for back-office. Cross-module wiring is event-driven — POS sale fires `OrderCompletedEvent` → stock decrements + GL posts + outbox queues Odoo write-back.

## Tech stack

| Layer | Stack |
|---|---|
| **API** | NestJS 11.1 (Fastify) · CQRS · Drizzle 0.45 · postgres-js 3.4 · ioredis 5 · BullMQ 5 · Socket.io 4.8 + Redis adapter · opossum 9 (circuit breaker) |
| **Domain** | dinero.js 2 (integer satang) · Thai TIN mod-11 · VAT engine (incl/excl/zero/exempt) · PromptPay EMVCo + CRC16 · baht-words · excise calculator (alcohol / tobacco / 6-band sugar) |
| **Data** | PostgreSQL 18.3 (`custom.*` schema in Odoo's DB) · pg_trgm · pgcrypto · pgvector · Meilisearch 1.12 (search; pg_trgm fallback) |
| **Web** | React Router v7.14 · Vite 8 · React 19 · shadcn/ui · Tailwind 4 · Zustand 5 · TanStack Query 5 · Recharts 3 |
| **Mobile** | React Native 0.85 (New Arch) · vision-camera 4 + barcode scanner · WatermelonDB (offline) · Stripe Terminal · ESC/POS thermal · PromptPay QR |
| **Tooling** | Turborepo 2.9 · pnpm 10 · vitest 3.2 · fast-check 4.7 · GitHub Actions |

## Project layout

```
apps/
  api/                NestJS — POS, inventory, purchasing, sales, accounting, reports, auth
  web/                React Router v7 — /pos /inventory /bills /sales /accounting /analysis /settings
  mobile/             React Native iPad register (scaffold; Metro-bundle verified)
packages/
  db/                 Drizzle schemas + migrations (custom.* schema in odoo DB)
  shared/             Money · Thai (TIN, VAT, PromptPay, baht-words, excise, WHT)
odoo/oca-addons/      9 OCA Thailand + accounting modules pinned to branch 18.0
```

## Quick start

```bash
# macOS prereqs: PostgreSQL 18, Redis 8, Docker, pnpm 10, Node 22+
brew install pgvector
cp .env.example .env       # then fill in POSTGRES_PASSWORD + JWT_*_SECRET + ENCRYPTION_MASTER_KEY

pnpm install
pnpm --filter @erp/db build && pnpm db:migrate
docker compose -f docker-compose.dev.yml up -d odoo meilisearch
pnpm dev
# API   → http://localhost:3001    Web → http://localhost:5173    Odoo → :8069
```

On first boot — if `custom.users` is empty — a default `admin@local` user is seeded and its password is logged once to the API console. Pin a password you'll remember by setting `SEED_ADMIN_PASSWORD` in `.env` before first boot. Self-register at `/register` (cashier role) or change the admin password from Settings → Users.

## Progress

### ✅ Phase 1 — Foundation
Monorepo · NestJS scaffold · Drizzle migrations · Odoo 18 in Docker on local Postgres · Redis · Meilisearch · RR7 web · RN scaffold · CI · `/health` all-green.

### ✅ Phase 2 — POS core
Cart + checkout · document state machine (RE / ABB / TX / CN) · TIN mod-11 · gapless §86 sequence under concurrent load · PromptPay QR (verified vs reference) · Thai receipt PDF with amount-in-Thai-words · refund → credit-note · monthly **PP.30** export (CSV + XLSX) · Odoo `pos.order` sync.

### ✅ Phase 3 — Inventory + purchasing
Hybrid `stock_moves` ledger + cached `stock_quants` · 10-way concurrent decrement gate (last-unit race) · FIFO/FEFO with `FOR UPDATE SKIP LOCKED` · cycle counts (auto-accept ≤฿100 OR ≤2%) · supplier + 4-table PO + 4-table GRN with QC · 🇹🇭 excise calculator runs *before* VAT · 🇹🇭 daily goods report (RD Notice 89 §9) · outbox relay for durable Odoo writes · drift reconciliation cron.

### ✅ Phase 4 — Accounting engine
Thai SME chart of accounts (TFRS for NPAEs, 62 accounts) · double-entry GL with Postgres trigger enforcing balance · POS → JE outbox-durable · vendor bills + 3-way match (PO ↔ GRN ↔ bill) · partial payments · AR + AP aging · sales invoices + WHT receivable (1157 offset at year-end) · **PND.3 / 53 / 54** monthly remittance — both **v1.0 RD-Prep** (the format SMEs actually file via efiling.rd.go.th) and **v2.0 SWC** (for software vendors enrolled with RD) · 50-Tawi PDF per bill · **PP.30 ↔ GL reconciliation** (variance > ฿1 surfaces) · Input VAT 6-month §82/3 expiry tracker + auto-reclass · fixed-asset register + monthly straight-line depreciation cron · **CIT (PND.50 / 51)** with SME bracket math (0% / 15% / 20%).

### ✅ Hardening passes
JWT ES256 + argon2 + global `JwtAuthGuard` + `@Roles()` per route · audit interceptor on every mutation · opossum on Odoo JSON-RPC · stale-session sweeper · CSV product import · branches CRUD · receipt email · sequence-gap §86 audit · iPad-friendly tap targets across web POS.

**`/analysis` admin page (12 cards in 3 tiers):**
- 💰 **Money snapshot** — Profit this period · Books balanced? · You owe (AP aging) · Owed to you (AR aging)
- 📦 **Operations snapshot** — Stock value · Stock movement · Bills waiting for review · VAT mix
- 🔍 **Deep dive** — Profitability by product/category · New vs returning customers · WHT rollup · Security anomalies

**Data protection:** `pgcrypto` field encryption for TIN + buyer addresses (dual-write — ciphertext bytea + sha256 hash for indexed lookup) · Postgres `enforce_balanced_entry` trigger that rejects unbalanced GL posts at the DB layer and auto-fills `total_debit_cents` / `total_credit_cents` on the header.

**Multi-branch:** §86/4 sequence allocator scopes by `(type, period, branch_code)` — non-HQ branches get `{BR}-TX-YYMM-#####` format. 20-way concurrent allocation across 2 branches → exactly 10+10 sequences, no collisions, all globally unique.

**🇹🇭 PP.30 (effective 2026-03-01):** XLSX export carries the new merchant header block + PromptPay refund channel (RD now refunds VAT credits to a PromptPay ID linked to the merchant TIN). Full RD-format `.rdx` XML still pending — Phase 4B (Leceipt MVP) is the practical unblock.

**Outbox observability:** `GET /api/inventory/outbox/diagnostics` classifies pending Odoo writes as ready / blocked-on-mapping / unrecognised so operators can see *why* a row hasn't drained.

## Architecture

```
iPad RN ─┐
         ├─→ NestJS API (Fastify · hexagonal · CQRS)
Web RR7 ─┘        │
                  ├─ Domain: pure (Money · Order · ExciseCalculator · WHT · CIT)
                  ├─ Application: command / query / event handlers
                  └─ Infrastructure: Drizzle · Odoo JSON-RPC · BullMQ · Socket.io
                       │
                       ├─→ PostgreSQL 18 (custom.* schema in odoo DB)
                       ├─→ Redis (cache · pub/sub · BullMQ · Socket.io)
                       ├─→ Meilisearch (search; pg_trgm fallback)
                       └─→ Odoo 18 (read = master · write = outbox-relayed)
```

## Tests

```
pnpm --filter @erp/shared test    # 92 unit tests (money · TIN · VAT · PromptPay · baht-words · excise)
pnpm --filter @erp/api    test    # integration suites against the live local Postgres
```

All integration suites green: encryption (9), balanced-entry trigger (7), branch sequence (6), outbox resolver (4), POS (7) — 33/33 in ~7s.

## What's next

- **Phase 4B** — e-Tax invoice ASP integration (Leceipt + INET) with ETDA XSD validation in CI
- **Phase 5** — dashboard analytics, NL2SQL, AI-assisted bank reconciliation
- **Phase 6** — payroll + statutory PND.1 / PND.1ก / SSO contributions
- **Backlog** — full PP.30 `.rdx` XML export · BoT FX cron + multi-currency · DBD XBRL in Excel V2.0 · BullMQ Job Schedulers v5 migration · POS-session → branch wiring

## License

Private. Not for redistribution.
