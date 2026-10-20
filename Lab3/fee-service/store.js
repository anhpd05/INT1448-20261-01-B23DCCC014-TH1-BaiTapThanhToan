'use strict';

const debts = new Map([
  [1, 50_000_000],
  [2, 0],
  [3, 3_200_000],
]);
const payments = new Map();
let nextPaymentNo = 1;

function hasStudent(studentId) {
  return debts.has(studentId);
}

function getDebt(studentId) {
  return debts.get(studentId);
}

function pendingAmount(studentId) {
  let sum = 0;
  for (const p of payments.values()) {
    if (p.studentId === studentId && p.status === 'PENDING') sum += p.amount;
  }
  return sum;
}

function createPayment(studentId, amount) {
  const payment = { id: `P${nextPaymentNo++}`, studentId, amount, status: 'PENDING' };
  payments.set(payment.id, payment);
  return payment;
}

function markPaid(payment) {
  payment.status = 'PAID';
  debts.set(payment.studentId, debts.get(payment.studentId) - payment.amount);
}

function markFailed(payment) {
  payment.status = 'FAILED';
}

module.exports = { hasStudent, getDebt, pendingAmount, createPayment, markPaid, markFailed };
