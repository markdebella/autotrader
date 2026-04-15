/**
 * manifest.js — Manifest helpers
 * Keeps Alpine's in-memory manifest in sync with Drive.
 */

const Manifest = {
  /** Build a manifest summary entry from a full trade object */
  entryFrom(trade) {
    return {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty,
      filledPrice: trade.filledAvgPrice ?? trade.limitPrice ?? null,
      status: trade.status,
      submittedAt: trade.submittedAt,
      filledAt: trade.filledAt,
      strategyId: trade.strategyId,
    };
  },

  /** Add or update an entry in the in-memory manifest and persist to Drive */
  async upsert(trade) {
    const store    = Alpine.store('data');
    const manifest = store.manifest;
    const entry    = Manifest.entryFrom(trade);
    const idx      = manifest.trades.findIndex(t => t.id === trade.id);
    if (idx >= 0) {
      manifest.trades[idx] = entry;
    } else {
      manifest.trades.unshift(entry); // newest first
    }
    store.manifest = { ...manifest }; // trigger Alpine reactivity
    await Drive.saveManifest(manifest);
  },

  /** Remove a trade from the manifest and persist */
  async remove(id) {
    const store    = Alpine.store('data');
    const manifest = store.manifest;
    manifest.trades = manifest.trades.filter(t => t.id !== id);
    store.manifest = { ...manifest };
    await Drive.saveManifest(manifest);
  },

  /** Sort manifest trades newest-first (mutates in place) */
  sortNewest(manifest) {
    manifest.trades.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  },
};
