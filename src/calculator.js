const DAY_MS = 86_400_000;

function parseDate(value, field = "Date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be a valid date.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || formatDate(date) !== value) throw new Error(`${field} must be a valid date.`);
  return date;
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function contractualDate(year, month, paymentDay) {
  return new Date(Date.UTC(year, month, Math.min(paymentDay, daysInMonth(year, month))));
}

export function adjustBusinessDay(date, convention = "following") {
  const adjusted = new Date(date);
  if (convention === "unadjusted") return adjusted;
  if (convention !== "following") throw new Error("Unsupported business day convention.");
  while (adjusted.getUTCDay() === 0 || adjusted.getUTCDay() === 6) {
    adjusted.setUTCDate(adjusted.getUTCDate() + 1);
  }
  return adjusted;
}

export function buildPaymentDates(balanceDate, maturityDate, paymentDay, convention = "following") {
  const dates = [];
  let year = balanceDate.getUTCFullYear();
  let month = balanceDate.getUTCMonth();
  let candidate = contractualDate(year, month, paymentDay);
  if (candidate <= balanceDate) {
    month += 1;
    if (month === 12) { month = 0; year += 1; }
    candidate = contractualDate(year, month, paymentDay);
  }

  while (candidate < maturityDate) {
    dates.push({ contractual: candidate, actual: adjustBusinessDay(candidate, convention), isFinal: false });
    month += 1;
    if (month === 12) { month = 0; year += 1; }
    candidate = contractualDate(year, month, paymentDay);
  }

  if (!dates.length || dates.at(-1).contractual.valueOf() !== maturityDate.valueOf()) {
    dates.push({ contractual: maturityDate, actual: adjustBusinessDay(maturityDate, convention), isFinal: true });
  } else {
    dates.at(-1).isFinal = true;
  }
  return dates;
}

function yearBasis(dayCount) {
  if (dayCount === "ACT/365") return 365;
  if (dayCount === "ACT/360") return 360;
  throw new Error("Unsupported day count convention.");
}

export function accruedInterest(principal, from, to, oldRate, newRate, effectiveDate, dayCount = "ACT/365") {
  if (to < from) throw new Error("Payment dates must be chronological.");
  const basis = yearBasis(dayCount);
  const split = effectiveDate > from && effectiveDate < to ? effectiveDate : null;
  const portions = split ? [[from, split], [split, to]] : [[from, to]];
  return portions.reduce((sum, [start, end]) => {
    const days = (end - start) / DAY_MS;
    const rate = start < effectiveDate ? oldRate : newRate;
    return sum + principal * rate * days / basis;
  }, 0);
}

function validateNumber(value, label, { min = -Infinity, max = Infinity, inclusiveMin = true } = {}) {
  if (!Number.isFinite(value) || value > max || (inclusiveMin ? value < min : value <= min)) {
    throw new Error(`${label} is out of range.`);
  }
}

export function calculateLoan(input) {
  const principal = Number(input.principal);
  const oldRate = Number(input.oldRate) / 100;
  const newRate = Number(input.newRate) / 100;
  const paymentDay = Number(input.paymentDay);
  const minFinalDifference = Number(input.minFinalDifference ?? 0);
  const maxFinalDifference = Number(input.maxFinalDifference ?? 100);
  validateNumber(principal, "Outstanding principal", { min: 0, inclusiveMin: false });
  validateNumber(oldRate, "Old interest rate", { min: 0 });
  validateNumber(newRate, "New interest rate", { min: 0 });
  validateNumber(paymentDay, "Payment day", { min: 1, max: 31 });
  validateNumber(minFinalDifference, "Minimum final payment difference", { min: 0 });
  validateNumber(maxFinalDifference, "Maximum final payment difference", { min: 0, inclusiveMin: false });
  if (minFinalDifference >= maxFinalDifference) {
    throw new Error("Maximum final payment difference must be greater than the minimum.");
  }
  if (!Number.isInteger(paymentDay)) throw new Error("Payment day must be a whole number.");

  const balanceDate = parseDate(input.balanceDate, "Balance date");
  const effectiveDate = parseDate(input.effectiveDate, "New rate effective date");
  const maturityDate = parseDate(input.maturityDate, "Maturity date");
  if (maturityDate <= balanceDate) throw new Error("Maturity date must be after balance date.");

  const convention = input.businessDayConvention ?? "following";
  const dayCount = input.dayCount ?? "ACT/365";
  const dates = buildPaymentDates(balanceDate, maturityDate, paymentDay, convention);
  if (dates.length < 2) throw new Error("Maturity must allow at least two payments to define the final payment difference.");

  const project = (regularPayment, makeRows = false) => {
    let balance = principal;
    let previousDate = balanceDate;
    let finalDue = 0;
    const rows = [];
    for (let i = 0; i < dates.length; i += 1) {
      const entry = dates[i];
      const opening = balance;
      const interest = accruedInterest(opening, previousDate, entry.actual, oldRate, newRate, effectiveDate, dayCount);
      const due = opening + interest;
      const payment = entry.isFinal ? due : regularPayment;
      if (entry.isFinal) finalDue = due;
      balance = due - payment;
      if (makeRows) rows.push({
        contractualDate: formatDate(entry.contractual), actualDate: formatDate(entry.actual), opening,
        interest, payment, principalRepaid: payment - interest, closing: Math.max(0, balance), isFinal: entry.isFinal
      });
      previousDate = entry.actual;
    }
    return { finalDue, rows };
  };

  // The objective is the signed difference between the adjusted final payment
  // and a regular payment. It decreases monotonically as the payment increases.
  const objective = payment => project(payment).finalDue - payment;
  const solveForDifference = target => {
    let low = 0;
    let high = Math.max(principal, 1);
    while (objective(high) > target && high < principal * 1e6) high *= 2;
    if (objective(low) < target || objective(high) > target) return null;
    for (let i = 0; i < 100; i += 1) {
      const mid = (low + high) / 2;
      if (objective(mid) > target) low = mid; else high = mid;
    }
    return (low + high) / 2;
  };

  const exactCandidates = [
    solveForDifference(0),
    solveForDifference(minFinalDifference),
    solveForDifference(-minFinalDifference)
  ].filter(value => value !== null);
  const candidates = [...new Set(exactCandidates.flatMap(value => {
    const cent = Math.round(value * 100);
    return [cent - 2, cent - 1, cent, cent + 1, cent + 2];
  }))].filter(value => value > 0).map(value => value / 100);
  const feasible = candidates
    .map(payment => ({ payment, difference: objective(payment) }))
    .filter(item => Math.abs(item.difference) >= minFinalDifference && Math.abs(item.difference) < maxFinalDifference)
    .sort((a, b) => Math.abs(a.difference) - Math.abs(b.difference) || a.payment - b.payment);
  if (!feasible.length) throw new Error("No cent-rounded payment can satisfy the configured final payment difference range.");
  const regularPayment = feasible[0].payment;
  const { rows } = project(regularPayment, true);
  const finalPayment = rows.at(-1).payment;
  if (regularPayment <= 0 || finalPayment <= 0) throw new Error("The calculated schedule contains a non-positive payment.");
  const actualDifference = finalPayment - regularPayment;

  return {
    regularPayment,
    finalPayment,
    actualDifference,
    nextPaymentDate: rows[0].actualDate,
    lastRegularPaymentDate: rows.at(-2).actualDate,
    finalPaymentDate: rows.at(-1).actualDate,
    schedule: rows
  };
}
