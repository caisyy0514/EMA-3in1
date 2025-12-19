
import { AIDecision, MarketDataCollection, AccountContext, CandleData, SingleMarketData, SystemLog } from "../types";
import { COIN_CONFIG, TAKER_FEE_RATE, DEFAULT_LEVERAGE } from "../constants";

// --- DeepSeek API Helper ---
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const callDeepSeek = async (apiKey: string, messages: any[]) => {
    const cleanKey = apiKey ? apiKey.trim() : "";
    if (!cleanKey) throw new Error("API Key 为空");
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(cleanKey)) {
        throw new Error("API Key 包含非法字符(中文或特殊符号)");
    }

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cleanKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: messages,
                stream: false,
                temperature: 0.1, // Very low temp for strict logic
                max_tokens: 4096,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`DeepSeek API Error: ${response.status} - ${errText}`);
        }

        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e: any) {
        throw new Error(e.message || "DeepSeek 请求失败");
    }
};

export const testConnection = async (apiKey: string): Promise<string> => {
  if (!apiKey) throw new Error("API Key 为空");
  try {
    const content = await callDeepSeek(apiKey, [
        { role: "user", content: "Please respond with a JSON object containing the message 'OK'." }
    ]);
    return content || "无响应内容";
  } catch (e: any) {
    throw new Error(e.message || "连接失败");
  }
};

// --- Strategy Logic: Strict EMA Trend Tracking ---

function analyze1HTrend(candles: CandleData[]) {
    if (candles.length < 100) return { direction: 'NEUTRAL', timestamp: 0, description: "数据不足" };
    
    const latest = candles[candles.length - 1] as any;
    
    if (!latest.ema15 || !latest.ema60) {
        return { direction: 'NEUTRAL', timestamp: 0, description: "指标计算中" };
    }

    const ema15 = latest.ema15;
    const ema60 = latest.ema60;
    const price = parseFloat(latest.c);
    
    const isUp = price > ema60 && ema15 > ema60;
    const isDown = price < ema60 && ema15 < ema60;
    
    if (isUp) {
        return { 
            direction: 'UP', 
            timestamp: parseInt(latest.ts), 
            description: `上涨强劲 (Price>EMA60 & EMA15>EMA60)`
        };
    }
    
    if (isDown) {
        return { 
            direction: 'DOWN', 
            timestamp: parseInt(latest.ts),
            description: `下跌趋势 (Price<EMA60 & EMA15<EMA60)`
        };
    }
    
    return { direction: 'NEUTRAL', timestamp: parseInt(latest.ts), description: "震荡整理 (均线纠缠中)" };
}

function analyze3mEntry(candles: CandleData[], trendDirection: string) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "数据不足", structure: "分析中" };
    
    const curr = candles[candles.length - 1] as any;
    
    if (!curr.ema15 || !curr.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "分析中" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉区域" : "死叉区域";
    
    const TOLERANCE_CANDLES = 5; 

    if (trendDirection === 'UP') {
        if (currentGold) {
            let crossIndex = -1;
            for (let i = candles.length - 1; i > 0; i--) {
                const c = candles[i] as any;
                const p = candles[i-1] as any;
                if (p.ema15 <= p.ema60 && c.ema15 > c.ema60) {
                    crossIndex = i;
                    break;
                }
                if ((candles.length - 1) - i > TOLERANCE_CANDLES + 2) break; 
            }

            if (crossIndex !== -1) {
                const candlesSinceCross = (candles.length - 1) - crossIndex;
                if (candlesSinceCross <= TOLERANCE_CANDLES) {
                    let lowestInZone = parseFloat(candles[crossIndex - 1].l);
                    let lookbackLimit = 150; 
                    for (let i = crossIndex - 1; i >= 0 && lookbackLimit > 0; i--) {
                        const c = candles[i] as any;
                        if (c.ema15 <= c.ema60) {
                            const l = parseFloat(c.l);
                            if (l < lowestInZone) lowestInZone = l;
                        } else { break; }
                        lookbackLimit--;
                    }
                    return { 
                        signal: true, 
                        action: 'BUY', 
                        sl: lowestInZone, 
                        reason: `3m金叉确认 (第${candlesSinceCross}根K线)`,
                        structure: "满足入场"
                    };
                }
            }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: currentGold ? "金叉已过窗口期" : "等待金叉信号", structure };
    }
    
    if (trendDirection === 'DOWN') {
        if (!currentGold) {
             let crossIndex = -1;
             for (let i = candles.length - 1; i > 0; i--) {
                const c = candles[i] as any;
                const p = candles[i-1] as any;
                if (p.ema15 >= p.ema60 && c.ema15 < c.ema60) {
                    crossIndex = i;
                    break;
                }
                if ((candles.length - 1) - i > TOLERANCE_CANDLES + 2) break;
             }

             if (crossIndex !== -1) {
                 const candlesSinceCross = (candles.length - 1) - crossIndex;
                 if (candlesSinceCross <= TOLERANCE_CANDLES) {
                     let highestInZone = parseFloat(candles[crossIndex - 1].h);
                     let lookbackLimit = 150;
                     for (let i = crossIndex - 1; i >= 0 && lookbackLimit > 0; i--) {
                         const c = candles[i] as any;
                         if (c.ema15 >= c.ema60) {
                             const h = parseFloat(c.h);
                             if (h > highestInZone) highestInZone = h;
                         } else { break; }
                         lookbackLimit--;
                     }
                     return { 
                        signal: true, 
                        action: 'SELL', 
                        sl: highestInZone, 
                        reason: `3m死叉确认 (第${candlesSinceCross}根K线)`,
                        structure: "满足入场"
                    };
                 }
             }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: !currentGold ? "死叉已过窗口期" : "等待死叉信号", structure };
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "1H大趋势不明确，暂不交易", structure };
}

