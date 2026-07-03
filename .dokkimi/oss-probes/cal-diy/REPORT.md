# Cal.diy Bug Report

**Project:** [Cal.diy](https://github.com/calcom/cal.com) (formerly Cal.com)
**Stars:** ~46k | **License:** MIT (AGPLv3 for some packages)
**Version analyzed:** v6.2.0+ (latest main branch as of 2026-07-01)
**Image tested:** `calcom/cal.com:latest` (amd64, Rosetta on Apple Silicon)

---

## Bug 1: Date Object Mutation in API Key Expiry Check

**Severity:** Medium | **Status:** CONFIRMED (test passes)
**File:** `apps/api/v2/src/modules/auth/strategies/api-auth/api-auth.strategy.ts`
**Line:** ~245

### Description

The API key expiration check uses `Date.setHours()` which mutates the Date
object in place:

```typescript
const isKeyExpired =
  keyData.expiresAt &&
  new Date().setHours(0, 0, 0, 0) > keyData.expiresAt.setHours(0, 0, 0, 0);
```

Two problems:

1. **Mutation side effect:** `keyData.expiresAt.setHours(0, 0, 0, 0)` mutates
   the actual `expiresAt` Date object on `keyData`. If this object is used
   later in the request lifecycle (logging, response headers, audit trail),
   it will show midnight instead of the actual expiry time.

2. **Day-granularity comparison:** Both sides are zeroed to midnight, so a key
   with `expiresAt` set to midnight today (start of day) passes as valid
   because `midnight > midnight` is false. The check effectively gives every
   key an extra ~24 hours of validity beyond its intended expiry.

### Fix

```typescript
const isKeyExpired = keyData.expiresAt && new Date() > keyData.expiresAt;
```

### Dokkimi test

**Definition:** `04-apikey-expiry-date-mutation.yaml`

Creates an admin user via the web app, inserts an API key with
`expiresAt = CURRENT_DATE` (midnight today — already expired), verifies
via SQL that `expiresAt < NOW()` is true, then hits `GET /v2/me` on
the API v2 server with that key. The endpoint returns 200, proving the
expired key is accepted.

---

## Bug 2: ROLLING_WINDOW Period Bypass on Booking Endpoint

**Severity:** Medium | **Status:** CONFIRMED (test passes)
**File:** `packages/lib/isOutOfBounds.tsx`
**Line:** 373-374

### Description

Event types with `periodType = ROLLING_WINDOW` limit bookings to the next N
bookable days. The frontend enforces this by hiding out-of-bounds slots, but
the server-side validation in `isOutOfBounds()` skips the check entirely:

```typescript
const periodLimits = calculatePeriodLimits({
  // ...
  allDatesWithBookabilityStatusInBookerTz: null, // Temporary workaround
  _skipRollingWindowCheck: true,
});
```

The code comment on `_skipRollingWindowCheck` acknowledges the gap:

> "It is okay for handleNewBooking to pass it as true as the frontend won't
> allow selecting a timeslot that is out of bounds of ROLLING_WINDOW.
> But for the booking that happen through API, we absolutely need to check
> the ROLLING_WINDOW limits."

A direct `POST /api/book/event` request bypasses the frontend and can book
any future date regardless of the ROLLING_WINDOW restriction.

Note: `ROLLING` (plain rolling window) and `RANGE` period types ARE enforced
server-side. Only `ROLLING_WINDOW` is affected.

### Fix

Compute `allDatesWithBookabilityStatusInBookerTz` in the booking handler
and pass it to `calculatePeriodLimits` instead of `null`, or implement a
simpler server-side check that verifies the requested date falls within
the rolling window without requiring the full availability map.

### Dokkimi test

**Definition:** `05-rolling-window-bypass.yaml`

Creates an event type with `periodType = 'rolling_window'` and
`periodDays = 2` (only the next 2 bookable days should be available).
Then books a slot 90 days in the future via `POST /api/book/event`.
The booking succeeds (200) and appears in the database, proving the
ROLLING_WINDOW restriction is not enforced server-side.

---

## Bug 3: Setup Endpoint Race Condition Creates Multiple Admin Users

**Severity:** High | **Status:** CONFIRMED (test passes)
**File:** `apps/web/app/api/auth/setup/route.ts`
**Lines:** 29-57

### Description

The `/api/auth/setup` endpoint is meant to create only the first admin user
on a fresh Cal.com instance. It checks `prisma.user.count() === 0` before
creating the user. However, this is a classic TOCTOU (Time-of-check to
Time-of-use) race condition:

```typescript
const userCount = await prisma.user.count(); // CHECK
if (userCount !== 0) {
  throw new HttpError({ statusCode: 400, message: 'No setup needed.' });
}
// ... validation, password hashing ...
await prisma.user.create({
  // USE
  data: {
    // ...
    role: 'ADMIN',
  },
});
```

Between the `count()` check and the `create()` call (~50ms for password
hashing), concurrent requests can all see `userCount === 0` and each
create their own admin user. Since the requests use different email
addresses and usernames, no unique constraint prevents them.

This is exploitable during the initial setup window of any self-hosted
Cal.com instance. An attacker monitoring for new deployments could race
the legitimate admin's setup request to plant their own admin account.

### Fix

Use a database-level advisory lock or `INSERT ... WHERE NOT EXISTS` pattern
to make the check-and-create atomic:

```typescript
await prisma.$transaction(async (tx) => {
  const userCount = await tx.user.count();
  if (userCount !== 0) {
    throw new HttpError({ statusCode: 400, message: "No setup needed." });
  }
  await tx.user.create({ data: { ... } });
});
```

### Dokkimi test

**Definition:** `06-setup-race-condition.yaml`

Sends 5 concurrent `POST /api/auth/setup` requests to a fresh Cal.com
instance, each with different email/username credentials. Then counts
admin users in the database. The count is > 1, proving multiple admin
accounts were created through the race window.

---

## Investigated and Ruled Out

### Double-Booking Race Condition — MITIGATED

**File:** `packages/features/bookings/lib/service/RegularBookingService.ts`

The booking flow has a classic TOCTOU pattern: `ensureAvailableUsers()`
runs at line ~917 (no transaction), while `createBooking()` runs at line
~1707 inside a `prisma.$transaction`. The availability check and the
booking write are ~800 lines apart with no transactional protection.

However, Cal.com has a **Prisma extension** at
`packages/prisma/extensions/booking-idempotency-key.ts` that generates
a deterministic `idempotencyKey` via UUIDv5 from `(startTime, endTime, hostUserId)`.
Since `idempotencyKey` is `@unique` on the `Booking` model, concurrent
booking creates for the same time slot collide at the database level —
the first succeeds and subsequent attempts get a unique constraint error.

**Test result:** 5 concurrent `POST /api/book/event` requests for the
same slot → 1 accepted booking, 4 returned `400 "An error occurred
while querying the database"`. The idempotency key defense works.

**Definition:** `02-double-booking-race.yaml`

### Slot Reservation Race Condition — NOT EXPLOITABLE

**File:** `packages/trpc/server/routers/viewer/slots/reserveSlot.handler.ts`

`findReservedByOthers()` (READ at line 68) and `upsert` (WRITE at line 84)
run as separate DB operations with no transaction. However, the upsert
completes in ~1ms, and Node.js single-threaded event loop serializes the
critical path tightly enough that subsequent requests always see the
existing reservation before upserting.

**Test result:** 5 concurrent `POST /api/trpc/slots/reserveSlot` requests
with different UIDs → all returned 200, but only 1 `SelectedSlots` row
was created (the first request's). The other 4 found the existing
reservation via `findReservedByOthers` and silently skipped the upsert.

**Definition:** `03-slot-reservation-race.yaml`

### User ID Injection in Booking Confirmation — NOT A BUG

`/api/verify-booking-token` accepts `userId` as a URL query parameter,
which looked like an injection vector. However, `confirmHandler` calls
`BookingAccessService.doesUserIdHaveAccessToBooking()` which verifies
the user is the booking organizer, a host, or a team admin before
allowing confirmation. A mismatched `userId` gets a 401.

### Legacy ApiKeyService Date Mutation — DEAD CODE

`packages/features/api-keys-legacy/api-keys/services/ApiKeyService.ts`
has the same `setHours()` mutation bug as the API v2 version, but nothing
imports this class. The web app does not use API key authentication —
it uses NextAuth sessions exclusively. The only live copy of this bug
is in the API v2 NestJS auth strategy.

---

## Stack Setup

```
cal-postgres  (PostgreSQL 15) ─── calendso database
cal-redis     (Redis 7)
calcom        (calcom/cal.com:latest, port 3000, stage 1)
calcom-api    (calcom/api-v2:local, port 5555, stage 1) — built from apps/api/v2/Dockerfile
```

The Cal.diy Docker image runs Prisma migrations on boot (~40-60s startup).
Health check: `GET /api/version` (web), `GET /health` (API v2).

## Definitions

| File                                  | Description                                         | Status     |
| ------------------------------------- | --------------------------------------------------- | ---------- |
| `01-smoke-test.yaml`                  | Version, CSRF, session, username check              | Passed     |
| `02-double-booking-race.yaml`         | Concurrent booking — idempotency key prevents dupes | Ruled out  |
| `03-slot-reservation-race.yaml`       | Concurrent slot reservation — race too narrow       | Ruled out  |
| `04-apikey-expiry-date-mutation.yaml` | Expired API key accepted (setHours bug)             | **Passed** |
| `05-rolling-window-bypass.yaml`       | ROLLING_WINDOW period not enforced server-side      | **Passed** |
| `06-setup-race-condition.yaml`        | Concurrent setup creates multiple admin users       | **Passed** |
