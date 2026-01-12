
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
                temperature: 0.1, 
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

/**
 * 恢复为基础均线确认逻辑：仅在金叉/死叉发生后的窗口期内入场
 */
function analyze3mEntry(candles: CandleData[], trendDirection: string, currentPrice: number, leverage: number) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "数据不足", structure: "分析中" };
    
    const curr = candles[candles.length - 1] as any;
    if (!curr.ema15 || !curr.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "分析中" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉区域" : "死叉区域";
    const TOLERANCE_CANDLES = 5; 

    const riskDistancePct = 0.1 / leverage; 
    const longHardSL = currentPrice * (1 - riskDistancePct);
    const shortHardSL = currentPrice * (1 + riskDistancePct);

    // --- 1. 多头逻辑 (1H UP + 3m 金叉) ---
    if (trendDirection === 'UP' && currentGold) {
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
                let sumLow = 0;
                let count = 0;
                let foundStart = false;
                for (let i = crossIndex - 1; i >= 0; i--) {
                    const c = candles[i] as any;
                    if (c.ema15 < c.ema60) {
                        sumLow += parseFloat(c.l);
                        count++;
                        foundStart = true;
                    } else if (foundStart) break;
                    if (count > 50) break;
                }
                const structuralAvgSL = count > 0 ? sumLow / count : parseFloat(candles[crossIndex-1].l);
                const finalSL = Math.max(structuralAvgSL, longHardSL);
                return { 
                    signal: true, action: 'BUY', sl: finalSL, 
                    reason: `3m 金叉确认 (第${candlesSinceCross}根)`,
                    structure: "满足入场"
                };
            }
        }
    }
    
    // --- 2. 空头逻辑 (1H DOWN + 3m 死叉) ---
    if (trendDirection === 'DOWN' && !currentGold) {
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
                let sumHigh = 0;
                let count = 0;
                let foundStart = false;
                for (let i = crossIndex - 1; i >= 0; i--) {
                    const c = candles[i] as any;
                    if (c.ema15 > c.ema60) {
                        sumHigh += parseFloat(c.h);
                        count++;
                        foundStart = true;
                    } else if (foundStart) break;
                    if (count > 50) break;
                }
                const structuralAvgSL = count > 0 ? sumHigh / count : parseFloat(candles[crossIndex-1].h);
                const finalSL = Math.min(structuralAvgSL, shortHardSL);
                return { 
                   signal: true, action: 'SELL', sl: finalSL, 
                   reason: `3m 死叉确认 (第${candlesSinceCross}根)`,
                   structure: "满足入场"
               };
            }
        }
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "等待 3m 均线交叉信号", structure };
}

