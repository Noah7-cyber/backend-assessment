# Backend Assessment – Senior (Node.js/Express)

This repository contains my solution to the backend assessment.

The original starter API was partially functional, but had hidden logical/data-integrity bugs under concurrency and retries.  
The focus of my solution is correctness under real-world failure modes — not just passing happy-path requests.

---

## Background (Original Assessment Context)

This project models a simple payment lifecycle:

- Orders are created
- Payments are charged
- Payment webhooks update order state

The initial implementation could lead to:

- double-charging
- inconsistent order/payment records
- race conditions during retries

Evaluation focus areas were:

- correctness and data integrity
- concurrency safety
- retry/idempotency behavior
- test quality and production judgment

---

## 🧠 Debugging Note (Most Important Real Bug Found)

A subtle idempotency bug appeared during manual verification:

1. Charge order `5` with key `fresh-key-5` → success  
2. Retry same request (same key + same order)  
3. API incorrectly returned: **“Idempotency key is already used for a different order”**

### Root cause

- PostgreSQL `BIGINT` often comes back as a string (e.g. `"5"`)
- Request payload `orderId` is numeric (e.g. `5`)
- Strict comparison treated them as different (`"5" !== 5`)

### Fix

- Normalize IDs before comparison in idempotency checks
- Normalize `orderId` mapping in repository layer so service logic gets consistent numeric IDs

This issue did not reliably surface in mocked tests; it appeared when exercising real DB-backed behavior — exactly the kind of thing financial flows need to guard against.

---

## ⚙️ Tech Stack

- Node.js + Express
- PostgreSQL (**primary source of truth**)
- Redis (present in the project; correctness is no longer dependent on Redis idempotency behavior)

---

## ✅ What Was Found

The starter code had several critical issues:

- non-atomic charge flow allowed concurrent double processing
- Redis idempotency pattern (`GET` then `SET`) had race windows and no durability guarantees
- webhook replay/deduplication was not durably enforced
- order/payment state could diverge across failure windows
- key invariants were not fully protected at the DB level

---

## 🧩 Why It Happened

Primary causes:

- critical invariants enforced in app code instead of PostgreSQL constraints
- read-then-write state transitions without guarded/atomic progression
- retry/replay handling without conflict-safe persistence patterns

---

## 🛠️ What I Changed

### 1) Guarded order state transitions

Implemented controlled state flow:

`PENDING -> PROCESSING -> PAID`

This prevents multiple charge paths from progressing simultaneously for the same order.

---

### 2) Durable idempotency in PostgreSQL

Added `idempotency_keys` table and idempotency lifecycle handling in Postgres, so replay correctness is durable and not dependent on Redis timing.

---

### 3) Database-level invariants

Added/updated DB constraints:

- unique `payments.provider_txn_id`
- one successful payment per order
- unique `payment_events.provider_event_id`
- order status constraint includes `PROCESSING`

---

### 4) Webhook replay safety

Webhook ingestion uses conflict-safe insert (`ON CONFLICT DO NOTHING`) so duplicate deliveries become safe no-op behavior.

---

### 5) Regression tests

Added tests for:

- concurrent charge contention behavior
- idempotency replay behavior
- webhook duplicate handling
- failure rollback/recovery behavior
- integration flow validating same-key same-order idempotent retry against Postgres-backed path

> Integration test is designed to skip when PostgreSQL is unreachable in the execution environment.

---

## ✅ Why This Is Safer

- correctness-critical invariants are enforced by PostgreSQL
- payment execution requires an atomic order claim
- duplicate/replayed operations become deterministic no-op behavior
- system behavior is stable under retries and concurrent attempts

---

## ⚠️ Trade-offs / Remaining Risks

- Provider network call still occurs outside DB transaction boundaries (intentional, to avoid long-lived DB locks)
- If provider succeeds but local persistence fails immediately afterward, reconciliation is still required
- `FAILED` idempotency keys currently require using a new key for retry

---

## 🚀 Running the Project

### 1) Install dependencies

```bash
npm install
2) Copy env file
cp .env.example .env
3) Start infrastructure
docker compose up -d
4) Run migration + seed
npm run db:migrate
npm run db:seed
5) Start API
npm run dev
Health check:

GET /health
📡 API Endpoints
Create Order
POST /orders

{
  "customerId": "customer_001",
  "amount": 120.5
}
Get Order
GET /orders/:id

Charge Payment
POST /payments/charge

{
  "orderId": 1
}
Optional header:

Idempotency-Key: abc-123
Payment Webhook
POST /payments/webhook

{
  "providerEventId": "evt-1",
  "orderId": 1,
  "eventType": "payment_succeeded",
  "payload": {}
}
🧪 Test Commands
Unit tests:

npm test
Integration test:

npm run test:integration
