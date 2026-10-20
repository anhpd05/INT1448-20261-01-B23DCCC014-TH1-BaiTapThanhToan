'use strict';

const express = require('express');

const PORT = Number(process.env.PORT) || 4002;
const DELAY_MS = Number(process.env.DELAY_MS) || 0;
const FAIL_RATE = Number(process.env.FAIL_RATE) || 0;
const DROP_RATE = Number(process.env.DROP_RATE) || 0;
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const chargesByKey = new Map();
const chargedRefs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const key = req.get('Idempotency-Key');
  const saved = key && chargesByKey.get(key);
  if (saved) return res.status(saved.status).json(saved.body);

  const { reference, amount } = req.body || {};
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'INVALID_AMOUNT' });
  }

  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'BANK_INTERNAL_ERROR' });
  }

  if (amount > LIMIT) {
    const result = { status: 402, body: { error: 'LIMIT_EXCEEDED' } };
    if (key) chargesByKey.set(key, result);
    return res.status(result.status).json(result.body);
  }

  stats.charges++;
  if (chargedRefs.has(reference)) stats.duplicates++;
  else chargedRefs.add(reference);
  const result = { status: 201, body: { chargeId: `C${stats.charges}`, reference, amount } };
  if (key) chargesByKey.set(key, result);

  if (Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }
  res.status(result.status).json(result.body);
});

app.get('/stats', (req, res) => res.json(stats));

const server = app.listen(PORT, () => {
  console.log(
    `bank listening on :${PORT} (DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE})`,
  );
});

server.on('connection', () => {
  stats.connections++;
  console.log(`new TCP connection #${stats.connections}`);
});
