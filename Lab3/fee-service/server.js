'use strict';

const express = require('express');
const store = require('./store');
const { chargeBank, NAIVE } = require('./bank-client');

const PORT = Number(process.env.PORT) || 4001;
const DEADLINE_MS = 4000;

const app = express();
app.use(express.json());

function fail(res, httpStatus, error, payment) {
  const body = { error };
  if (payment) {
    body.paymentId = payment.id;
    body.status = payment.status;
  }
  return res.status(httpStatus).json(body);
}

app.get('/students/:id/fees', (req, res) => {
  const studentId = Number(req.params.id);
  if (!store.hasStudent(studentId)) return fail(res, 404, 'STUDENT_NOT_FOUND');
  res.json({ studentId, debt: store.getDebt(studentId) });
});

app.post('/students/:id/payments', async (req, res) => {
  const deadlineAt = Date.now() + DEADLINE_MS;
  const studentId = Number(req.params.id);
  if (!store.hasStudent(studentId)) return fail(res, 404, 'STUDENT_NOT_FOUND');

  const amount = req.body && req.body.amount;
  const available = store.getDebt(studentId) - store.pendingAmount(studentId);
  if (!Number.isInteger(amount) || amount <= 0 || amount > available) {
    return fail(res, 400, 'INVALID_AMOUNT');
  }

  const payment = store.createPayment(studentId, amount);
  let result;
  try {
    result = await chargeBank({
      reference: payment.id,
      amount,
      idemKey: payment.id,
      deadlineAt,
    });
  } catch (error) {
    if (NAIVE) throw error;
    console.error(`unexpected error charging ${payment.id}:`, error);
    result = { kind: 'unknown', error };
  }

  switch (result.kind) {
    case 'charged':
      store.markPaid(payment);
      return res.status(201).json({
        paymentId: payment.id,
        status: payment.status,
        chargeId: result.chargeId,
        amount,
      });
    case 'rejected':
      store.markFailed(payment);
      return fail(res, result.httpStatus, (result.body && result.body.error) || 'BANK_REJECTED', payment);
    case 'not_charged':
      store.markFailed(payment);
      return fail(res, 503, 'BANK_UNAVAILABLE', payment);
    default:
      return fail(res, 504, 'BANK_TIMEOUT', payment);
  }
});

app.listen(PORT, () => {
  console.log(`fee-service listening on :${PORT} (${NAIVE ? 'NAIVE' : 'resilient'}, BANK_URL=${process.env.BANK_URL || 'http://localhost:4002'})`);
});
