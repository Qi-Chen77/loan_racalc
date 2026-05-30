import { calculateLoan } from "./calculator.js";

const form = document.querySelector("#calculator-form");
const results = document.querySelector("#results");
const error = document.querySelector("#error");
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "EUR" });
const number = value => money.format(value);

function metric(label, value) {
  return `<div><span>${label}</span><strong>${value}</strong></div>`;
}

form.addEventListener("submit", event => {
  event.preventDefault();
  error.textContent = "";
  try {
    const input = Object.fromEntries(new FormData(form));
    const result = calculateLoan(input);
    document.querySelector("#monthly-payment").textContent = number(result.regularPayment);
    document.querySelector("#metrics").innerHTML = [
      metric("下次实际还款日", result.nextPaymentDate),
      metric("最后常规还款日", result.lastRegularPaymentDate),
      metric("最后实际还款日", result.finalPaymentDate),
      metric("最后一期金额", number(result.finalPayment)),
      metric("实际末期差值", number(result.actualDifference))
    ].join("");
    document.querySelector("#row-count").textContent = `${result.schedule.length} 期`;
    document.querySelector("#schedule").innerHTML = result.schedule.map(row => `<tr class="${row.isFinal ? "final" : ""}">
      <td data-label="合同还款日">${row.contractualDate}</td><td data-label="实际还款日">${row.actualDate}</td><td data-label="期初本金">${number(row.opening)}</td><td data-label="利息">${number(row.interest)}</td>
      <td data-label="还款额">${number(row.payment)}</td><td data-label="偿还本金">${number(row.principalRepaid)}</td><td data-label="期末本金">${number(row.closing)}</td></tr>`).join("");
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (caught) {
    results.hidden = true;
    error.textContent = caught.message;
  }
});
