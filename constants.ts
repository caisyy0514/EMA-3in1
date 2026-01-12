
export const COIN_CONFIG: Record<string, { instId: string; contractVal: number; tickSize: number; displayName: string; minSz: number }> = {
  BTC: {
    instId: "BTC-USDT-SWAP",
    contractVal: 0.01,
    tickSize: 0.1,
    displayName: "BTC",
    minSz: 0.01
  },
  ETH: { 
    instId: "ETH-USDT-SWAP", 
    contractVal: 0.1, 
    tickSize: 0.01, 
    displayName: "ETH",
    minSz: 0.01
  },
  BNB: {
    instId: "BNB-USDT-SWAP",
    contractVal: 0.01, 
    tickSize: 0.1, 
    displayName: "BNB",
    minSz: 1
  },
  SOL: { 
    instId: "SOL-USDT-SWAP", 
    contractVal: 1.0, 
    tickSize: 0.01, 
    displayName: "SOL",
    minSz: 0.01
  },
  XRP: { 
    instId: "XRP-USDT-SWAP", 
    contractVal: 100.0, 
    tickSize: 0.0001, 
    displayName: "XRP",
    minSz: 0.01
  },
  OKB: {
    instId: "OKB-USDT-SWAP",
    contractVal: 0.01,
    tickSize: 0.01,
    displayName: "OKB",
    minSz: 1
  }
};

export const INSTRUMENT_ID = "ETH-USDT-SWAP";
export const CONTRACT_VAL_ETH = 0.1;

export const TAKER_FEE_RATE = 0.0005; 

export const DEFAULT_LEVERAGE = "20";

export const DEFAULT_CONFIG = {
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  deepseekApiKey: "", 
  isSimulation: true,
  enabledCoins: Object.keys(COIN_CONFIG)
};

export const STRATEGY_STAGES = {
  ROLLING: {
    name: "EMA 滚仓追踪",
    initial_risk: 0.05, 
    add_step: 0.05,     
    leverage: 5,        
  }
};

export const MOCK_TICKER = {
  instId: "ETH-USDT-SWAP",
  last: "3250.50",
  lastSz: "1.2",
  askPx: "3250.60",
  bidPx: "3250.40",
  open24h: "3100.00",
  high24h: "3300.00",
  low24h: "3050.00",
  volCcy24h: "500000000",
  ts: Date.now().toString(),
};