export const analyzeCoin = async (
    coinKey: string,
    apiKey: string,
    marketData: SingleMarketData,
    accountData: AccountContext,
    logs: SystemLog[]
): Promise<AIDecision> => {
    
    const config = COIN_CONFIG[coinKey];
    if (!config) throw new Error(`Unknown coin: ${coinKey}`);
    
    const TICK_SIZE = config.tickSize;
    const CONTRACT_VAL = config.contractVal;
    const INST_ID = config.instId;
    const MIN_SZ = config.minSz; 

    const currentPrice = parseFloat(marketData.ticker?.last || "0");
    const totalEquity = parseFloat(accountData.balance.totalEq);
    const availEquity = parseFloat(accountData.balance.availEq || "0");
    
    const trend1H = analyze1HTrend(marketData.candles1H);
    const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction);
    
    const primaryPosition = accountData.positions.find(p => p.instId === INST_ID);
    const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
    
    let posAnalysis = "无持仓";
    let finalAction = "HOLD";
    let finalSize = "0";
    let finalSL = "";
    let finalTP = "";
    let invalidationReason = "";
    let decimals = config.tickSize < 0.01 ? 4 : 2;

    if (hasPosition) {
        const p = primaryPosition!;
        const posSize = parseFloat(p.pos);
        const avgEntry = parseFloat(p.avgPx);
        const isLong = p.posSide === 'long';
        const margin = parseFloat(p.margin);
        const rawUpl = parseFloat(p.upl);
        
        const sizeCoins = posSize * CONTRACT_VAL;
        const estTotalFee = (sizeCoins * avgEntry + sizeCoins * currentPrice) * TAKER_FEE_RATE;
        const netPnl = rawUpl - estTotalFee;
        const netRoi = margin > 0 ? (netPnl / margin) : 0;
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos}张 | 净ROI: ${(netRoi * 100).toFixed(2)}%`;

        let trendReversal = (isLong && trend1H.direction === 'DOWN') || (!isLong && trend1H.direction === 'UP');
        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `趋势反转:1H大方向已切换为 ${trend1H.direction}`;
        }

        if (finalAction === 'HOLD') {
            if (netRoi >= 0.078) {
                const currentSL = parseFloat(p.slTriggerPx || "0");
                const feeBuffer = avgEntry * 0.002;
                let bePrice = isLong ? avgEntry + feeBuffer : avgEntry - feeBuffer;
                bePrice = parseFloat(bePrice.toFixed(decimals)); 
                const isSecured = isLong ? (currentSL >= bePrice) : (currentSL > 0 && currentSL <= bePrice);
                
                if (!isSecured) {
                    finalAction = "UPDATE_TPSL";
                    finalSL = bePrice.toFixed(decimals);
                    invalidationReason = `阶段二风控:净利达标,移动止损至成本价(${finalSL})`;
                }
            }
        }
    } else {
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "15%"; 
            finalSL = entry3m.sl.toFixed(decimals); 
            invalidationReason = entry3m.reason;
        }
    }

    const tDirection = trend1H.description;
    const tEntry = `${entry3m.structure} (${entry3m.reason})`;

    let decision: AIDecision = {
        coin: coinKey,
        instId: INST_ID,
        stage_analysis: "EMA严格趋势策略 (全托管版)",
        market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
        hot_events_overview: "策略配置已禁用热点分析", 
        coin_analysis: `趋势: ${tDirection} | 状态: ${posAnalysis}`,
        trading_decision: {
            action: finalAction as any,
            confidence: "100%", 
            position_size: finalSize,
            leverage: DEFAULT_LEVERAGE, 
            profit_target: finalTP,
            stop_loss: finalSL,
            invalidation_condition: invalidationReason || "等待信号"
        },
        reasoning: invalidationReason || entry3m.reason,
        action: finalAction as any,
        size: "0",
        leverage: DEFAULT_LEVERAGE
    };

    // 资金计算逻辑 (仅对交易指令有效)
    if (finalAction === 'BUY' || finalAction === 'SELL') {
        const leverage = parseFloat(DEFAULT_LEVERAGE); 
        const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;
        const minMarginRequired = marginPerContract * MIN_SZ;
        
        let contracts = 0;
        let isClose = hasPosition && ((primaryPosition!.posSide === 'long' && finalAction === 'SELL') || (primaryPosition!.posSide === 'short' && finalAction === 'BUY'));

        if (!isClose) {
            const pct = parseFloat(finalSize) / 100; 
            const strategyMarginAlloc = totalEquity * pct;
            let rawContracts = strategyMarginAlloc / marginPerContract;
            let target = parseFloat((Math.floor(rawContracts / MIN_SZ) * MIN_SZ).toFixed(MIN_SZ.toString().split('.')[1]?.length || 0));

            if (availEquity >= target * marginPerContract && target >= MIN_SZ) {
                contracts = target;
            } else if (availEquity >= minMarginRequired) {
                contracts = MIN_SZ;
            }
        } else {
            contracts = hasPosition ? parseFloat(primaryPosition!.pos) : 0;
        }

        if (contracts > 0) {
            decision.size = contracts.toString();
            decision.trading_decision.position_size = contracts.toString();
        } else if (!isClose) {
            decision.action = 'HOLD';
            decision.reasoning = `资金不足 (需${(minMarginRequired).toFixed(2)}U, 可用${availEquity.toFixed(2)}U)`;
        }
    }

    return decision;
};

export const getTradingDecision = async (
    apiKey: string,
    marketData: MarketDataCollection,
    accountData: AccountContext,
    logs: SystemLog[]
): Promise<AIDecision[]> => {
    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, logs);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
