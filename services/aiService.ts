
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
 * 核心优化：动能前瞻 (Momentum Lead) + 均线确认双轨入场逻辑
 */
function analyze3mEntry(candles: CandleData[], trendDirection: string, currentPrice: number, leverage: number) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "数据不足", structure: "分析中" };
    
    const curr = candles[candles.length - 1] as any;
    const prev = candles[candles.length - 2] as any;
    if (!curr.ema15 || !curr.ema60 || !prev.ema15) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "分析中" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉区域" : "死叉区域";
    const TOLERANCE_CANDLES = 5; 

    // --- 0. 基础风险计算 ---
    const riskDistancePct = 0.1 / leverage; // 10% 保证金损耗
    const longHardSL = currentPrice * (1 - riskDistancePct);
    const shortHardSL = currentPrice * (1 + riskDistancePct);

    // --- 1. 动能前瞻计算 (Momentum Lead Indicators) ---
    const currentGap = Math.abs(curr.ema15 - curr.ema60);
    const prevGap = Math.abs(prev.ema15 - prev.ema60);
    const ema15Slope = curr.ema15 - prev.ema15;
    
    // 成交量异动检测 (过去5根均值的 1.5 倍)
    let totalVol = 0;
    const volLookback = 5;
    for (let i = candles.length - 2; i >= candles.length - (volLookback + 1); i--) {
        totalVol += parseFloat(candles[i].vol);
    }
    const avgVol = totalVol / volLookback;
    const isVolPulse = parseFloat(curr.vol) > avgVol * 1.5;

    // --- 2. 多头策略分支 (1H UP) ---
    if (trendDirection === 'UP') {
        // A. 抢跑入场 (死叉中，但价格已突围)
        if (!currentGold) {
            const isPriceBreakout = currentPrice > curr.ema15 && currentPrice > curr.ema60;
            const isConverging = currentGap < prevGap;
            const isUpturning = ema15Slope > 0;

            if (isPriceBreakout && isConverging && isUpturning && isVolPulse) {
                // 前瞻止损：信号 K 线低点 vs 杠杆限额
                const signalLow = parseFloat(curr.l);
                const finalSL = Math.max(signalLow, longHardSL);
                return {
                    signal: true, action: 'BUY', sl: finalSL,
                    reason: `3m 动能前瞻 (价格先行+间距收敛+放量)`,
                    structure: "抢跑入场"
                };
            }
        }

        // B. 确认入场 (金叉窗口期)
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
                    // 结构均值止损：回溯最新死叉区间的最低价均值
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
                        reason: `3m 金叉确认 (第${candlesSinceCross}根) | 止损参考: ${finalSL === longHardSL ? '杠杆限额' : '结构均值'}`,
                        structure: "满足入场"
                    };
                }
            }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: currentGold ? "金叉已过窗口期" : "等待金叉或前瞻信号", structure };
    }
    
    // --- 3. 空头策略分支 (1H DOWN) ---
    if (trendDirection === 'DOWN') {
        // A. 抢跑入场 (金叉中，但价格已击穿)
        if (currentGold) {
            const isPriceBreakdown = currentPrice < curr.ema15 && currentPrice < curr.ema60;
            const isConverging = currentGap < prevGap;
            const isDownturning = ema15Slope < 0;

            if (isPriceBreakdown && isConverging && isDownturning && isVolPulse) {
                // 前瞻止损：信号 K 线高点 vs 杠杆限额
                const signalHigh = parseFloat(curr.h);
                const finalSL = Math.min(signalHigh, shortHardSL);
                return {
                    signal: true, action: 'SELL', sl: finalSL,
                    reason: `3m 动能前瞻 (价格跌破+间距收敛+放量)`,
                    structure: "抢跑入场"
                };
            }
        }

        // B. 确认入场 (死叉窗口期)
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
                     // 结构均值止损：回溯最新金叉区间的最高价均值
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
                        reason: `3m 死叉确认 (第${candlesSinceCross}根) | 止损参考: ${finalSL === shortHardSL ? '杠杆限额' : '结构均值'}`,
                        structure: "满足入场"
                    };
                 }
             }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: !currentGold ? "死叉已过窗口期" : "等待死叉或前瞻信号", structure };
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
    
    // 获取当前策略杠杆
    const leverage = parseFloat(DEFAULT_LEVERAGE);

    const trend1H = analyze1HTrend(marketData.candles1H);
    const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction, currentPrice, leverage);
    
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
            // 阶段二风控：当净ROI 超过 7.8% 时，强行移动止损至保本位（覆盖手续费）
            if (netRoi >= 0.078) {
                const currentSL = parseFloat(p.slTriggerPx || "0");
                const feeBuffer = avgEntry * 0.002;
                let bePrice = isLong ? avgEntry + feeBuffer : avgEntry - feeBuffer;
                bePrice = parseFloat(bePrice.toFixed(decimals)); 
                const isSecured = isLong ? (currentSL >= bePrice) : (currentSL > 0 && currentSL <= bePrice);
                
                if (!isSecured) {
                    finalAction = "UPDATE_TPSL";
                    finalSL = bePrice.toFixed(decimals);
                    invalidationReason = `移动止损(BE):净利达标,锁定利润,止损至 ${finalSL}`;
                }
            }
        }
    } else {
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "15%"; // 默认入场比例
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
