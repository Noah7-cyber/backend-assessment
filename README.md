# Backend Assessment - Senior (Node.js/Express)

This repository is a pre-interview backend assessment starter.

The API is partially working, but contains hidden logical bugs.
There are no syntax traps. Focus is on correctness under concurrency and failure.

## Scenario

- Orders are created
- Payments are processed
- A payment webhook updates order status
- Some cases can lead to:
  - double-charging
  - missing consistency across order/payment records
  - race conditions

## Tech

- Node.js + Express
- PostgreSQL required
- Redis included and used for idempotency cache

Candidates may replace parts with their preferred approach if justified.

## Run

1. Install dependencies:

```bash
npm install
```

2. Copy env:

```bash
cp .env.example .env
```

3. Start infra:

```bash
docker compose up -d
```

4. Run DB migration and seed:

```bash
npm run db:migrate
npm run db:seed
```

5. Start API:

```bash
npm run dev
```

Health endpoint:

```bash
GET /health
```

## Endpoints

- `POST /orders`
  - body: `{ "customerId": "customer_001", "amount": 120.5 }`
- `GET /orders/:id`
- `POST /payments/charge`
  - body: `{ "orderId": 1 }`
  - optional header: `Idempotency-Key: abc-123`
- `POST /payments/webhook`
  - body example:
    `{ "providerEventId": "evt-1", "orderId": 1, "eventType": "payment_succeeded", "payload": {} }`

## Candidate Task (8h max)

1. Identify as many critical logical/data-integrity issues as possible.
2. Fix the issues with production-appropriate changes.
3. Add tests proving fixes, especially for concurrency/idempotency paths.
4. Write a short explanation:
   - what issues were found
   - why they happen
   - why your fix is safe
   - what trade-offs remain

## Evaluation Focus

- Correctness and data integrity
- Concurrency safety
- Retry/idempotency behavior
- Quality of tests and reasoning
- Practical production judgment

## Correctness Fix Summary

### 1) What was found

- Charge flow allowed concurrent double-charging due to non-atomic read/check/write behavior.
- Redis idempotency was a race-prone GET/SET pattern and not durable.
- Webhooks were not deduplicated.
- Order/payment updates could diverge under failure windows.
- Database constraints were missing for key uniqueness guarantees.

### 2) Why it happened

- Critical invariants were enforced mainly in application logic and not by PostgreSQL constraints.
- State transitions were unconditional and not guarded by current status.
- Retry/replay paths lacked conflict-safe insert patterns.

### 3) What was changed

- Added guarded order transitions (`PENDING -> PROCESSING -> PAID`) in repository methods.
- Added durable idempotency tracking in PostgreSQL (`idempotency_keys` table).
- Added uniqueness constraints/indexes for `payments.provider_txn_id`, one successful payment per order, and `payment_events.provider_event_id`.
- Updated webhook processing to use conflict-safe insert (`ON CONFLICT DO NOTHING`) and duplicate-safe behavior.
- Added regression tests for concurrent charge behavior, idempotency behavior, webhook replay safety, and failure recovery paths.

### 4) Why the fix is safe

- PostgreSQL now enforces critical uniqueness invariants directly.
- Charge execution requires an atomic claim of the order (`status = 'PENDING'`), preventing concurrent charge paths from both progressing.
- Duplicate webhook deliveries become no-op side effects.
- Idempotency is durable and no longer depends on Redis correctness.

### 5) Trade-offs / remaining risks

- The external provider charge call is still outside DB transaction boundaries (intentional to avoid long-running DB transactions over network I/O).
- If provider succeeds but local persistence fails immediately afterward, manual reconciliation may still be needed without provider-side idempotency support.
- Idempotency entries marked `FAILED` currently require a new key to retry safely.
