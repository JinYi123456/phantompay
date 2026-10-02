'use strict';

/**
 * Dependency-free Prometheus text-format metrics: request counters by
 * route/status, transfer totals, rejection counters and process gauges.
 */

class Metrics {
  constructor() {
    this.counters = new Map(); // key -> value
    this.startedAt = Date.now();
  }

  inc(name, labels = {}, value = 1) {
    const key = `${name}${renderLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  render({ accountCount, transactionCount, port }) {
    const lines = [
      '# HELP phantompay_uptime_seconds Seconds since process start.',
      '# TYPE phantompay_uptime_seconds gauge',
      `phantompay_uptime_seconds ${(BigInt(Date.now() - this.startedAt) / 1000n).toString()}`,
      '# HELP phantompay_accounts_total Accounts known to the ledger.',
      '# TYPE phantompay_accounts_total gauge',
      `phantompay_accounts_total ${accountCount}`,
      '# HELP phantompay_transactions_total Transactions recorded.',
      '# TYPE phantompay_transactions_total gauge',
      `phantompay_transactions_total ${transactionCount}`,
    ];
    for (const [key, value] of this.counters) {
      const name = key.slice(0, key.indexOf('{'));
      lines.push(`# TYPE ${name} counter`, `${key} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

function renderLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const inner = entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`).join(',');
  return `{${inner}}`;
}

module.exports = { Metrics };