export const analyzeCoin = async (
    coinKey: string,
    apiKey: string,
    marketData: SingleMarketData,
    accountData: AccountContext,
    logs: SystemLog[],
    isEnabled: boolean = true
): Promise<AIDecision> => {
    
    const config = COIN_CONFIG[coinKey];
    if (!config) throw new Error(`Unknown coin: ${coinKey}`);
    
    const INST_ID = config.instId;
    const MIN_SZ = config.minSz; 
    const CONTRACT_VAL = config.contractVal;

    const currentPrice = parseFloat(marketData.ticker?.last || "0");
    const totalEquity = parseFloat(accountData.balance.totalEq);
    const availEquity = parseFloat(accountData.balance.availEq || "0");
    
    const leverage = parseFloat(DEFAULT_LEVERAGE);

    const trend1H = analyze1HTrend(marketData.candles1H);
    const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction, currentPrice, leverage);
    
    const primaryPosition = accountData.positions.find(p => p.instId === INST_ID);
    const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;

    // --- Asset Admission Control ---
    if (!isEnabled && !hasPosition) {
        return {
            coin: coinKey, instId: INST_ID, stage_analysis: "已禁用", market_assessment: "币种交易开关已关闭",
            hot_events_overview: "N/A", coin_analysis: "币种已从准入名单中移除", action: 'HOLD', size: "0", leverage: DEFAULT_LEVERAGE,
            reasoning: "[币种已禁用] 停止所有开新仓尝试",
            trading_decision: { action: 'HOLD', confidence: "0%", position_size: "0", leverage: DEFAULT_LEVERAGE, profit_target: "", stop_loss: "", invalidation_condition: "币种已禁用" }
        };
    }
    
    let posAnalysis = "无持仓";
    let finalAction = "HOLD";
    let finalSize = "0";
    let finalSL = "";
    let finalTP = "";
    let invalidationReason = "";
    let decimals = config.tickSize < 0.01 ? 4 : 2;

    if (hasPosition) {
        const p = primaryPosition!;
        const avgEntry = parseFloat(p.avgPx);
        const isLong = p.posSide === 'long';
        const margin = parseFloat(p.margin);
        const rawUpl = parseFloat(p.upl);
        
        const sizeCoins = parseFloat(p.pos) * CONTRACT_VAL;
        const estTotalFee = (sizeCoins * avgEntry + sizeCoins * currentPrice) * TAKER_FEE_RATE;
        const netPnl = rawUpl - estTotalFee;
        const netRoi = margin > 0 ? (netPnl / margin) : 0;
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos}张 | 净ROI: ${(netRoi * 100).toFixed(2)}%`;

        let trendReversal = (isLong && trend1H.direction === 'DOWN') || (!isLong && trend1H.direction === 'UP');
        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `趋势反转:1H方向切换至 ${trend1H.direction}`;
        }

        if (finalAction === 'HOLD' && netRoi >= 0.078) {
            const currentSL = parseFloat(p.slTriggerPx || "0");
            const feeBuffer = avgEntry * 0.002;
            let bePrice = isLong ? avgEntry + feeBuffer : avgEntry - feeBuffer;
            bePrice = parseFloat(bePrice.toFixed(decimals)); 
            const isSecured = isLong ? (currentSL >= bePrice) : (currentSL > 0 && currentSL <= bePrice);
            
            if (!isSecured) {
                finalAction = "UPDATE_TPSL";
                finalSL = bePrice.toFixed(decimals);
                invalidationReason = `保本止损:净利达标,移动止损至 ${finalSL}`;
            }
        }
    } else {
        // Only trigger entry if enabled
        if (isEnabled && entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "15%"; 
            finalSL = entry3m.sl.toFixed(decimals); 
            invalidationReason = entry3m.reason;
        } else if (!isEnabled) {
            invalidationReason = "[币种已禁用] 拒绝新开仓信号";
        }
    }

    const tDirection = trend1H.description;
    const tEntry = `${entry3m.structure} (${entry3m.reason})`;

    let decision: AIDecision = {
        coin: coinKey,
        instId: INST_ID,
        stage_analysis: isEnabled ? "EMA严格趋势追踪策略" : "EMA趋势策略 (限制模式: 仅平仓)",
        market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
        hot_events_overview: "未启用实时热点", 
        coin_analysis: `状态: ${posAnalysis}`,
        trading_decision: {
            action: finalAction as any,
            confidence: "100%", 
            position_size: finalSize,
            leverage: DEFAULT_LEVERAGE, 
            profit_target: finalTP,
            stop_loss: finalSL,
            invalidation_condition: invalidationReason || "等待均线确认"
        },
        reasoning: invalidationReason || entry3m.reason,
        action: finalAction as any,
        size: "0",
        leverage: DEFAULT_LEVERAGE
    };

    if (finalAction === 'BUY' || finalAction === 'SELL') {
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
            decision.reasoning = `可用资金不足`;
        }
    }

    return decision;
};

export const getTradingDecision = async (
    apiKey: string,
    marketData: MarketDataCollection,
    accountData: AccountContext,
    logs: SystemLog[],
    enabledCoins: string[] = []
): Promise<AIDecision[]> => {
    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        const isEnabled = enabledCoins.length === 0 || enabledCoins.includes(coinKey);
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, logs, isEnabled);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
