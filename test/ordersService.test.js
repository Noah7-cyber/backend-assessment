const test = require("node:test");
const assert = require("node:assert/strict");

const ordersRepository = require("../src/repositories/ordersRepository");
const paymentsRepository = require("../src/repositories/paymentsRepository");
const paymentGateway = require("../src/services/paymentGateway");
const ordersService = require("../src/services/ordersService");

const originals = {
  claimOrderForProcessing: ordersRepository.claimOrderForProcessing,
  getOrderById: ordersRepository.getOrderById,
  markOrderAsPaidIfProcessing: ordersRepository.markOrderAsPaidIfProcessing,
  markOrderAsPaidIfNotPaid: ordersRepository.markOrderAsPaidIfNotPaid,
  resetOrderToPendingIfProcessing: ordersRepository.resetOrderToPendingIfProcessing,
  createPayment: paymentsRepository.createPayment,
  createWebhookEventIfNotExists: paymentsRepository.createWebhookEventIfNotExists,
  createIdempotencyKeyIfNotExists: paymentsRepository.createIdempotencyKeyIfNotExists,
  getIdempotencyKey: paymentsRepository.getIdempotencyKey,
  markIdempotencyCompleted: paymentsRepository.markIdempotencyCompleted,
  markIdempotencyFailed: paymentsRepository.markIdempotencyFailed,
  charge: paymentGateway.charge,
};

function restore() {
  Object.assign(ordersRepository, {
    claimOrderForProcessing: originals.claimOrderForProcessing,
    getOrderById: originals.getOrderById,
    markOrderAsPaidIfProcessing: originals.markOrderAsPaidIfProcessing,
    markOrderAsPaidIfNotPaid: originals.markOrderAsPaidIfNotPaid,
    resetOrderToPendingIfProcessing: originals.resetOrderToPendingIfProcessing,
  });

  Object.assign(paymentsRepository, {
    createPayment: originals.createPayment,
    createWebhookEventIfNotExists: originals.createWebhookEventIfNotExists,
    createIdempotencyKeyIfNotExists: originals.createIdempotencyKeyIfNotExists,
    getIdempotencyKey: originals.getIdempotencyKey,
    markIdempotencyCompleted: originals.markIdempotencyCompleted,
    markIdempotencyFailed: originals.markIdempotencyFailed,
  });

  paymentGateway.charge = originals.charge;
}

test.afterEach(() => {
  restore();
});

test("concurrent charge attempts only allow one claim and one gateway charge", async () => {
  let claimCount = 0;
  let chargeCount = 0;

  ordersRepository.claimOrderForProcessing = async () => {
    claimCount += 1;
    if (claimCount === 1) {
      return { id: 1, amount: 100, status: "PROCESSING" };
    }
    return null;
  };
  ordersRepository.getOrderById = async () => ({ id: 1, status: "PROCESSING" });
  paymentGateway.charge = async () => {
    chargeCount += 1;
    return { providerTxnId: "txn_1", chargedAmount: 100 };
  };
  paymentsRepository.createPayment = async () => ({ id: 10, orderId: 1, status: "SUCCESS" });
  ordersRepository.markOrderAsPaidIfProcessing = async () => ({ id: 1, status: "PAID" });

  const [first, second] = await Promise.allSettled([
    ordersService.chargeOrder({ orderId: 1 }),
    ordersService.chargeOrder({ orderId: 1 }),
  ]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.status, 409);
  assert.equal(chargeCount, 1);
});

test("idempotency key returns completed response without charging", async () => {
  const cachedResponse = { order: { id: 1, status: "PAID" }, payment: { id: 2 } };
  let chargeCount = 0;

  paymentsRepository.createIdempotencyKeyIfNotExists = async () => null;
  paymentsRepository.getIdempotencyKey = async () => ({
    idempotencyKey: "idem-1",
    orderId: 1,
    status: "COMPLETED",
    response: cachedResponse,
  });
  paymentGateway.charge = async () => {
    chargeCount += 1;
  };

  const result = await ordersService.chargeOrder({ orderId: 1, idempotencyKey: "idem-1" });

  assert.deepEqual(result, cachedResponse);
  assert.equal(chargeCount, 0);
});

test("failed charge resets order and marks idempotency failed", async () => {
  let resetCalled = 0;
  let failedArgs;

  paymentsRepository.createIdempotencyKeyIfNotExists = async () => ({
    idempotencyKey: "idem-2",
    orderId: 1,
    status: "IN_PROGRESS",
  });
  ordersRepository.claimOrderForProcessing = async () => ({ id: 1, amount: 100, status: "PROCESSING" });
  paymentGateway.charge = async () => {
    throw new Error("Provider timeout while charging card");
  };
  ordersRepository.resetOrderToPendingIfProcessing = async () => {
    resetCalled += 1;
    return { id: 1 };
  };
  paymentsRepository.markIdempotencyFailed = async (args) => {
    failedArgs = args;
  };

  await assert.rejects(
    () => ordersService.chargeOrder({ orderId: 1, idempotencyKey: "idem-2" }),
    /Provider timeout while charging card/
  );

  assert.equal(resetCalled, 1);
  assert.deepEqual(failedArgs, {
    idempotencyKey: "idem-2",
    errorMessage: "Provider timeout while charging card",
  });
});

test("duplicate webhook event is accepted without duplicate side effects", async () => {
  let markPaidCalls = 0;

  paymentsRepository.createWebhookEventIfNotExists = async () => ({ inserted: false, event: null });
  ordersRepository.markOrderAsPaidIfNotPaid = async () => {
    markPaidCalls += 1;
  };

  const result = await ordersService.processPaymentWebhook({
    providerEventId: "evt_1",
    orderId: 1,
    eventType: "payment_succeeded",
    payload: {},
  });

  assert.deepEqual(result, { accepted: true, duplicate: true });
  assert.equal(markPaidCalls, 0);
});

test("new payment_succeeded webhook marks order paid once", async () => {
  let markPaidCalls = 0;

  paymentsRepository.createWebhookEventIfNotExists = async () => ({
    inserted: true,
    event: { providerEventId: "evt_1" },
  });
  ordersRepository.markOrderAsPaidIfNotPaid = async () => {
    markPaidCalls += 1;
    return { id: 1, status: "PAID" };
  };

  const result = await ordersService.processPaymentWebhook({
    providerEventId: "evt_1",
    orderId: 1,
    eventType: "payment_succeeded",
    payload: {},
  });

  assert.deepEqual(result, { accepted: true, duplicate: false });
  assert.equal(markPaidCalls, 1);
});
