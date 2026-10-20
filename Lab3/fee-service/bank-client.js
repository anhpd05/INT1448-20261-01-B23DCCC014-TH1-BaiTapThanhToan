'use strict';

const http = require('node:http');

const NAIVE = process.env.NAIVE === '1';

const CONNECT_TIMEOUT_MS = 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 50;

function bankUrl() {
  return new URL('/charges', process.env.BANK_URL || 'http://localhost:4002');
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function toResult(status, body) {
  if (status >= 200 && status < 300) return { kind: 'charged', chargeId: body && body.chargeId };
  if (status >= 400 && status < 500) return { kind: 'rejected', httpStatus: status, body };
  return null;
}

function chargeNaive({ reference, amount, idemKey }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ reference, amount });
    const req = http.request(
      bankUrl(),
      {
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Idempotency-Key': idemKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const result = toResult(res.statusCode, parseJson(Buffer.concat(chunks)));
          resolve(result || { kind: 'unknown', error: new Error(`bank responded ${res.statusCode}`) });
        });
        res.on('error', (error) => resolve({ kind: 'unknown', error }));
      },
    );
    req.on('error', (error) => resolve({ kind: 'unknown', error }));
    req.end(payload);
  });
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 4000 });

const DEFINITE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function classify(error) {
  if (error.phase === 'connect' || DEFINITE_CODES.has(error.code)) return 'definite';
  return 'ambiguous';
}

function attemptOnce({ reference, amount, idemKey, deadlineAt }) {
  return new Promise((resolve) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = new Error('deadline exceeded');
      return resolve({ error, cls: 'ambiguous' });
    }

    let settled = false;
    let connectTimer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(value);
    };
    const fail = (error) => {
      done({ error, cls: classify(error) });
    };

    const payload = JSON.stringify({ reference, amount });
    const req = http.request(
      bankUrl(),
      {
        method: 'POST',
        agent,
        signal: AbortSignal.timeout(remaining),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Idempotency-Key': idemKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, body: parseJson(Buffer.concat(chunks)) }));
        res.on('error', fail);
        res.on('aborted', () => fail(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })));
      },
    );

    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        if (socket.connecting) {
          req.destroy(Object.assign(new Error('connect timeout'), { phase: 'connect' }));
        }
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.on('error', fail);
    req.on('close', () => {
      fail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    });
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chargeResilient({ reference, amount, idemKey, deadlineAt }) {
  let ambiguous = false;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptOnce({ reference, amount, idemKey, deadlineAt });

    if (outcome.error) {
      lastError = outcome.error;
      if (outcome.cls === 'ambiguous') ambiguous = true;
    } else {
      const result = toResult(outcome.status, outcome.body);
      if (result) return result;
      lastError = new Error(`bank responded ${outcome.status}`);
    }

    if (attempt === MAX_ATTEMPTS - 1) break;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(Math.random() * BACKOFF_BASE_MS * 2 ** attempt, remaining));
    if (deadlineAt - Date.now() <= 0) break;
  }

  return ambiguous ? { kind: 'unknown', error: lastError } : { kind: 'not_charged', error: lastError };
}

function chargeBank(args) {
  return NAIVE ? chargeNaive(args) : chargeResilient(args);
}

module.exports = { chargeBank, NAIVE };
