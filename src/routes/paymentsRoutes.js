const express = require("express");
const ordersService = require("../services/ordersService");

const router = express.Router();

router.post("/charge", async (req, res, next) => {
  try {
    const orderId = Number(req.body.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      const error = new Error("A valid numeric orderId is required");
      error.status = 400;
      throw error;
    }

    const result = await ordersService.chargeOrder({
      orderId,
      idempotencyKey: req.headers["idempotency-key"],
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/webhook", async (req, res, next) => {
  try {
    const result = await ordersService.processPaymentWebhook(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
