const pool = require("../db/postgres");

async function createPayment({ orderId, amount, providerTxnId, status = "SUCCESS" }) {
  const query = `
    INSERT INTO payments (order_id, amount, provider_txn_id, status)
    VALUES ($1, $2, $3, $4)
    RETURNING id, order_id AS "orderId", amount, provider_txn_id AS "providerTxnId", status, created_at AS "createdAt"
  `;
  const { rows } = await pool.query(query, [orderId, amount, providerTxnId, status]);
  return rows[0];
}

async function createWebhookEventIfNotExists({ providerEventId, orderId, eventType, payload }) {
  const query = `
    INSERT INTO payment_events (provider_event_id, order_id, event_type, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider_event_id) DO NOTHING
    RETURNING id, provider_event_id AS "providerEventId", order_id AS "orderId", event_type AS "eventType", created_at AS "createdAt"
  `;
  const { rows } = await pool.query(query, [
    providerEventId,
    orderId,
    eventType,
    JSON.stringify(payload || {}),
  ]);

  return {
    inserted: Boolean(rows[0]),
    event: rows[0] || null,
  };
}

async function createIdempotencyKeyIfNotExists({ idempotencyKey, orderId }) {
  const query = `
    INSERT INTO idempotency_keys (idempotency_key, order_id, status)
    VALUES ($1, $2, 'IN_PROGRESS')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key AS "idempotencyKey", order_id AS "orderId", status, response
  `;
  const { rows } = await pool.query(query, [idempotencyKey, orderId]);
  return rows[0] || null;
}

async function getIdempotencyKey(idempotencyKey) {
  const query = `
    SELECT idempotency_key AS "idempotencyKey", order_id AS "orderId", status, response
    FROM idempotency_keys
    WHERE idempotency_key = $1
  `;
  const { rows } = await pool.query(query, [idempotencyKey]);
  return rows[0] || null;
}

async function markIdempotencyCompleted({ idempotencyKey, response }) {
  const query = `
    UPDATE idempotency_keys
    SET status = 'COMPLETED', response = $2::jsonb, error_message = NULL, updated_at = NOW()
    WHERE idempotency_key = $1
  `;
  await pool.query(query, [idempotencyKey, JSON.stringify(response)]);
}

async function markIdempotencyFailed({ idempotencyKey, errorMessage }) {
  const query = `
    UPDATE idempotency_keys
    SET status = 'FAILED', error_message = $2, updated_at = NOW()
    WHERE idempotency_key = $1
  `;
  await pool.query(query, [idempotencyKey, errorMessage]);
}

module.exports = {
  createPayment,
  createWebhookEventIfNotExists,
  createIdempotencyKeyIfNotExists,
  getIdempotencyKey,
  markIdempotencyCompleted,
  markIdempotencyFailed,
};
