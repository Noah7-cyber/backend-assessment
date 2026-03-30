const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const app = require("../src/app");
const pool = require("../src/db/postgres");
const paymentGateway = require("../src/services/paymentGateway");

let server;
let dbAvailable = true;
const originalCharge = paymentGateway.charge;

async function jsonRequest(baseUrl, route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    parsed = JSON.parse(text);
  }

  return {
    status: response.status,
    body: parsed,
  };
}

test.before(async () => {
  try {
    const schemaPath = path.join(__dirname, "../src/db/schema.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf8");
    await pool.query(schemaSql);

    server = app.listen(0);

    paymentGateway.charge = async ({ orderId, amount }) => ({
      providerTxnId: `itxn_${orderId}_${Date.now()}`,
      chargedAmount: amount,
      settledAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error.code === "ECONNREFUSED") {
      dbAvailable = false;
      return;
    }
    throw error;
  }
});

test.after(async () => {
  paymentGateway.charge = originalCharge;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.beforeEach(async () => {
  if (!dbAvailable) {
    return;
  }
  await pool.query("DELETE FROM idempotency_keys");
  await pool.query("DELETE FROM payments");
  await pool.query("DELETE FROM payment_events");
  await pool.query("DELETE FROM orders");
});

test("retrying same idempotency key for the same order returns cached success", async (t) => {
  if (!dbAvailable) {
    t.skip("PostgreSQL is not reachable in this environment");
    return;
  }

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createOrder = await jsonRequest(baseUrl, "/orders", {
    method: "POST",
    body: { customerId: "customer_integration", amount: 150.25 },
  });

  assert.equal(createOrder.status, 201);
  assert.ok(createOrder.body.id);

  const idempotencyKey = "fresh-key-5";

  const firstCharge = await jsonRequest(baseUrl, "/payments/charge", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: { orderId: createOrder.body.id },
  });

  assert.equal(firstCharge.status, 200);
  assert.equal(firstCharge.body.order.id, createOrder.body.id);
  assert.equal(firstCharge.body.order.status, "PAID");
  assert.ok(firstCharge.body.payment.id);

  const retryCharge = await jsonRequest(baseUrl, "/payments/charge", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: { orderId: createOrder.body.id },
  });

  assert.equal(retryCharge.status, 200);
  assert.deepEqual(retryCharge.body, firstCharge.body);
});
