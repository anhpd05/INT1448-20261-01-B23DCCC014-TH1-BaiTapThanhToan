'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FEE = 'http://localhost:4001';
const MAX_MS = 4500;
const OWN_STATS_CONNECTION = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (n) => n.toLocaleString('vi-VN');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function waitPort(port, open) {
  for (let i = 0; i < 100; i++) {
    if ((await portOpen(port)) === open) return;
    await sleep(100);
  }
  throw new Error(`port ${port} did not become ${open ? 'open' : 'closed'}`);
}

function service(file, port, defaultEnv = {}) {
  let child = null;
  return {
    async start(env = {}) {
      if (child) await this.stop();
      if (await portOpen(port)) throw new Error(`port ${port} already in use`);
      child = spawn(process.execPath, [file], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, ...defaultEnv, ...env } });
      await waitPort(port, true);
    },
    async stop() {
      if (!child) return;
      const c = child;
      child = null;
      if (c.exitCode === null) {
        const exited = new Promise((resolve) => c.once('exit', resolve));
        c.kill();
        await exited;
      }
      await waitPort(port, false);
    },
    get alive() {
      return child !== null && child.exitCode === null;
    },
  };
}

async function call(method, url, body) {
  const t = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, body: json, ms: Date.now() - t };
  } catch (err) {
    return { status: 'ERR', body: null, ms: Date.now() - t, error: (err.cause && err.cause.code) || err.message };
  }
}

const pay = (amount, studentId = 1) => call('POST', `${FEE}/students/${studentId}/payments`, { amount });
const fees = (studentId = 1) => call('GET', `${FEE}/students/${studentId}/fees`);

function bankStats() {
  return new Promise((resolve, reject) => {
    http
      .get('http://localhost:4002/stats', { agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const s = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(s);
        });
      })
      .on('error', reject);
  });
}

const show = (r) => `${r.status}${r.body && r.body.status ? ' ' + r.body.status : ''} (${r.ms}ms)`;

const rows = [];
const checks = [];
const metric = (name, value) => rows.push([name, String(value)]);
const check = (name, ok) => checks.push([name, Boolean(ok)]);

