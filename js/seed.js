/**
 * seed.js — Default settings factory
 *
 * Provides the default settings object used when a user signs in for the
 * first time. No personal data is bundled with the app.
 */

const DefaultSettings = {
  get() {
    return {
      version: 1,
      brokerage: {
        // No API keys here — keys live only in Google Secret Manager (see SECURITY.md).
        provider: 'alpaca',
        paperMode: true,
      },
      claude: {
        apiKey: '',
        enabled: false,
        autonomousMode: false,
        maxAutonomousDollars: 100,
      },
      riskLimits: { ...CONFIG.defaultRiskLimits },
      recommendations: {
        engine: 'claude',   // 'claude' (AI, default) | 'rules' (deterministic). Toggle in Settings.
      },
      watchlist: [...CONFIG.defaultWatchlist],
      notifications: {
        enabled: false,
        orderFills: true,
        strategySignals: true,
      },
      display: {
        defaultChartTimeframe: '1M',
        showExtendedHours: false,
      },
    };
  },
};
