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

## 5. Cal.diy — Scheduling Platform (Calendly Alternative)

**Repo:** github.com/calcom/cal.diy
**Stars:** 46k | **Language:** TypeScript (Next.js + NestJS) | **Last active:** June 29, 2026
**What it is:** Open-source scheduling infrastructure — booking pages, availability management, calendar sync, video conferencing integrations. Renamed from Cal.com on April 15, 2026 when Cal.com went closed-source (same repo, same star history — not a fork). MIT licensed (previously AGPL 3.0). Enterprise features (orgs, workflows, SAML/SSO) were stripped before the rename. Latest release: v6.2.0 (March 2026). Uses tRPC internally for type-safe frontend-backend communication, plus a separate NestJS API v2 for the Platform API.

### Services

| Service        | Build                    | Port | Role                                                 |
| -------------- | ------------------------ | ---- | ---------------------------------------------------- |
| **calcom**     | Root `Dockerfile`        | 3000 | Next.js web app — booking UI, tRPC server-side API   |
| **calcom-api** | `apps/api/v2/Dockerfile` | 80   | NestJS API v2 (Platform API) — OpenAPI/Swagger       |
| **database**   | `postgres`               | 5432 | PostgreSQL (via Prisma ORM)                          |
| **redis**      | `redis:latest`           | 6379 | Rate limiting (`@nestjs/throttler`), Bull job queues |
| **studio**     | Same image as calcom     | 5555 | Prisma Studio — DB GUI (optional, dev only)          |

**Data stores:** PostgreSQL, Redis

**Note:** The web app uses tRPC for most frontend-backend communication (server-side, no HTTP hop). But it **proxies** all `/api/v2/*` requests to the separate NestJS API v2 service via a Next.js rewrite rule (`NEXT_PUBLIC_API_V2_URL`). This is a real inter-service HTTP boundary that Dokkimi can intercept. Both services share business logic via monorepo packages (`@calcom/prisma`, `@calcom/features`, `@calcom/lib`).

### Inter-Service HTTP Calls

```
calcom (Next.js) ──HTTP proxy──> calcom-api (NestJS API v2, via NEXT_PUBLIC_API_V2_URL rewrite)
calcom-api ──HTTP/redirect──> calcom (WEB_APP_URL — OAuth flows, email links)
calcom ──tRPC (in-process)──> Next.js server (most frontend-backend calls)
calcom-api ──Redis/Bull──> redis (job queues, rate limiting)
calcom ──Prisma──> database (booking data, availability, users)
calcom-api ──Prisma──> database (shared @calcom/prisma package)
calcom ──HTTP──> external integrations (Google Calendar, Zoom, Stripe — mockable)
```

### What Dokkimi Should Target

**calcom ↔ calcom-api boundary:** The Next.js → NestJS API v2 proxy is a clean inter-service HTTP boundary. Test that the proxy correctly forwards requests, handles auth tokens, and that rate limiting (Throttler + Redis) works at the boundary. What happens when the API v2 service is slow or down?

**Booking logic edge cases:** Overlapping bookings, timezone math across DST boundaries, negative-duration events, past-date bookings, availability rule conflicts. The scheduling domain is rich with edge cases that unit tests miss.

**Browser automation / visual regression:** This is the big differentiator — none of the other candidates exercise Dokkimi's E2E browser features. Test the full booking flow from the user's perspective: select a time slot → fill in details → confirm → verify calendar entry.

**Webhook integrations:** Cal.diy integrates with Google Calendar, Zoom, Stripe, and others via webhooks. Mock these external services and test that booking events propagate correctly — what happens when a Zoom link creation fails mid-booking?

**Concurrent booking race conditions:** Two users try to book the same time slot simultaneously. Does the system prevent double-booking? Test the race condition between availability check and booking confirmation.

**Demo narrative:** "How I found a double-booking bug in Cal.diy" — the scheduling domain is universally understood and a bug here is immediately relatable.

---

## 6. Medusa — E-Commerce Platform

**Repo:** github.com/medusajs/medusa
**Stars:** 35k | **Language:** TypeScript (Node.js) | **Last active:** June 29, 2026 (v2.17.1)
**What it is:** Open-source headless commerce engine — products, carts, orders, payments, fulfillment, discounts, multi-currency. Alternative to Shopify Plus / commercetools. VC-funded company (Denmark), pushing releases weekly. Medusa v2 rewrote the entire core into 30+ independent commerce modules — but they all run in a **single Node.js process** (modular monolith, not microservices). Cross-module coordination uses in-process workflows and dependency injection, not HTTP.

