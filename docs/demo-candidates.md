# Dokkimi Demo Candidates

Open-source projects with multiple microservices communicating over HTTP/REST.
All are actively maintained (commits in June 2026) and used in production.

---

## 1. Hyperswitch — Payment Processing Switch

**Repo:** github.com/juspay/hyperswitch
**Stars:** 43k | **Language:** Rust | **Last active:** June 26, 2026
**What it is:** An open-source payment switch that lets merchants connect to 50+ payment processors (Stripe, Adyen, Braintree, etc.) through a single API. Built by Juspay. Used in production for real payment processing.

### Services

| Service                        | Image                                    | Port | Role                                                             |
| ------------------------------ | ---------------------------------------- | ---- | ---------------------------------------------------------------- |
| **hyperswitch-server**         | `juspaydotin/hyperswitch-router`         | 8080 | Main API router — handles payment requests, routes to connectors |
| **hyperswitch-producer**       | `juspaydotin/hyperswitch-producer`       | —    | Scheduler: produces retry/cleanup jobs                           |
| **hyperswitch-consumer**       | `juspaydotin/hyperswitch-consumer`       | —    | Scheduler: consumes and executes jobs                            |
| **hyperswitch-drainer**        | `juspaydotin/hyperswitch-drainer`        | —    | Drains Redis KV operations to Postgres                           |
| **hyperswitch-web**            | `juspaydotin/hyperswitch-web`            | 9050 | Payment checkout SDK (JS/web)                                    |
| **hyperswitch-control-center** | `juspaydotin/hyperswitch-control-center` | 9000 | Admin dashboard                                                  |
| **superposition**              | `ghcr.io/juspay/superposition-demo`      | 8081 | Feature flag / dynamic config service                            |
| **hyperswitch-demo**           | `juspaydotin/hyperswitch-react-demo-app` | 9060 | Demo merchant storefront                                         |

**Data stores:** Postgres, Redis (standalone or clustered), ClickHouse (analytics), Kafka, OpenSearch

### Inter-Service HTTP Calls

```
hyperswitch-web ──HTTP──> hyperswitch-server (ENV_BACKEND_URL)
hyperswitch-control-center ──HTTP──> hyperswitch-server (dashboard.toml config)
hyperswitch-demo ──HTTP──> hyperswitch-server (HYPERSWITCH_SERVER_URL)
hyperswitch-server ──HTTP──> superposition (feature flags / config)
superposition-init ──HTTP──> superposition (seed config on startup)
create-default-user ──HTTP──> hyperswitch-server + control-center (bootstrap)
hyperswitch-consumer ──depends on──> hyperswitch-server
hyperswitch-producer ──depends on──> hyperswitch-consumer
```

### What Dokkimi Should Target

**Payment flow end-to-end:** Create a payment intent → confirm payment → check status. The server routes to mock payment connectors — test that the full lifecycle works and that status transitions are correct.

**Retry/scheduler pipeline:** The producer-consumer-drainer pipeline handles retries and async operations. Test that failed payments are retried correctly, that the drainer properly syncs Redis state to Postgres, and that job scheduling doesn't lose events.

**Config propagation:** Superposition serves feature flags to the server. Test that config changes propagate correctly — toggle a feature flag and verify the server behavior changes.

**Connector routing:** The server routes payments to different connectors based on rules. Test that routing logic works correctly when multiple connectors are configured, and that fallback works when a connector is down.

**Race conditions in payment state:** Payments go through states (created → processing → succeeded/failed). Test concurrent updates — what happens if a webhook arrives while a status check is in flight?

---

## 2. Plane — Project Management (Jira Alternative)

**Repo:** github.com/makeplane/plane
**Stars:** 53k | **Language:** Python (Django) + TypeScript (Next.js) | **Last active:** June 26, 2026
**What it is:** Open-source project management tool — issues, sprints, cycles, modules, pages. Direct competitor to Jira/Linear. Used by teams in production.

### Services

