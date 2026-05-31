// Public configuration — no secrets here.
// The OAuth client ID is safe to commit; Google's security relies on authorized origins, not secret IDs.
const CONFIG = {
  clientId: '686821485002-b7in6d56hfqc5bgajnpisf1432urrr93.apps.googleusercontent.com',
  driveFolderName: 'AutoTrader',
  appVersion: '2026.05.31.07',

  // Backend service (Cloud Run) that holds the Alpaca keys in Secret Manager and serves
  // read-only portfolio data. The browser never holds Alpaca keys — see SECURITY.md.
  apiBaseUrl: 'https://autotrader-api-686821485002.us-west1.run.app',

  // Alpaca API endpoints
  alpaca: {
    paperBaseUrl: 'https://paper-api.alpaca.markets',
    liveBaseUrl:  'https://api.alpaca.markets',
    dataBaseUrl:  'https://data.alpaca.markets',
  },

  // Default risk limits — sized for a small starter account (~$100).
  // These are just DEFAULTS for new users; change them anytime in the app
  // under Settings → Risk Limits (no code edit needed).
  defaultRiskLimits: {
    accountBudget:      100,  // total capital you're allocating to this app
    maxOrderDollars:    10,   // hard cap on a SINGLE trade — keeps trades miniscule
    maxPositionDollars: 25,   // hard cap on total $ held in one stock
    maxPositionPct:     25,   // ...or this % of account budget (whichever is smaller)
    dailyLossLimit:     10,   // stop trading after losing this much in one day
    maxTradesPerDay:    3,    // low frequency; also stays within the PDT day-trade limit
  },

  // Default watchlist for new users
  defaultWatchlist: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'],

  // Friendly company names shown next to tickers. Curated for clean display; any
  // symbol not listed here is looked up from Alpaca's read-only assets API and cached.
  companyNames: {
    AAPL: 'Apple', MSFT: 'Microsoft', GOOGL: 'Alphabet (Google)', GOOG: 'Alphabet (Google)',
    AMZN: 'Amazon', TSLA: 'Tesla', META: 'Meta', NVDA: 'NVIDIA', NFLX: 'Netflix',
    AMD: 'AMD', INTC: 'Intel', IBM: 'IBM', ORCL: 'Oracle', CRM: 'Salesforce',
    ADBE: 'Adobe', CSCO: 'Cisco', QCOM: 'Qualcomm', TXN: 'Texas Instruments',
    AVGO: 'Broadcom', PYPL: 'PayPal', UBER: 'Uber', ABNB: 'Airbnb', SHOP: 'Shopify',
    COIN: 'Coinbase', PLTR: 'Palantir', BABA: 'Alibaba', DIS: 'Disney', NKE: 'Nike',
    SBUX: 'Starbucks', MCD: "McDonald's", KO: 'Coca-Cola', PEP: 'PepsiCo',
    WMT: 'Walmart', COST: 'Costco', TGT: 'Target', HD: 'Home Depot',
    JPM: 'JPMorgan Chase', BAC: 'Bank of America', WFC: 'Wells Fargo', GS: 'Goldman Sachs',
    V: 'Visa', MA: 'Mastercard', JNJ: 'Johnson & Johnson', PFE: 'Pfizer',
    UNH: 'UnitedHealth', XOM: 'ExxonMobil', CVX: 'Chevron', BA: 'Boeing', F: 'Ford',
    GM: 'General Motors', T: 'AT&T', VZ: 'Verizon',
    SPY: 'S&P 500 ETF', QQQ: 'Nasdaq-100 ETF', VOO: 'Vanguard S&P 500', VTI: 'Vanguard Total Market',
  },

  // Glossary terms for education view
  glossary: [
    { term: 'Market Order',    definition: 'An order to buy or sell immediately at the best available price. Guarantees execution but not price.' },
    { term: 'Limit Order',     definition: 'An order to buy or sell at a specific price or better. You set the maximum you\'ll pay (buy) or minimum you\'ll accept (sell).' },
    { term: 'Stop Order',      definition: 'An order that becomes a market order once a stock hits a trigger price. Often used as a "stop-loss" to limit downside.' },
    { term: 'Stop-Limit Order', definition: 'Like a stop order, but instead of becoming a market order, it becomes a limit order at your specified price.' },
    { term: 'Bid',             definition: 'The highest price a buyer is willing to pay for a stock right now.' },
    { term: 'Ask',             definition: 'The lowest price a seller is willing to accept for a stock right now.' },
    { term: 'Spread',          definition: 'The difference between the bid and ask price. Smaller spreads mean more liquidity.' },
    { term: 'Volume',          definition: 'The number of shares traded in a given period. High volume means lots of activity.' },
    { term: 'Position',        definition: 'The number of shares you own in a particular stock. A "long" position means you own shares hoping the price goes up.' },
    { term: 'P&L',             definition: 'Profit and Loss — how much money you\'ve made or lost. "Unrealized" P&L is on paper; "realized" P&L is from closed trades.' },
    { term: 'Day Trade',       definition: 'Buying and selling the same stock within the same trading day.' },
    { term: 'PDT Rule',        definition: 'Pattern Day Trader rule: accounts under $25,000 are limited to 3 day trades per 5 business days. Exceeding this can restrict your account.' },
    { term: 'Buying Power',    definition: 'The total amount of money available to place trades. Includes settled cash.' },
    { term: 'Market Hours',    definition: 'US stock markets are open 9:30 AM – 4:00 PM Eastern Time, Monday through Friday (excluding holidays).' },
    { term: 'Pre-Market',      definition: 'Trading session before regular hours (4:00 AM – 9:30 AM ET). Lower volume, wider spreads.' },
    { term: 'After-Hours',     definition: 'Trading session after regular hours (4:00 PM – 8:00 PM ET). Same caveats as pre-market.' },
    { term: 'Dividend',        definition: 'A payment a company makes to its shareholders, usually from profits. Not all stocks pay dividends.' },
    { term: 'Stock Split',     definition: 'When a company divides existing shares into multiple shares. Price drops proportionally but total value stays the same.' },
    { term: 'Moving Average',  definition: 'The average closing price over N days. Helps identify trends by smoothing out daily price fluctuations.' },
    { term: 'RSI',             definition: 'Relative Strength Index — a momentum indicator from 0-100. Below 30 suggests "oversold" (cheap), above 70 suggests "overbought" (expensive).' },
    { term: 'Fractional Shares', definition: 'Buying less than one full share of a stock. Lets you invest a dollar amount rather than buying whole shares.' },
    { term: 'Paper Trading',   definition: 'Trading with simulated money to practice without financial risk. Your app defaults to this mode.' },
  ],
};