### Services

| Service        | Image                   | Port | Role                                                    |
| -------------- | ----------------------- | ---- | ------------------------------------------------------- |
| **medusa**     | Custom Dockerfile build | 9000 | Node.js backend — all 30+ commerce modules + admin UI   |
| **storefront** | Custom Dockerfile build | 8000 | Next.js starter storefront (optional, from DTC starter) |
| **postgres**   | `postgres:15-alpine`    | 5432 | Primary database                                        |
| **redis**      | `redis:7-alpine`        | 6379 | Event bus, job queues                                   |

**Data stores:** PostgreSQL 15, Redis 7

**Note:** Medusa v2 is a **modular monolith** — all commerce modules (products, carts, orders, payments, fulfillment, etc.) run in-process in the single `medusa` backend. Modules communicate via dependency injection and workflow orchestration, not HTTP. The only HTTP boundary is storefront/admin → backend API. No docker-compose exists in the main repo — it lives in the DTC starter template and docs.

### Inter-Service Communication

```
storefront ──HTTP──> medusa:9000 (REST API — products, cart, checkout)
admin (built into medusa) ──same process──> medusa backend
medusa ──Redis──> event bus (order events, inventory updates, job queues)
medusa ──HTTP──> payment providers (Stripe, PayPal — mockable)
medusa ──HTTP──> fulfillment providers (mockable)
medusa ──HTTP──> webhook endpoints (order events — mockable)
```

### What Dokkimi Should Target

**Cart and checkout edge cases:** Add items → apply discounts → change quantities → checkout with multi-currency → verify order totals. Discount stacking, coupon validation, and price calculation across currencies have tons of edge case surface. The storefront → backend API is the primary HTTP boundary to test.

**Inventory race conditions:** Concurrent purchases for limited-stock items. Does the system prevent overselling? Test the race between cart reservation and order completion. MikroORM transaction handling under concurrent load is the key question.

**Payment flow with mocked providers:** Reuse the Stripe mocking pattern from Hyperswitch but from the merchant platform side. Test payment creation → confirmation → webhook delivery → order state transition. What happens when Stripe returns an unexpected error mid-checkout?