| Service         | Role                                         |
| --------------- | -------------------------------------------- |
| **api**         | Django REST API — core business logic        |
| **web**         | Next.js frontend — main user interface       |
| **admin**       | Admin panel frontend                         |
| **space**       | Public-facing project pages                  |
| **live**        | Real-time collaboration (WebSocket)          |
| **worker**      | Celery background worker (async tasks)       |
| **beat-worker** | Celery beat (scheduled tasks)                |
| **proxy**       | Nginx reverse proxy — routes to all services |

**Data stores:** Postgres, Redis (Valkey), RabbitMQ, MinIO (file storage)

### Inter-Service HTTP Calls

```
proxy (nginx) ──routes──> web, api, space, admin
web ──HTTP──> api (server-side rendering calls)
admin ──HTTP──> api
space ──HTTP──> api
worker ──depends on──> api, Postgres, Redis
beat-worker ──depends on──> api, Postgres, Redis
live ──WebSocket──> (real-time updates)
```

### What Dokkimi Should Target

**Issue lifecycle:** Create a project → create an issue → assign it → move through states → close it. Verify the API responses and that the worker picks up async tasks (notifications, webhooks).

**Concurrent edits:** Multiple users editing the same issue — does the API handle conflicts? Does the live service propagate changes correctly?

**Webhook delivery:** Plane supports webhooks on issue events. Test that the worker reliably delivers webhooks on state changes, and handles failures/retries.

**File uploads via MinIO:** Upload attachments → verify they're stored in MinIO → verify they're accessible via the API. Test what happens when MinIO is slow or down.

**Background job reliability:** Beat-worker schedules periodic jobs (analytics, cleanup). Verify jobs run on schedule and don't pile up if they take longer than the interval.

---

## 3. Lago — Open-Source Billing & Metering

**Repo:** github.com/getlago/lago
**Stars:** 10k | **Language:** Ruby on Rails + React | **Last active:** June 19, 2026
**What it is:** Usage-based billing platform — metering, subscriptions, invoicing, coupons. Alternative to Stripe Billing / Chargebee. Used by companies for real billing.

### Services

| Service        | Image                       | Port | Role                                              |
| -------------- | --------------------------- | ---- | ------------------------------------------------- |
| **api**        | `getlago/api`               | 3000 | Rails API — subscriptions, invoicing, metering    |
| **front**      | `getlago/front`             | 80   | React dashboard                                   |
| **api-worker** | `getlago/api` (worker mode) | 8080 | Sidekiq background jobs (billing, PDFs, webhooks) |
| **api-clock**  | `getlago/api` (clock mode)  | —    | Scheduled billing jobs (cron-like)                |
| **pdf**        | `getlago/lago-gotenberg`    | 3000 | PDF generation (Gotenberg)                        |

**Data stores:** Postgres (with partman for table partitioning), Redis

### Inter-Service HTTP Calls

```
front ──HTTP──> api (API_URL env var)
api ──HTTP──> pdf (LAGO_PDF_URL=http://pdf:3000 — invoice PDF generation)
api ──HTTP──> data-api (LAGO_DATA_API_URL=http://data-api — analytics, optional)
api-worker ──shares DB/Redis with──> api
api-clock ──shares DB/Redis with──> api
```

### What Dokkimi Should Target

**Invoice generation pipeline:** Create a customer → add a subscription → ingest usage events → trigger billing → verify invoice is generated → verify PDF is created via the pdf service. This crosses api → worker → pdf service boundaries.

**Usage event ingestion at volume:** Lago meters API usage. Send a burst of usage events and verify they're all counted correctly. Test for race conditions in metering — do concurrent events for the same customer produce correct totals?

**PDF generation failure handling:** The api calls the pdf service (Gotenberg) over HTTP to generate invoice PDFs. What happens when the pdf service is slow? Does the API timeout gracefully? Are PDFs retried?

**Webhook delivery:** Lago sends webhooks on invoice events. Test that the worker delivers webhooks reliably, handles endpoint failures, and retries with backoff.

**Subscription edge cases:** Create overlapping subscriptions, upgrade mid-cycle, apply coupons, cancel and re-subscribe. Verify prorated amounts are calculated correctly across the api and worker.

---

