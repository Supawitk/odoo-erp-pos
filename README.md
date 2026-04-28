# odoo-erp-pos

> Full ERP + POS for Thailand 🇹🇭 — Odoo 18 backbone, NestJS gateway, React Router v7 dashboard, React Native iPad register.

[![Phase](https://img.shields.io/badge/phase-3%20complete-success)](#progress)
[![Stack](https://img.shields.io/badge/stack-NestJS%2011%20%C2%B7%20RR7%20%C2%B7%20RN%200.85-blue)](#tech-stack)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

---

## Tech stack

### Backend
| | |
|---|---|
| Runtime | Node.js 22 LTS · TypeScript 6.0 |
| API | NestJS 11.1 (Fastify) · `@nestjs/cqrs` · `@nestjs/bullmq` |
| ORM | Drizzle 0.45 · postgres-js 3.4 |
| Database | PostgreSQL 18.3 · pgvector · pg_trgm · pgcrypto |
| Cache · queues | Redis 8.6 · BullMQ 5 |
| Search | Meilisearch 1.12 (pg_trgm fallback) |
| Reliability | opossum 9 circuit breaker on Odoo JSON-RPC |
| Money | dinero.js 2.0.2 (integer satang, no floats) |
| Real-time | Socket.io 4.8 + Redis adapter |

### Web (admin / manager)
| | |
|---|---|
| Framework | React Router v7.14 · Vite 8 |
| UI | shadcn/ui · Tailwind CSS 4.2 · lucide-react |
| State | Zustand 5 · TanStack Query 5.96 |

### iPad POS
| | |
|---|---|
| Framework | React Native 0.85 (New Arch) · React Navigation 7 |
| Camera | vision-camera 4 + mgcrea barcode scanner |
| Offline | WatermelonDB 0.28 (SQLite + JSI) |
| Payments | Stripe Terminal RN SDK · PromptPay QR · ESC/POS thermal |

### Tooling
Turborepo 2.9 · pnpm 10 · vitest 3.2 · fast-check 4.7

---

## Project layout

```
.
├── apps/
│   ├── api/          NestJS gateway — POS, inventory, purchasing, reports, organization
│   ├── web/          React Router v7 dashboard — /pos /inventory /sales /settings
│   └── mobile/       React Native iPad POS
├── packages/
│   ├── db/           Drizzle schemas + migrations (custom.* schema in odoo DB)
│   └── shared/       Money · Thai (TIN, VAT, PromptPay, baht-words, excise)
└── odoo/oca-addons/  9 OCA Thailand + accounting modules pinned to branch 18.0
```

---

## Progress

### ✅ Phase 1 — Foundation
Monorepo, NestJS scaffold, Drizzle migrations, Odoo 18 in Docker on local Postgres, Redis, Meilisearch, RR7 web, RN scaffold, CI workflow, `/health` all-green.

### ✅ Phase 2 — POS core
Cart + checkout, document state machine (RE / ABB / TX / CN), TIN mod-11, gapless sequence allocator under concurrent load, PromptPay QR (EMVCo + CRC16, verified vs reference), Thai receipt HTML/PDF with amount-in-Thai-words, refund → credit-note flow, **PP.30 monthly VAT return** (CSV + XLSX), Odoo `pos.order` sync verified live.

### ✅ Phase 3 — Inventory + purchasing
- Hybrid `stock_moves` ledger + cached `stock_quants` per warehouse
- 10-way concurrent decrement gate (last-unit race → exactly 1 success + 9 `InsufficientStockError`)
- FIFO/FEFO consumption with `FOR UPDATE SKIP LOCKED` cost-layer ordering
- Cycle counts with auto-accept ≤฿100 OR ≤2%
- Supplier + 4-table PO + 4-table GRN with QC gating
- 🇹🇭 Excise calculator (alcohol / tobacco / 6-band sugar) — runs *before* VAT
- 🇹🇭 Daily goods report (RD Notice 89 §9, statutory 3-col + soft extras, UTF-8 BOM CSV)
- Outbox pattern for durable Odoo `stock.move` write-back
- Reconciliation cron flags drift between local + Odoo `qty_available`

### ✅ Phase 1–3 closure pass
opossum on JSON-RPC · audit interceptor on every mutation · CSV product import · stock-on-hand CSV export · stale-session sweeper · daily goods-report cron.

### ✅ Latest session — branches + insights + UX
| | What |
|---|---|
| **Branches** | `custom.branches` table + CRUD API + Settings UI tab. Multi-branch §86/4 ready. |
| **Held carts** | Pause / recall checkout without burning a tax-invoice number. |
| **Receipt email** | nodemailer with `jsonTransport` dev-mode fallback. |
| **Customer autocomplete** | `/pos` buyer fields autocomplete from `partners`. |
| **Category chips** | `/pos` filters product grid by category. |
| **Product CRUD** | `/inventory` create / edit / deactivate modal. |
| **Sales Insights tab** | Payment mix, doc-type compliance ratio, 7×24 weekday-hour heatmap, period KPIs. |
| **Sequence gap audit** | `/settings` → Compliance — live §86 audit, tax-scope vs internal. |

---

## Quick start

```bash
# Prereqs (macOS): PostgreSQL 18 + Redis 8 + Docker, pnpm 10, Node 22+
brew install pgvector

pnpm install
pnpm --filter @erp/db build && pnpm db:migrate

docker compose -f docker-compose.dev.yml up -d odoo meilisearch
pnpm dev
# API   → http://localhost:3001
# Web   → http://localhost:5173
# Odoo  → http://localhost:8069  (admin / admin)
```

Copy `.env.example` to `.env` and fill in your local Postgres credentials before `pnpm dev`.

**Default app login** (seeded on first boot when `custom.users` is empty):

```
username: admin              (or email: admin@local)
password: 1234
```

Login accepts either email or username. Self-register at `/register` — new
accounts default to the `cashier` role. Change the admin password from
Settings → Users on first sign-in.

---

## Architecture

```
iPad RN ─┐
         ├─→ NestJS API (Fastify · hexagonal · CQRS)
Web RR7 ─┘        │
                  ├─ Domain: pure (Money VO · Order aggregate · ExciseCalculator)
                  ├─ Application: command / query / event handlers
                  └─ Infrastructure: Drizzle · Odoo JSON-RPC · BullMQ · Socket.io
                       │
                       ├─→ PostgreSQL 18 (custom.* schema in `odoo` DB)
                       ├─→ Redis (cache · pub/sub · BullMQ · Socket.io adapter)
                       ├─→ Meilisearch (product search; pg_trgm fallback)
                       └─→ Odoo 18 (read = catalog master · write = outbox-relayed)
```

Cross-module communication is **event-driven only** — no module imports another's domain or repository. POS sale fires `OrderCompletedEvent` → inventory deducts stock + outbox queues Odoo write-back.

---

## What's next

- **Phase 4** — accounting engine: Thai SME chart of accounts, double-entry GL, monthly VAT books, WHT (PND.3 / 53 / 54 + 50-Tawi), CIT (PND.51 / 50), financial statements (Thai format)
- **Phase 4B** — e-Tax invoice ASP integration (Leceipt + INET) with ETDA XSD validation in CI
- **Phase 5** — dashboard analytics, NL2SQL, AI-assisted bank reconciliation

---

## License

Private. Not for redistribution.