**Discount and pricing validation:** Do discounts validate consistently? Apply percentage discounts, fixed discounts, free shipping, buy-X-get-Y — verify the math is correct across all combinations. The validation inconsistency pattern (do coupons validate but shipping rules don't?) maps well here.

**Refund and return flows:** Complete an order → initiate a refund → verify inventory is restored and payment is reversed. Test partial refunds, multi-item returns, and refund-after-fulfillment edge cases.

**Dokkimi fit note:** Medusa's value for Dokkimi is API-layer testing and database interaction verification, not inter-service traffic interception. The rich commerce domain (35k stars, relatable use cases) compensates for the simpler architecture.

---

## 7. Appwrite — Backend-as-a-Service

**Repo:** github.com/appwrite/appwrite
**Stars:** 55k | **Language:** PHP (API) + Go (workers) | **Last active:** June 2026
**What it is:** Self-hosted backend-as-a-service — auth, databases, storage, functions, messaging, realtime. Alternative to Firebase/Supabase. Docker-native with ~28 containers. $37M raised (Tiger Global, Bessemer). Highest star count on this list. Built on PHP 8.3/Swoole 6 with Appwrite's own Utopia framework — monolithic image with different entrypoints per worker. Latest stable: v1.9.0 (April 2026), RC: v1.9.5-rc.2 (June 29, 2026).

### Services

**Core application (4 services):**

| Service               | Image                    | Port     | Role                                        |
| --------------------- | ------------------------ | -------- | ------------------------------------------- |
| **traefik**           | `traefik:3.6`            | 80, 443  | Reverse proxy, TLS termination              |
| **appwrite**          | `appwrite/appwrite`      | 80 (int) | Main API — REST + GraphQL (PHP/Swoole)      |
| **appwrite-realtime** | `appwrite/appwrite`      | —        | WebSocket server for realtime subscriptions |
| **appwrite-console**  | `appwrite/console:8.7.5` | —        | Web admin dashboard (Svelte SPA)            |

**Background workers (15 services, all same `appwrite/appwrite` image, different entrypoints):**

| Service                    | Role                                |
| -------------------------- | ----------------------------------- |
| **worker-audits**          | Audit log processing                |
| **worker-webhooks**        | Outbound webhook delivery           |
| **worker-deletes**         | Resource cleanup / deletion         |
| **worker-databases**       | Database schema operations          |
| **worker-builds**          | Function/site build orchestration   |
| **worker-certificates**    | TLS certificate management (ACME)   |
| **worker-executions**      | Function execution tracking         |
| **worker-functions**       | Serverless function orchestration   |
| **worker-mails**           | Email sending (SMTP)                |
| **worker-notifications**   | Push/in-app notifications           |
| **worker-messaging**       | SMS/push messaging                  |
| **worker-migrations**      | Data import from other platforms    |
| **worker-screenshots**     | Screenshot capture for URL previews |
| **worker-stats-resources** | Resource usage stats aggregation    |
| **worker-stats-usage**     | Usage metrics aggregation           |

**Scheduled tasks (6 services, same image):**

| Service                       | Role                                   |
| ----------------------------- | -------------------------------------- |
| **task-maintenance**          | Periodic cleanup (logs, cache, audits) |
| **task-interval**             | Domain verification, stale cleanup     |
| **task-scheduler-functions**  | Cron-scheduled function triggers       |
| **task-scheduler-executions** | Scheduled execution triggers           |
| **task-scheduler-messages**   | Scheduled message delivery             |
| **task-stats-resources**      | Periodic resource stats collection     |

**Supporting services (separate images):**

| Service                   | Image                          | Port       | Role                              |
| ------------------------- | ------------------------------ | ---------- | --------------------------------- |
| **openruntimes-executor** | `openruntimes/executor:0.25.1` | 9900 (int) | Serverless function executor (Go) |
| **appwrite-browser**      | `appwrite/browser:0.3.2`       | 3000 (int) | Headless browser for screenshots  |
| **appwrite-embedding**    | `appwrite/embedding:0.1.0`     | —          | Vector embedding service (Rust)   |
| **appwrite-assistant**    | `appwrite/assistant:0.8.4`     | —          | AI assistant (OpenAI-powered)     |

**Data stores (configurable — MongoDB default, MariaDB and PostgreSQL also supported):**

| Service        | Image                     | Port  | Role                         |
| -------------- | ------------------------- | ----- | ---------------------------- |
| **mongodb**    | `mongo:8.2.5`             | 27017 | Primary database (default)   |
| **mariadb**    | `mariadb:10.11`           | 3306  | Alternative primary database |
| **postgresql** | `appwrite/postgres:0.1.0` | 5432  | Alternative primary database |
| **redis**      | `redis:7.4.7-alpine`      | 6379  | Queue broker, cache, pub/sub |

### Inter-Service HTTP Calls

```
traefik ──routes──> appwrite, appwrite-realtime, appwrite-console
appwrite ──HTTP──> openruntimes-executor (_APP_EXECUTOR_HOST — function execution)
worker-builds ──HTTP──> openruntimes-executor (build functions)
worker-functions ──HTTP──> openruntimes-executor (run functions)
worker-screenshots ──HTTP──> appwrite-browser (_APP_BROWSER_HOST — screenshot capture)
worker-migrations ──HTTP──> appwrite (self — _APP_MIGRATION_HOST for platform imports)
appwrite ──Redis pub/sub──> worker-* (job dispatch to all 15 workers)
appwrite ──Redis pub/sub──> appwrite-realtime (event broadcasting)
worker-webhooks ──HTTP──> external endpoints (webhook delivery)
all services ──DB──> mongodb/mariadb/postgresql (configurable)
all services ──Redis──> redis
```

### What Dokkimi Should Target

**Auth boundary testing:** Create users, assign roles, create collections with permission rules. Test permission escalation — can a user with read access modify a document? Can a user access another user's files? Auth bugs in a platform 56k developers depend on would be significant.

**Function execution pipeline:** The API → openruntimes-executor HTTP call is a clean inter-service boundary. Deploy a function → invoke it → verify execution → check logs. Test timeout behavior, concurrent execution limits, and what happens when the executor is down.

**Screenshot/browser service:** The worker-screenshots → appwrite-browser HTTP call is another testable boundary. Test with malicious URLs, oversized pages, timeout behavior.

**Storage upload validation:** Upload files with spoofed MIME types, oversized files, zero-byte files. Test what happens when the storage worker is overloaded — are uploads queued or dropped?

**Rate limiting edge cases:** Appwrite has built-in rate limiting. Test boundary conditions — exactly at the limit, one over, rapid bursts, concurrent requests from different API keys.

**Cross-service event propagation:** Create a document → verify the realtime WebSocket broadcasts the event → verify the webhook worker delivers it → verify the audit worker logs it. This exercises the Redis pub/sub fan-out across 15 workers.

---

## 8. Authentik — Identity Provider (SSO/OAuth)

**Repo:** github.com/goauthentik/authentik
**Stars:** 22k | **Language:** Python (Django) + Go (server/outposts) + Rust (worker) | **Last active:** June 29, 2026 (v2026.5.3)
**What it is:** Open-source identity provider — SSO, OAuth2/OIDC, SAML, LDAP, RADIUS, MFA. Self-hosted alternative to Okta/Auth0. 456 contributors. The Go-based server binary spawns Django (Gunicorn) as a child process and reverse-proxies via Unix socket. Go outposts are standalone microservices that translate legacy protocols (LDAP, RADIUS) into HTTP calls to the core API. Recently removed Redis dependency — PostgreSQL-only in production. Growing fast in the self-hosted community (up from ~13k stars in 2024).

### Services

| Service            | Image                        | Port      | Role                                                           |
| ------------------ | ---------------------------- | --------- | -------------------------------------------------------------- |
| **server**         | `ghcr.io/goauthentik/server` | 9000/9443 | Go binary → spawns Gunicorn (Django) — web UI, API, auth flows |
| **worker**         | `ghcr.io/goauthentik/server` | —         | Background tasks: emails, SCIM sync, outpost auto-deployment   |
| **outpost-proxy**  | `ghcr.io/goauthentik/proxy`  | 9000/9443 | Go — OAuth2/OIDC reverse proxy for SSO                         |
| **outpost-ldap**   | `ghcr.io/goauthentik/ldap`   | 3389/6636 | Go — LDAP protocol adapter                                     |
| **outpost-radius** | `ghcr.io/goauthentik/radius` | 1812/udp  | Go — RADIUS protocol adapter                                   |
| **outpost-rac**    | `ghcr.io/goauthentik/rac`    | —         | Go — Remote Access (Guacamole-based RDP/SSH/VNC)               |
| **postgresql**     | `postgres:16-alpine`         | 5432      | Primary data store (also used for task queue and sessions)     |

**Data stores:** PostgreSQL only (Redis removed — task queue via `django-dramatiq-postgres`, sessions in PostgreSQL)

**Note:** Minimum production deployment is just **3 containers** (server, worker, PostgreSQL). Outpost containers are added as needed per protocol. The worker also has Docker socket access to auto-deploy outpost containers.

### Inter-Service Communication

```
Go server ──Unix socket──> Django/Gunicorn (reverse proxy all API/flow requests)
outpost-proxy ──HTTP/WebSocket──> server (AUTHENTIK_HOST — auth validation, config sync)
outpost-ldap ──HTTP/WebSocket──> server (LDAP bind → flow execution via REST API)
outpost-radius ──HTTP/WebSocket──> server (RADIUS auth → flow execution)
outpost-rac ──HTTP/WebSocket──> server (remote access session management)
worker ──Docker socket──> Docker daemon (outpost auto-deployment)
worker ──PostgreSQL──> postgresql (dramatiq task queue, no Redis)
server ──HTTP──> external providers (Google, GitHub, etc. — mockable)
```

### What Dokkimi Should Target

**OAuth/OIDC edge cases:** Token validation, redirect URI manipulation (open redirect), state parameter tampering, PKCE flow correctness, token expiry/refresh. The outpost-proxy → server HTTP/WebSocket calls are clean inter-service boundaries to intercept.

**Permission escalation:** Create users with different roles → test whether lower-privileged users can access admin endpoints, modify other users' sessions, or bypass flow requirements.

**LDAP/RADIUS protocol testing:** The Go outposts translate legacy protocols to HTTP calls to the Django server. Test LDAP bind operations, search queries, and RADIUS authentication — verify the protocol translation is faithful.

**Session handling:** Login → verify session → manipulate session token → verify rejection. Test concurrent sessions, session fixation. Sessions are now PostgreSQL-backed (no Redis) — test what happens under concurrent session creation load.

**SSRF in callback URLs:** OAuth flows accept callback URLs. Test for SSRF — can a malicious callback URL cause the server to make requests to internal services?

**Outpost ↔ server communication:** The WebSocket-based config sync between outposts and the core server is a testable boundary. What happens when the WebSocket drops? Does the outpost cache stale config? Can an outpost with a revoked token still serve requests?

**Demo narrative:** Auth bugs get shared on security Twitter, HackerNews, and InfoSec communities — a different audience than the dev tools crowd. Finding a permission leak or OAuth bypass in a 22k-star identity provider would cross over into security circles.

---

## 9. Formbricks — Survey & Form Platform

**Repo:** github.com/formbricks/formbricks
**Stars:** 12k | **Language:** TypeScript (Next.js) + Go (Hub) + Python (Taxonomy) | **Last active:** June 29, 2026 (v5.1.4)
**What it is:** Open-source survey platform — in-app surveys, website popups, link surveys, email surveys. Alternative to Typeform/Qualtrics. 321+ contributors. Smaller project with friendlier maintainers and faster response time on issues — 5 PRs merged on June 29 alone. Lower risk of contributions getting lost.

### Services

| Service                | Image                           | Port | Role                                                 |
| ---------------------- | ------------------------------- | ---- | ---------------------------------------------------- |
| **formbricks**         | `ghcr.io/formbricks/formbricks` | 3000 | Next.js app — survey builder, API                    |
| **hub**                | `ghcr.io/formbricks/hub`        | 8080 | Go API — taxonomy, embeddings, analytics             |
| **hub-worker**         | `ghcr.io/formbricks/hub`        | —    | Background job worker (embeddings, async tasks)      |
| **taxonomy**           | `ghcr.io/formbricks/taxonomy`   | 8000 | Python — AI-powered survey classification (optional) |
| **cube**               | `cubejs/cube`                   | 4000 | Cube.js semantic layer for analytics dashboards      |
| **postgres**           | `pgvector/pgvector:pg18`        | 5432 | PostgreSQL with pgvector extension                   |
| **redis**              | `valkey/valkey`                 | 6379 | Caching, rate limiting, audit logging                |
| **formbricks-migrate** | `ghcr.io/formbricks/formbricks` | —    | One-shot: Prisma DB migrations                       |
| **hub-migrate**        | `ghcr.io/formbricks/hub`        | —    | One-shot: goose + river DB migrations                |

**Data stores:** PostgreSQL (with pgvector), Valkey (Redis-compatible), RustFS (S3-compatible storage, dev)

**Dev-only services:** mailhog (email capture), rustfs (S3-compatible file storage), cube playground

### Inter-Service HTTP Calls

```
formbricks ──HTTP──> hub (HUB_API_URL — survey analytics, taxonomy, AI features)
formbricks ──HTTP──> cube (REST API — analytics dashboard queries, JWT-authenticated)
hub ──HTTP──> taxonomy (TAXONOMY_SERVICE_URL — AI classification)
taxonomy ──HTTP──> hub (HUB_INTERNAL_API_URL — callback with results)
cube ──Postgres──> postgres (analytics queries)
hub ──Postgres──> postgres (separate DB in dev, shared instance)
formbricks ──Prisma──> postgres (surveys, responses, users)
formbricks ──Redis──> redis (caching, rate limiting, audit log queuing)
```

### What Dokkimi Should Target

**Inter-service HTTP boundaries:** The formbricks → hub → taxonomy pipeline is a real multi-service chain with HTTP calls, authentication tokens, and callbacks. Test what happens when hub is slow, taxonomy returns unexpected classifications, or the callback fails.

**Form data validation:** Submit surveys with malformed data, oversized responses, special characters, XSS payloads. Does the API validate consistently across all question types? Recent PR "harden server-side validation on survey response submission" suggests this is an active concern.

**Survey logic branching:** Create surveys with conditional logic (if answer A, show question 3; if answer B, skip to question 5). Test edge cases — circular logic, unreachable questions, branches that skip required fields.

**Response submission tampering:** Submit responses directly to the API, bypassing the frontend. Can you submit responses to closed surveys? Can you submit duplicate responses when deduplication is enabled?

**Analytics pipeline:** The formbricks → cube → postgres analytics chain is testable. Verify that survey responses are correctly aggregated, that cube queries return accurate results, and that the JWT authentication between services is enforced.

**Visual regression testing:** Survey UIs have specific rendering requirements (progress bars, conditional visibility, mobile layouts). Good candidate for screenshot-based visual regression with Dokkimi's browser features.

**Demo narrative:** Smaller, friendlier community means faster feedback loop on issues. The multi-service architecture (web → hub → taxonomy) is richer than expected for a 12k-star project — good inter-service testing surface without the complexity of a 19-container Appwrite setup.

---

## Recommendation

### Tier 1: Top Picks (if picking three)

**Cal.diy (46k stars) — Scheduling**
Unique angle: browser automation and visual regression testing. Booking logic edge cases are universally relatable. None of the existing reports use Dokkimi's E2E browser features — this fills that gap. Also has a real inter-service HTTP boundary (Next.js → NestJS API v2 proxy). "How I found a double-booking bug in Cal.diy" travels far.

**Medusa (35k stars) — E-Commerce**
Richest API testing surface on the list. Cart logic, inventory validation, pricing/discount stacking, multi-currency, refund flows. Reuses Stripe mocking patterns from Hyperswitch. The validation inconsistency approach from Lago maps perfectly here. **Caveat:** Modular monolith (single Node.js process) — no inter-service HTTP traffic to intercept. Value is in API-layer and DB-interaction testing, not service mesh testing.

**Appwrite (56k stars) — Infrastructure/BaaS**
Highest star count = maximum eyeballs. ~28 Docker containers with clean inter-service HTTP boundaries (API → executor, worker → browser, Redis pub/sub → 15 workers). Auth boundary testing, permission escalation, and storage validation in a platform 56k developers depend on. $37M raised.

### Tier 2: Specialized Picks

**Authentik (22k stars) — Security/Identity**
Security-focused projects get disproportionate attention when bugs are found. Auth bugs cross over into security Twitter, HackerNews, and InfoSec communities. The Go outpost → Django server HTTP/WebSocket calls are clean inter-service boundaries. PostgreSQL-only stack (no Redis) simplifies setup.

**Formbricks (12k stars) — Forms/Surveys**
Wildcard pick with surprisingly rich architecture (web → hub → taxonomy HTTP chain). Smaller project, friendlier maintainers, faster issue response. Lower risk of contributions getting buried. Ideal starter target.

### Previous Picks (still valid)

**Hyperswitch (43k stars) — Payments:** Most distinct HTTP inter-service calls. Producer/consumer/drainer pipeline.
**Lago (10k stars) — Billing:** Clean api → pdf service boundary. Usage metering edge cases.
**Plane (53k stars) — Project Management:** Relatable domain, multiple frontends through proxy.
**Saleor (23k stars) — E-Commerce:** GraphQL API, checkout → order → webhook flow.

---

## Startup Time Considerations

| Project     | Stack                     | Expected Cold Start                |
| ----------- | ------------------------- | ---------------------------------- |
| Hyperswitch | Rust                      | Fast (seconds)                     |
| Cal.diy     | Next.js                   | Moderate (~10-20s)                 |
| Medusa      | Node.js                   | Moderate (~10-20s)                 |
| Appwrite    | PHP/Swoole + Go + Rust    | Moderate (~30-60s, ~28 containers) |
| Authentik   | Python (Django) + Go      | Moderate (~15-30s)                 |
| Formbricks  | Next.js + Go + Python     | Moderate (~15-25s)                 |
| Plane       | Python (Django) + Next.js | Moderate (~15-30s)                 |
| Lago        | Ruby on Rails             | Moderate (~20-40s, plus migration) |
| Saleor      | Python (Django)           | Moderate (~15-30s)                 |

---

## Domain Diversity Matrix

| Domain           | Project     | Stars | Dokkimi Feature Showcase                                 |
| ---------------- | ----------- | ----- | -------------------------------------------------------- |
| Scheduling       | Cal.diy     | 46k   | Browser automation, visual regression                    |
| E-Commerce       | Medusa      | 35k   | API edge cases, payment mocking (modular monolith)       |
| Infrastructure   | Appwrite    | 56k   | ~28 containers, inter-service HTTP, auth boundaries      |
| Payments         | Hyperswitch | 43k   | HTTP inter-service calls, scheduler pipeline             |
| Identity/Auth    | Authentik   | 22k   | Protocol testing, outpost↔server, security edge cases    |
| Billing          | Lago        | 10k   | Service boundaries (api→pdf), metering                   |
| Project Mgmt     | Plane       | 53k   | Proxy routing, async workers                             |
| E-Commerce (GQL) | Saleor      | 23k   | GraphQL interception, inventory race conditions          |
| Forms/Surveys    | Formbricks  | 12k   | Inter-service HTTP (web→hub→taxonomy), visual regression |
