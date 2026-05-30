/**
 * companies.js — friendly company names for tickers (e.g. MSFT → "Microsoft")
 *
 * Names come from two places:
 *   1. CONFIG.companyNames — a curated map of clean names (instant, no network).
 *   2. Alpaca's read-only /v2/assets/{symbol} for anything not in the map — fetched
 *      once, cleaned, and cached in a reactive store so the UI updates when it arrives.
 *
 * Templates call Company.name(symbol) (like Utils/Explain). Components proactively call
 * Company.ensure(symbols) after they know which tickers they'll show.
 */

const Company = (() => {
  const tried = new Set();   // symbols we've already attempted to fetch (avoid refetch)

  /** Trim Alpaca's verbose asset names down to something friendly. */
  function clean(name) {
    if (!name) return '';
    let n = name;
    // Drop security-type / share-class tails: "... Common Stock", "Class A ...", etc.
    n = n.replace(/\s+(Common Stock|Ordinary Shares?|Common Shares?|Class [A-Z]\b|American Depositary (Shares?|Receipts?)|ADRs?|ADSs?|Depositary Shares?).*$/i, '');
    // Drop a single trailing corporate designator.
    n = n.replace(/[,]?\s+(Incorporated|Inc\.?|Corporation|Corp\.?|Company|Co\.?|Limited|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|AG|Holdings?|Group)\.?$/i, '');
    n = n.trim().replace(/[,]+$/, '').trim();
    return n || name;
  }

  return {
    /** Friendly name for a symbol, or '' if unknown. Reactive (reads the store). */
    name(symbol) {
      const store = Alpine.store('companies');
      return (store && store.names[symbol]) || '';
    },

    /** Fetch+cache names for any of these symbols we don't already know. Fire-and-forget. */
    async ensure(symbols) {
      if (!Alpaca.isConfigured()) return;
      const store = Alpine.store('companies');
      if (!store) return;
      for (const sym of symbols) {
        if (!sym || store.names[sym] || tried.has(sym)) continue;
        tried.add(sym);
        try {
          const asset = await Alpaca.getAsset(sym);
          const friendly = clean(asset?.name);
          if (friendly) store.names = { ...store.names, [sym]: friendly };
        } catch (_) {
          /* no name available — the UI just shows the ticker alone */
        }
      }
    },
  };
})();

// Seed the reactive cache from the curated map before Alpine renders.
document.addEventListener('alpine:init', () => {
  Alpine.store('companies', { names: { ...(CONFIG.companyNames || {}) } });
});