const scenarios = {
  async tc1({ bank, fee, feeEnv }) {
    await fee.start(feeEnv);
    const down = await pay(1000);
    const get = await fees();
    metric('Bank tắt: POST', show(down));
    metric('Bank tắt: GET /fees', show(get));
    metric('Fee Service còn sống', fee.alive ? 'có' : 'không (sập)');
    check('Bank tắt → 503 + {error,paymentId,status} < 1,5s',
      down.status === 503 && down.body && down.body.paymentId && down.body.status && down.ms < 1500);
    check('Fee Service không sập, GET /fees 200', fee.alive && get.status === 200);

    await bank.start();
    const back = await pay(1000);
    metric('Bank bật lại: POST (không restart Fee)', show(back));
    check('Bank bật lại → 201', back.status === 201);

    await fee.start({ ...feeEnv, BANK_URL: 'http://localhost:4999' });
    const wrong = await pay(1000);
    metric('BANK_URL=:4999: POST', show(wrong));
    check('BANK_URL=:4999 → 503 < 1,5s', wrong.status === 503 && wrong.ms < 1500);
  },

  async tc2() {
    const one = await pay(1000);
    metric('1 POST (bank DELAY_MS=5000)', show(one));
    check('504 PENDING', one.status === 504 && one.body && one.body.status === 'PENDING');
    check(`POST ≤ ${MAX_MS}ms`, one.ms <= MAX_MS);

    const batch = Array.from({ length: 20 }, () => pay(1000));
    await sleep(500);
    const get = await fees();
    const results = await Promise.all(batch);
    const slowest = Math.max(...results.map((r) => r.ms));
    metric('20 POST đang chờ: GET /fees', show(get));
    metric('20 POST: lâu nhất', `${slowest}ms`);
    metric('20 POST: mã trả về', [...new Set(results.map((r) => r.status))].join(','));
    check('GET /fees < 300ms khi 20 thanh toán đang chờ', get.status === 200 && get.ms < 300);
    check(`Mọi POST ≤ ${MAX_MS}ms`, slowest <= MAX_MS);
  },

  async tc3() {
    const total = 200;
    const before = await bankStats();
    const t = Date.now();
    let ok = 0;
    let next = 0;
    const worker = async () => {
      while (next < total) {
        next++;
        const r = await pay(1000);
        if (r.status === 201) ok++;
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
    const elapsed = Date.now() - t;
    const statsAfter = await bankStats();
    const opened = statsAfter.connections - before.connections - OWN_STATS_CONNECTION;
    metric('200 POST, 10 song song: thành công', `${ok}/${total}`);
    metric('Tổng thời gian', `${elapsed}ms`);
    metric('Số kết nối TCP Fee Service mở tới bank', opened);
    check('200/200 thành công', ok === total);
    check('Số kết nối TCP ≤ 20', opened <= 20);

    await sleep(6500);
    const after = [];
    for (let i = 0; i < 3; i++) after.push(await pay(1000));
    metric('Sau 6,5s nhàn rỗi: 3 POST', after.map(show).join(' | '));
    check('Sau nhàn rỗi vẫn 201 cả 3', after.every((r) => r.status === 201));
  },

  async tcSequential({ label, expectPaidMin, restStatus }) {
    const total = 60;
    const before = (await fees()).body.debt;
    const results = [];
    for (let i = 0; i < total; i++) results.push(await pay(1000));
    const after = (await fees()).body.debt;
    const stats = await bankStats();
    const paid = results.filter((r) => r.status === 201).length;
    const count = (code) => results.filter((r) => r.status === code).length;
    const slowest = Math.max(...results.map((r) => r.ms));
    const others = results.filter((r) => r.status !== 201 && r.status !== restStatus);
    metric(`${label}: PAID`, `${paid}/${total}`);
    metric(`${label}: 503 FAILED`, count(503));
    metric(`${label}: 504 PENDING`, count(504));
    metric(`${label}: mã khác`, others.length ? others.map((r) => r.status).join(',') : 'không');
    metric('Lâu nhất', `${slowest}ms`);
    metric('/stats.charges', stats.charges);
    metric('/stats.duplicates', stats.duplicates);
    metric('Bank đã trừ nhưng Fee không ghi nhận', stats.charges - paid);
    metric('Công nợ giảm', `${money(before - after)}đ (tổng PAID ${money(paid * 1000)}đ)`);
    check('duplicates = 0', stats.duplicates === 0);
    check(`≥ ${expectPaidMin}/${total} PAID`, paid >= expectPaidMin);
    check(`Lệnh còn lại là ${restStatus}`, others.length === 0);
    check('Công nợ giảm đúng tổng tiền lệnh PAID', before - after === paid * 1000);
    check(`Mọi POST ≤ ${MAX_MS}ms`, slowest <= MAX_MS);
  },

  async tc4c() {
    const r = await pay(25_000_000);
    const stats = await bankStats();
    metric('POST 25.000.000đ', show(r));
    metric('/stats.requests', stats.requests);
    check('402', r.status === 402);
    check('/stats.requests = 1 (không retry lỗi 4xx)', stats.requests === 1);
  },
};

const CONFIG = {
  tc1: { run: 'tc1', bank: false },
  tc2: { run: 'tc2', bankEnv: { DELAY_MS: '5000' } },
  tc3: { run: 'tc3' },
  tc4a: { run: 'tcSequential', bankEnv: { DROP_RATE: '0.3' }, args: { label: 'DROP_RATE=0.3', expectPaidMin: 54, restStatus: 504 } },
  tc4b: { run: 'tcSequential', bankEnv: { FAIL_RATE: '0.3' }, args: { label: 'FAIL_RATE=0.3', expectPaidMin: 54, restStatus: 503 } },
  tc4c: { run: 'tc4c' },
};

async function main() {
  const name = process.argv[2];
  const naive = process.argv.includes('--naive');
  const cfg = CONFIG[name];
  if (!cfg) {
    console.error(`Dùng: node scripts/run-scenario.js <${Object.keys(CONFIG).join('|')}> [--naive]`);
    process.exit(2);
  }

  const bank = service('bank/server.js', 4002, cfg.bankEnv);
  const fee = service('fee-service/server.js', 4001);
  const feeEnv = naive ? { NAIVE: '1' } : {};

  try {
    if (cfg.bank !== false) await bank.start();
    if (name !== 'tc1') await fee.start(feeEnv);
    await scenarios[cfg.run]({ bank, fee, feeEnv, ...(cfg.args || {}) });
  } finally {
    await fee.stop();
    await bank.stop();
  }

  const mode = naive ? 'TRƯỚC (NAIVE=1)' : 'SAU (bền vững)';
  console.log(`\n=== ${name} — ${mode} ===`);
  console.log('| Chỉ số | Giá trị |\n|---|---|');
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  console.log('');
  for (const [k, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${k}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} tiêu chí đạt`);
  process.exitCode = !naive && failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
