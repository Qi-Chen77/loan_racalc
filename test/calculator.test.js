import test from "node:test";
import assert from "node:assert/strict";
import { accruedInterest, adjustBusinessDay, buildPaymentDates, calculateLoan, formatDate } from "../src/calculator.js";

const sample = { principal:451200.37, balanceDate:"2026-06-22", oldRate:4.278, newRate:5.081,
  effectiveDate:"2026-07-20", paymentDay:21, maturityDate:"2043-07-19", maxFinalDifference:100,
  dayCount:"ACT/365", businessDayConvention:"following" };

test("splits interest at the effective date", () => {
  const from = new Date("2026-06-22T00:00:00Z"), effective = new Date("2026-07-20T00:00:00Z"), to = new Date("2026-07-21T00:00:00Z");
  const actual = accruedInterest(451200.37, from, to, .04278, .05081, effective);
  const expected = 451200.37 * (.04278 * 28 + .05081) / 365;
  assert.ok(Math.abs(actual - expected) < 1e-9);
});

test("following moves weekends to Monday", () => {
  assert.equal(formatDate(adjustBusinessDay(new Date("2026-11-21T00:00:00Z"))), "2026-11-23");
});

test("payment day clamps to the end of short months and maturity stays final", () => {
  const dates = buildPaymentDates(new Date("2027-01-01T00:00:00Z"), new Date("2027-03-15T00:00:00Z"), 31);
  assert.deepEqual(dates.map(x => formatDate(x.contractual)), ["2027-01-31", "2027-02-28", "2027-03-15"]);
  assert.equal(dates.at(-1).isFinal, true);
});

test("sample clears the loan and keeps the final difference below the limit", () => {
  const result = calculateLoan(sample);
  assert.ok(result.regularPayment > 0);
  assert.ok(Math.abs(result.actualDifference) < 100);
  assert.equal(result.regularPayment, Math.round(result.regularPayment * 100) / 100);
  assert.ok(Math.abs(result.schedule.at(-1).closing) < 1e-8);
  assert.equal(result.nextPaymentDate, "2026-07-21");
  assert.equal(result.finalPaymentDate, "2043-07-20");
});

test("rejects a maximum difference tighter than cent-rounded payments can achieve", () => {
  const baseline = calculateLoan(sample);
  const impossibleLimit = Math.abs(baseline.actualDifference) / 2;
  assert.throws(() => calculateLoan({ ...sample, maxFinalDifference: impossibleLimit }), /No cent-rounded payment/);
});

test("rejects invalid date ranges and schedules too short for a difference", () => {
  assert.throws(() => calculateLoan({ ...sample, maturityDate:"2026-06-22" }), /after balance/);
  assert.throws(() => calculateLoan({ ...sample, maturityDate:"2026-07-19" }), /at least two payments/);
});

function assertScheduleIntegrity(result, maxDifference = 100) {
  assert.ok(result.schedule.length >= 2);
  assert.equal(result.schedule.at(-1).isFinal, true);
  assert.ok(Math.abs(result.schedule.at(-1).closing) < 1e-7);
  assert.ok(Math.abs(result.actualDifference) < maxDifference);
  for (const [index, row] of result.schedule.entries()) {
    assert.ok(row.payment > 0, `payment ${index + 1} must be positive`);
    assert.ok(row.interest >= 0, `interest ${index + 1} must be non-negative`);
    assert.ok(Math.abs(row.opening + row.interest - row.payment - row.closing) < 1e-7,
      `cash-flow identity failed in payment ${index + 1}`);
    if (index > 0) assert.ok(Math.abs(row.opening - result.schedule[index - 1].closing) < 1e-7);
  }
}

test("zero interest divides principal across payments and clears exactly", () => {
  const result = calculateLoan({ ...sample, principal:1200, oldRate:0, newRate:0,
    balanceDate:"2026-01-01", effectiveDate:"2026-01-15", paymentDay:15, maturityDate:"2026-12-15" });
  assert.equal(result.schedule.length, 12);
  assert.equal(result.regularPayment, 100);
  assert.equal(result.finalPayment, 100);
  assertScheduleIntegrity(result);
});

