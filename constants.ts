

export const COIN_CONFIG: Record<string, { instId: string; contractVal: number; tickSize: number; displayName: string; minSz: number }> = {
  ETH: { 
    instId: "ETH-USDT-SWAP", 
    contractVal: 0.1, 
    tickSize: 0.01, 
    displayName: "ETH",
    minSz: 0.01
  },
  SOL: { 
    instId: "SOL-USDT-SWAP", 
    contractVal: 1.0, 
    tickSize: 0.01, 
    displayName: "SOL",
    minSz: 0.01
  },
  DOGE: { 
    instId: "DOGE-USDT-SWAP", 
    contractVal: 10.0, 
    tickSize: 0.01, 
    displayName: "DOGE",
    minSz: 1.0
  }
};

// Deprecated single constants, kept for reference but unused in new logic
export const INSTRUMENT_ID = "ETH-USDT-SWAP";
export const CONTRACT_VAL_ETH = 0.1;

// 费率设定 (保守估计 Taker 0.05%)
export const TAKER_FEE_RATE = 0.0005; 

// 全局默认杠杆
export const DEFAULT_LEVERAGE = "20";

export const DEFAULT_CONFIG = {
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  deepseekApiKey: "", 
  isSimulation: true, 
};

// EMA 趋势策略 - 资金管理规则
export const STRATEGY_STAGES = {
  ROLLING: {
    name: "EMA 滚仓追踪",
    initial_risk: 0.05, // 5% Initial Position
    add_step: 0.05,     // Add 5% per 5% profit (Equity Gain)
    leverage: 5,        // Default Leverage (Consistent with global)
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
