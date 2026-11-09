'use strict';
// The X spend cap. Two limits, both estimates from our own ledger
// (x_collection_runs.est_cost_usd); the X developer console is the truth.
//
//   - Monthly (X_MONTHLY_BUDGET_USD): a spike guard, so one bad run or a large
//     backfill cannot take a lot of money in one night.
//   - Yearly (X_ANNUAL_BUDGET_USD, default $2,000): the cap agreed on 9 Nov
//     2026 in the Asana task "Review X API spending" (keep 12 reads per post,
//     ~$1,560/year approved, spend cap $2,000/year, flag it when close).
//     Counted over the last 365 days, so it never resets on a date.
//
// The collector refuses to start once either is spent, and every backfill page
// is checked against whichever leaves less. check-x-health.js warns at 80%.

const ANNUAL_DEFAULT_USD = 2000;
const MONTHLY_DEFAULT_USD = 100;
const WINDOW_DAYS = 365;

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function budgets(env = process.env) {
  return {
    monthly: num(env.X_MONTHLY_BUDGET_USD, MONTHLY_DEFAULT_USD),
    yearly: num(env.X_ANNUAL_BUDGET_USD, ANNUAL_DEFAULT_USD),
  };
}

// Start of the rolling 365-day window, as an ISO string.
function windowStart(now = new Date()) {
  return new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
}

// What may still be spent, and which cap is the tighter one.
function remaining({ monthSpent = 0, yearSpent = 0, monthly, yearly }) {
  const m = monthly - monthSpent;
  const y = yearly - yearSpent;
  return y < m ? { remaining: y, limitedBy: 'yearly' } : { remaining: m, limitedBy: 'monthly' };
}

// A reason to refuse to run, or null.
function refusal({ monthSpent = 0, yearSpent = 0, monthly, yearly }) {
  if (yearSpent >= yearly) {
    return `estimated X spend over the last 365 days is $${yearSpent.toFixed(2)}, the yearly cap is $${yearly}. `
      + 'The cap was agreed in Asana ("Review X API spending"); raise X_ANNUAL_BUDGET_USD only with that agreement.';
  }
  if (monthSpent >= monthly) {
    return `estimated X spend this month is $${monthSpent.toFixed(2)}, the monthly budget is $${monthly}. `
      + 'Raise X_MONTHLY_BUDGET_USD deliberately, or wait for the month to roll over.';
  }
  return null;
}

function sumCost(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r && r.est_cost_usd) || 0), 0);
}

module.exports = { ANNUAL_DEFAULT_USD, MONTHLY_DEFAULT_USD, WINDOW_DAYS, budgets, windowStart, remaining, refusal, sumCost };
