// Utility helpers

const Utils = {
  /** Generate a UUID v4 using the native browser API */
  uuid() {
    return crypto.randomUUID();
  },

  /** Format a Date or ISO string as "Mon DD, YYYY" */
  formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },

  /** Format a Date or ISO string as "h:MM AM/PM" */
  formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },

  /** Format a Date or ISO string as "Mon DD, h:MM AM" */
  formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
           d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },

  /** Return current local ISO string */
  nowISO() {
    return new Date().toISOString();
  },

  /** Format a number as currency (USD) */
  formatCurrency(amount) {
    if (amount == null || isNaN(amount)) return '$—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  },

  /** Format a number as currency with sign (+$123.45 / -$67.89) */
  formatPnL(amount) {
    if (amount == null || isNaN(amount)) return '$—';
    const prefix = amount >= 0 ? '+' : '';
    return prefix + Utils.formatCurrency(amount);
  },

  /** Format a number as percentage with sign (+12.34% / -5.67%) */
  formatPercent(decimal) {
    if (decimal == null || isNaN(decimal)) return '—%';
    const pct = (decimal * 100).toFixed(2);
    const prefix = decimal >= 0 ? '+' : '';
    return prefix + pct + '%';
  },

  /** Format a large number compactly (1.2K, 3.4M, etc.) */
  formatCompact(num) {
    if (num == null || isNaN(num)) return '—';
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(num);
  },

  /** Format number of shares */
  formatShares(qty) {
    if (qty == null || isNaN(qty)) return '—';
    if (Number.isInteger(qty)) return qty.toString();
    return qty.toFixed(4);
  },

  /**
   * Debounce a function call.
   * @param {Function} fn
   * @param {number} ms
   */
  debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  /** Deep clone a plain object */
  clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },
};