test("rate effective before balance date applies the new rate throughout", () => {
  const input = { ...sample, effectiveDate:"2020-01-01" };
  const changed = calculateLoan(input);
  const allNew = calculateLoan({ ...input, oldRate:input.newRate });
  assert.equal(changed.regularPayment, allNew.regularPayment);
  assert.ok(Math.abs(changed.finalPayment - allNew.finalPayment) < 1e-8);
});

test("rate effective after maturity applies the old rate throughout", () => {
  const input = { ...sample, effectiveDate:"2050-01-01" };
  const changed = calculateLoan(input);
  const allOld = calculateLoan({ ...input, newRate:input.oldRate });
  assert.equal(changed.regularPayment, allOld.regularPayment);
  assert.ok(Math.abs(changed.finalPayment - allOld.finalPayment) < 1e-8);
});

test("effective date at a period boundary does not double-count a day", () => {
  const principal = 10000;
  const from = new Date("2028-02-21T00:00:00Z");
  const to = new Date("2028-03-21T00:00:00Z");
  const atStart = accruedInterest(principal, from, to, .01, .12, from);
  const atEnd = accruedInterest(principal, from, to, .01, .12, to);
  assert.ok(Math.abs(atStart - principal * .12 * 29 / 365) < 1e-10);
  assert.ok(Math.abs(atEnd - principal * .01 * 29 / 365) < 1e-10);
});

test("ACT/360 produces more interest and a higher payment than ACT/365", () => {
  const act365 = calculateLoan(sample);
  const act360 = calculateLoan({ ...sample, dayCount:"ACT/360" });
  assert.ok(act360.regularPayment > act365.regularPayment);
  assertScheduleIntegrity(act360);
});

test("unadjusted convention preserves weekend dates", () => {
  const result = calculateLoan({ ...sample, balanceDate:"2026-10-22", effectiveDate:"2026-11-01",
    paymentDay:21, maturityDate:"2027-02-19", businessDayConvention:"unadjusted" });
  assert.equal(result.schedule[0].contractualDate, "2026-11-21");
  assert.equal(result.schedule[0].actualDate, "2026-11-21");
  assertScheduleIntegrity(result);
});

test("following convention can move maturity into the next month", () => {
  const result = calculateLoan({ ...sample, balanceDate:"2026-10-01", effectiveDate:"2026-10-15",
    paymentDay:30, maturityDate:"2027-01-31" });
  assert.equal(result.finalPaymentDate, "2027-02-01");
  assertScheduleIntegrity(result);
});

test("day 31 uses leap-year month end", () => {
  const dates = buildPaymentDates(new Date("2028-01-01T00:00:00Z"), new Date("2028-04-15T00:00:00Z"), 31, "unadjusted");
  assert.deepEqual(dates.map(x => formatDate(x.contractual)), ["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-15"]);
});

test("short irregular loan with exactly two payments is supported", () => {
  const result = calculateLoan({ ...sample, principal:10000, balanceDate:"2026-06-22",
    effectiveDate:"2026-07-01", paymentDay:21, maturityDate:"2026-08-03" });
  assert.equal(result.schedule.length, 2);
  assert.equal(result.finalPaymentDate, "2026-08-03");
  assertScheduleIntegrity(result);
});

test("high but valid interest rate remains stable", () => {
  const result = calculateLoan({ ...sample, oldRate:40, newRate:55, maturityDate:"2028-07-19" });
  assert.ok(Number.isFinite(result.regularPayment));
  assertScheduleIntegrity(result);
});

test("every regular row uses the same cent-rounded payment", () => {
  const result = calculateLoan(sample);
  for (const row of result.schedule.slice(0, -1)) assert.equal(row.payment, result.regularPayment);
});

test("strict difference limit accepts just above and rejects equality", () => {
  const baseline = calculateLoan(sample);
  const difference = Math.abs(baseline.actualDifference);
  assert.doesNotThrow(() => calculateLoan({ ...sample, maxFinalDifference:difference + 1e-6 }));
  assert.throws(() => calculateLoan({ ...sample, maxFinalDifference:difference }), /No cent-rounded payment/);
});