## 4. Saleor — E-Commerce Platform

**Repo:** github.com/saleor/saleor (API) + github.com/saleor/saleor-platform (compose)
**Stars:** 23k (API repo) | **Language:** Python (Django) + React | **Last active:** June 26, 2026
**What it is:** Headless e-commerce platform with GraphQL API. Used by real online stores. Powers storefronts for fashion, electronics, etc.

### Services

| Service       | Image                             | Port | Role                                                  |
| ------------- | --------------------------------- | ---- | ----------------------------------------------------- |
| **api**       | `ghcr.io/saleor/saleor`           | 8000 | Django API — products, orders, checkout, payments     |
| **dashboard** | `ghcr.io/saleor/saleor-dashboard` | 9000 | React admin dashboard                                 |
| **worker**    | `ghcr.io/saleor/saleor` (celery)  | —    | Background tasks (emails, webhooks, media processing) |
| **mailpit**   | `axllent/mailpit`                 | 8025 | Email capture (dev)                                   |

**Data stores:** Postgres, Valkey (Redis-compatible), Jaeger (tracing)

**Note:** Saleor's API is primarily **GraphQL**, not REST. The worker shares the same codebase/DB as the API. Even without complex inter-service calls, Dokkimi can still test the API + DB layer, intercept GraphQL traffic, and verify worker behavior. The e-commerce domain is highly relatable for demos.

### Inter-Service HTTP Calls

```
dashboard ──GraphQL/HTTP──> api (DASHBOARD_URL config)
worker ──shares DB with──> api (Celery task queue via Redis)
api ──SMTP──> mailpit (email sending)
```

### What Dokkimi Should Target

**Checkout flow:** Add products to cart → create checkout → add shipping/billing → complete payment → verify order is created. This exercises the API heavily and triggers worker tasks (order confirmation emails, webhook delivery).

**Inventory consistency:** Place concurrent orders for a product with limited stock. Does the system correctly prevent overselling? Test the race condition between stock reservation and order completion.

**Webhook reliability:** Saleor fires webhooks on order events to external apps. Test that the worker delivers them correctly when endpoints are slow or failing.

**Media processing:** Upload product images → verify the worker processes thumbnails. Test behavior when the worker is overloaded.

---

## Recommendation

### Best for Dokkimi demo: Hyperswitch

**Why:** It has the most distinct services communicating over HTTP, the domain (payments) is high-stakes where bugs matter, and it's massively popular (43k stars). The superposition config service, the producer/consumer/drainer pipeline, and the main API server create a rich web of HTTP inter-service calls. Finding a bug in a payment switch is inherently newsworthy.

**Demo narrative:** "We pointed Dokkimi at Hyperswitch — a 43k-star open-source payment switch used in production — and found [X] by testing the interaction between the payment router and the scheduler pipeline."

### Second pick: Lago

**Why:** The api → pdf service HTTP call is a clean, easy-to-understand inter-service boundary. The billing domain has natural complexity (usage metering, proration, invoicing) where edge cases hide. 10k stars, actively maintained, real product.

### Third pick: Plane

**Why:** 53k stars, relatable domain (everyone knows Jira), multiple frontends all calling the same API through a proxy. The worker/beat-worker async pipeline is testable. But the inter-service HTTP communication is mostly proxy → services, which is simpler than the other two.

### Fourth pick: Saleor

**Why:** Great product (23k stars), relatable e-commerce domain. The API is GraphQL rather than REST, and the architecture is simpler (API + worker + dashboard), but Dokkimi can still test the API + DB layer, intercept traffic, and verify worker behavior. The checkout → order → webhook flow is a natural test scenario.

---

## Startup Time Considerations

| Project     | Stack                     | Expected Cold Start                |
| ----------- | ------------------------- | ---------------------------------- |
| Hyperswitch | Rust                      | Fast (seconds)                     |
| Plane       | Python (Django) + Next.js | Moderate (~15-30s)                 |
| Lago        | Ruby on Rails             | Moderate (~20-40s, plus migration) |
| Saleor      | Python (Django)           | Moderate (~15-30s)                 |
