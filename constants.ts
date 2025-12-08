
export const INSTRUMENT_ID = "ETH-USDT-SWAP";
// OKX V5 规范: ETH-USDT-SWAP 1张合约 = 0.1 ETH
// 注意: 实际交易前请核对 OKX 文档，部分币种为 0.01 或 10 USD
export const CONTRACT_VAL_ETH = 0.1;

// 费率设定 (保守估计 Taker 0.05%)
export const TAKER_FEE_RATE = 0.0005; 

// 全局默认杠杆
export const DEFAULT_LEVERAGE = "5";

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
  instId: INSTRUMENT_ID,
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