test("selects the smallest cent-rounded difference inside both bounds", () => {
  const result = calculateLoan({ ...sample, minFinalDifference:50, maxFinalDifference:100 });
  assert.ok(Math.abs(result.actualDifference) >= 50);
  assert.ok(Math.abs(result.actualDifference) < 100);
  assertScheduleIntegrity(result, 100);
});

test("known ACT/360 benchmark stays below the limit and improves on the 50.46 difference", () => {
  const result = calculateLoan({
    principal:122487.89, balanceDate:"2026-07-05", oldRate:4.426, newRate:5.264,
    effectiveDate:"2026-07-31", paymentDay:5, maturityDate:"2037-07-31",
    maxFinalDifference:100, dayCount:"ACT/360",
    businessDayConvention:"unadjusted"
  });
  assert.equal(result.schedule.length, 133);
  assert.equal(result.regularPayment, 1221.66);
  assert.equal(Math.round(result.finalPayment * 100) / 100, 1221.82);
  assert.equal(Math.round(Math.abs(result.actualDifference) * 100) / 100, 0.16);
  assert.ok(Math.abs(result.actualDifference) < 50.46);
  assertScheduleIntegrity(result, 100);
});

test("validates numeric fields, dates, conventions, and payment day", () => {
  assert.throws(() => calculateLoan({ ...sample, principal:0 }), /Outstanding principal/);
  assert.throws(() => calculateLoan({ ...sample, oldRate:-1 }), /Old interest rate/);
  assert.throws(() => calculateLoan({ ...sample, newRate:Number.NaN }), /New interest rate/);
  assert.throws(() => calculateLoan({ ...sample, paymentDay:0 }), /Payment day/);
  assert.throws(() => calculateLoan({ ...sample, paymentDay:20.5 }), /whole number/);
  assert.throws(() => calculateLoan({ ...sample, balanceDate:"2026-02-30" }), /valid date/);
  assert.throws(() => calculateLoan({ ...sample, minFinalDifference:-1 }), /Minimum final payment difference/);
  assert.throws(() => calculateLoan({ ...sample, maxFinalDifference:0 }), /Maximum final payment difference/);
  assert.throws(() => calculateLoan({ ...sample, minFinalDifference:100, maxFinalDifference:100 }), /greater than the minimum/);
  assert.throws(() => calculateLoan({ ...sample, dayCount:"30/360" }), /Unsupported day count/);
  assert.throws(() => calculateLoan({ ...sample, businessDayConvention:"preceding" }), /Unsupported business day/);
});

test("100 deterministic varied loans preserve all schedule invariants", () => {
  let state = 0x5eed1234;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  for (let caseNumber = 0; caseNumber < 100; caseNumber += 1) {
    const startYear = 2024 + Math.floor(random() * 8);
    const startMonth = Math.floor(random() * 12) + 1;
    const startDay = Math.floor(random() * 20) + 1;
    const termMonths = 2 + Math.floor(random() * 240);
    const maturityIndex = startYear * 12 + startMonth - 1 + termMonths;
    const maturityYear = Math.floor(maturityIndex / 12);
    const maturityMonth = maturityIndex % 12 + 1;
    const iso = (year, month, day) => `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const varied = {
      principal: Math.round((1000 + random() * 999000) * 100) / 100,
      balanceDate: iso(startYear, startMonth, startDay),
      oldRate: Math.round(random() * 12000) / 1000,
      newRate: Math.round(random() * 15000) / 1000,
      effectiveDate: iso(startYear, startMonth, Math.min(28, startDay + Math.floor(random() * 8))),
      paymentDay: 1 + Math.floor(random() * 31),
      maturityDate: iso(maturityYear, maturityMonth, 15 + Math.floor(random() * 13)),
      maxFinalDifference: 1000,
      dayCount: random() < .5 ? "ACT/365" : "ACT/360",
      businessDayConvention: random() < .5 ? "following" : "unadjusted"
    };
    const result = calculateLoan(varied);
    assertScheduleIntegrity(result, varied.maxFinalDifference);
  }
});
