# odoo-erp-pos

> Full ERP + POS for Thailand 🇹🇭 — Odoo 18 backbone, NestJS gateway, React Router v7 dashboard, React Native iPad register.

[![Phase](https://img.shields.io/badge/phase-3%20complete-success)](#progress)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

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
│   ├── web/          React Router v7 dashboard — /pos /inventory /sales /analysis /settings
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

### ✅ Dashboard 2.0 + `/analysis` (admin only)
| | What |
|---|---|
| **Time-range toggle** | Today / 7d / Month / Quarter / Year on the dashboard — every chart re-buckets instantly. Granularity auto-picks (`hour` / `day` / `week` / `month`). |
| **Charts** | Recharts area for revenue trend, composed bar+line for orders+refunds, donut for document mix, horizontal bar for payment mix, top-products list, recent-orders feed. |
| **KPIs** | Net revenue · orders · AOV · refund rate — each shows delta vs previous equal-length window. Refund rate goes amber > 5%, rose > 10%. |
| **Action items** | Stale registers, low/out-of-stock, §86 sequence gaps surface as inline warning cards. Green "all clear" banner when nothing needs attention. |
| **`/analysis` (admin)** | Customer concentration (top-10 / top-25 share), top-25 customers table with TIN, hourly heatmap (Mon..Sun × 0..23, BKK), stacked payment evolution, stacked doc-type evolution, refund-rate over time, VAT collected over time. Sidebar link is admin-only and the page itself short-circuits with a `Lock` screen for non-admins. |
| **API** | `GET /api/reports/timeseries?from&to&granularity=hour\|day\|week\|month\|quarter\|year` and admin-only `GET /api/reports/customers-analysis`. JwtAuthGuard + `@Roles('admin')` enforce server-side. |
| **i18n hard reset** | Switching country mode in settings now triggers a hard reload. Master-switch values (currency, locale, vatRate, timezone) flow through every cached query without leaving stale sidebar/KPI labels in the previous language. |

### ✅ iPad-friendly POS + sidebar
The web POS doubles as a temporary register on iPad. Tweaks are CSS-only — API contract unchanged.

| | What |
|---|---|
| **Pay buttons** | h-14 / 56 px with bold text. Hold / Recall and modal action rows standardised at h-11. |
| **Cart row** | qty +/− and the trash icon bumped 28 → 40 px (clears the WCAG 2.5.5 44 pt thumb target with the focus ring). |
| **Numeric keypad** | `inputMode + pattern` on opening float, cash tendered, close count, buyer TIN (13d), buyer branch (5d). iPad surfaces the 0–9 pad instead of QWERTY. Email modal uses `inputMode=email` + `autoCapitalize=off`. |
| **Product grid** | p-4 cards with `min-h-[110px]` and `active:scale-[0.98]` for haptic-ish feedback. Grid breaks 2 → 3 → 4 (was 2 → 3 → 4 → 5) so iPad landscape gets ~210 px cards instead of cramped 150 px ones. |
| **Category chips** | text-sm py-1.5 px-3.5 (≈ 32 px tall). |
| **Side navigation** | Menu rows now use shadcn's `size="lg"` variant — h-12 / 48 px, with text-[15px] and 20 px icons. Group toggles get h-9, the SidebarTrigger and Sign-out icon are 40 × 40 with `[&_svg]:!size-5`. |
| **Safari quirks** | Active POS uses `100svh` (small viewport height) on supporting browsers so iPad Safari URL-bar slide-in/out doesn't lose chart space; falls back to `100vh`. `-webkit-tap-highlight-color: transparent` removes iOS's default grey tap rectangle. |

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
