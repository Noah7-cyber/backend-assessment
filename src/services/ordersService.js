const ordersRepository = require("../repositories/ordersRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");

async function createOrder({ customerId, amount }) {
  if (!customerId || !amount || Number(amount) <= 0) {
    const error = new Error("customerId and positive amount are required");
    error.status = 400;
    throw error;
  }

  return ordersRepository.createOrder({
    customerId,
    amount: Number(amount),
  });
}

async function handleExistingIdempotency({ existing, orderId }) {
  if (Number(existing.orderId) !== Number(orderId)) {
    const error = new Error("Idempotency key is already used for a different order");
    error.status = 409;
    throw error;
  }

  if (existing.status === "COMPLETED" && existing.response) {
    return existing.response;
  }

  const error = new Error("A request with this idempotency key is already in progress or failed");
  error.status = 409;
  throw error;
}

async function claimOrder(orderId) {
  const order = await ordersRepository.claimOrderForProcessing(orderId);
  if (order) {
    return order;
  }

  const current = await ordersRepository.getOrderById(orderId);
  if (!current) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }

  const error = new Error("Only pending orders can be charged");
  error.status = 409;
  throw error;
}

async function chargeOrder({ orderId, idempotencyKey }) {
  let idempotencyOwned = false;
  if (idempotencyKey) {
    const created = await paymentsRepository.createIdempotencyKeyIfNotExists({
      idempotencyKey,
      orderId,
    });

    if (!created) {
      const existing = await paymentsRepository.getIdempotencyKey(idempotencyKey);
      return handleExistingIdempotency({ existing, orderId });
    }

    idempotencyOwned = true;
  }

  const order = await claimOrder(orderId);

  try {
    const gatewayResponse = await paymentGateway.charge({
      orderId: order.id,
      amount: order.amount,
    });

    const payment = await paymentsRepository.createPayment({
      orderId: order.id,
      amount: gatewayResponse.chargedAmount,
      providerTxnId: gatewayResponse.providerTxnId,
      status: "SUCCESS",
    });

    const updatedOrder = await ordersRepository.markOrderAsPaidIfProcessing(order.id);
    if (!updatedOrder) {
      throw new Error("Order status changed unexpectedly during charge completion");
    }

    const result = {
      order: updatedOrder,
      payment,
    };

    if (idempotencyKey && idempotencyOwned) {
      await paymentsRepository.markIdempotencyCompleted({
        idempotencyKey,
        response: result,
      });
    }

    return result;
  } catch (error) {
    await ordersRepository.resetOrderToPendingIfProcessing(orderId);

    if (idempotencyKey && idempotencyOwned) {
      await paymentsRepository.markIdempotencyFailed({
        idempotencyKey,
        errorMessage: error.message,
      });
    }

    throw error;
  }
}

async function processPaymentWebhook({ providerEventId, orderId, eventType, payload }) {
  if (!providerEventId || !orderId || !eventType) {
    const error = new Error("providerEventId, orderId and eventType are required");
    error.status = 400;
    throw error;
  }

  const result = await paymentsRepository.createWebhookEventIfNotExists({
    providerEventId,
    orderId,
    eventType,
    payload,
  });

  if (!result.inserted) {
    return { accepted: true, duplicate: true };
  }

  if (eventType === "payment_succeeded") {
    await ordersRepository.markOrderAsPaidIfNotPaid(orderId);
  }

  return { accepted: true, duplicate: false };
}

async function getOrderById(orderId) {
  const order = await ordersRepository.getOrderWithPayments(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }
  return order;
}

module.exports = {
  createOrder,
  chargeOrder,
  processPaymentWebhook,
  getOrderById,
};
