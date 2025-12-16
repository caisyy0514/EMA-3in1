
import { AIDecision, MarketDataCollection, AccountContext, CandleData, SingleMarketData } from "../types";
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
    // Need enough data for EMA60 stability
    if (candles.length < 100) return { direction: 'NEUTRAL', timestamp: 0, description: "数据不足" };
    
    const latest = candles[candles.length - 1] as any;
    
    // If EMA data is missing (e.g. initial load), fallback
    if (!latest.ema15 || !latest.ema60) {
        return { direction: 'NEUTRAL', timestamp: 0, description: "指标计算中" };
    }

    const ema15 = latest.ema15;
    const ema60 = latest.ema60;
    const price = parseFloat(latest.c);
    
    // Rule 1: 1H Trend
    // UP: Price > EMA60 AND EMA15 > EMA60
    // DOWN: Price < EMA60 AND EMA15 < EMA60
    
    const isUp = price > ema60 && ema15 > ema60;
    const isDown = price < ema60 && ema15 < ema60;
    
    if (isUp) {
        return { 
            direction: 'UP', 
            timestamp: parseInt(latest.ts), 
            description: `上涨 (价格>EMA60 & EMA15>EMA60)`
        };
    }
    
    if (isDown) {
        return { 
            direction: 'DOWN', 
            timestamp: parseInt(latest.ts),
            description: `下跌 (价格<EMA60 & EMA15<EMA60)`
        };
    }
    
    return { direction: 'NEUTRAL', timestamp: parseInt(latest.ts), description: "震荡/均线纠缠" };
}

function analyze3mEntry(candles: CandleData[], trendDirection: string) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "数据不足", structure: "未知" };
    
    const curr = candles[candles.length - 1] as any;
    
    if (!curr.ema15 || !curr.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "未知" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉区域" : "死叉区域";
    
    // Tolerance: Allow entry if the cross happened within the last 5 candles (approx 24 mins)
    // Adjusted from strict "fresh cross" to "recent cross" to fix missed entries
    const TOLERANCE_CANDLES = 5; 

    // --- LONG ENTRY LOGIC ---
    if (trendDirection === 'UP') {
        // Condition: Currently in Gold Cross Zone
        if (currentGold) {
            // 1. Find the start of this Gold Zone (The Crossover Point)
            let crossIndex = -1;
            // Scan backwards
            for (let i = candles.length - 1; i > 0; i--) {
                const c = candles[i] as any;
                const p = candles[i-1] as any;
                // Detect transition: Previous was <= (Death), Current is > (Gold)
                if (p.ema15 <= p.ema60 && c.ema15 > c.ema60) {
                    crossIndex = i;
                    break;
                }
                // Safety break if we go back too far without finding start (e.g. massive trend)
                // If we exceed tolerance + buffer, we can stop, as signal won't be valid anyway
                if ((candles.length - 1) - i > TOLERANCE_CANDLES + 2) break; 
            }

            // 2. Evaluate if Cross is within Tolerance
            if (crossIndex !== -1) {
                const candlesSinceCross = (candles.length - 1) - crossIndex;
                
                if (candlesSinceCross <= TOLERANCE_CANDLES) {
                    // 3. Calculate SL (Lowest of Previous Death Zone)
                    let lowestInZone = parseFloat(candles[crossIndex - 1].l);
                    let foundStartOfDeathZone = false;
                    let lookbackLimit = 150; 

                    for (let i = crossIndex - 1; i >= 0 && lookbackLimit > 0; i--) {
                        const c = candles[i] as any;
                        if (c.ema15 <= c.ema60) {
                            // In previous Death Zone
                            const l = parseFloat(c.l);
                            if (l < lowestInZone) lowestInZone = l;
                        } else {
                            // Zone ended
                            foundStartOfDeathZone = true;
                            break;
                        }
                        lookbackLimit--;
                    }

                    return { 
                        signal: true, 
                        action: 'BUY', 
                        sl: lowestInZone, 
                        reason: `1H看涨 + 3m金叉 (发生于${candlesSinceCross}根K线前, 容错范围内)`,
                        structure: "金叉持稳"
                    };
                }
            }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: "1H看涨，3m处于金叉但已过入场窗口或处于死叉", structure };
    }
    
    // --- SHORT ENTRY LOGIC ---
    if (trendDirection === 'DOWN') {
        // Condition: Currently in Death Cross Zone
        if (!currentGold) {
             // 1. Find start of Death Zone
             let crossIndex = -1;
             for (let i = candles.length - 1; i > 0; i--) {
                const c = candles[i] as any;
                const p = candles[i-1] as any;
                // Transition: Previous was >= (Gold), Current is < (Death)
                if (p.ema15 >= p.ema60 && c.ema15 < c.ema60) {
                    crossIndex = i;
                    break;
                }
                if ((candles.length - 1) - i > TOLERANCE_CANDLES + 2) break;
             }

             // 2. Evaluate Tolerance
             if (crossIndex !== -1) {
                 const candlesSinceCross = (candles.length - 1) - crossIndex;
                 
                 if (candlesSinceCross <= TOLERANCE_CANDLES) {
                     // 3. Calculate SL (Highest of Previous Gold Zone)
                     let highestInZone = parseFloat(candles[crossIndex - 1].h);
                     let lookbackLimit = 150;

                     for (let i = crossIndex - 1; i >= 0 && lookbackLimit > 0; i--) {
                         const c = candles[i] as any;
                         if (c.ema15 >= c.ema60) {
                             const h = parseFloat(c.h);
                             if (h > highestInZone) highestInZone = h;
                         } else {
                             break;
                         }
                         lookbackLimit--;
                     }

                     return { 
                        signal: true, 
                        action: 'SELL', 
                        sl: highestInZone, 
                        reason: `1H看跌 + 3m死叉 (发生于${candlesSinceCross}根K线前, 容错范围内)`,
                        structure: "死叉持稳"
                    };
                 }
             }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: "1H看跌，3m处于死叉但已过入场窗口或处于金叉", structure };
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "1H趋势不明确或不满足入场", structure };
}

// --- Single Coin Analysis ---
const analyzeCoin = async (
    coinKey: string,
    apiKey: string,
    marketData: SingleMarketData,
    accountData: AccountContext
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
    
    // Strategy Analysis
    const trend1H = analyze1HTrend(marketData.candles1H);
    const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction);
    
    // Position Info
    const primaryPosition = accountData.positions.find(p => p.instId === INST_ID);
    const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
    
    let posAnalysis = "无持仓";
    let finalAction = "HOLD";
    let finalSize = "0";
    let finalSL = "";
    let finalTP = "";
    let invalidationReason = "";
    
    // Determine precision for formatting prices
    let decimals = config.tickSize < 0.01 ? 4 : 2;

    // --- Decision Logic ---
    if (hasPosition) {
        const p = primaryPosition!;
        const posSize = parseFloat(p.pos);
        const avgEntry = parseFloat(p.avgPx);
        const isLong = p.posSide === 'long';
        const leverageVal = parseFloat(p.leverage) || 20;

        // === NET PROFIT CALCULATION ===
        const sizeCoins = posSize * CONTRACT_VAL;
        const openValUsd = sizeCoins * avgEntry;
        const closeValUsd = sizeCoins * currentPrice;
        const estTotalFee = (openValUsd + closeValUsd) * TAKER_FEE_RATE;
        const rawUpl = parseFloat(p.upl);
        const netPnl = rawUpl - estTotalFee;
        const margin = parseFloat(p.margin);
        const netRoi = margin > 0 ? (netPnl / margin) : 0;
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, 净ROI: ${(netRoi * 100).toFixed(2)}% (净利: ${netPnl.toFixed(2)}U)`;

        // === 1. STOP LOSS CHECK (Hard Trend Reversal) ===
        let trendReversal = false;
        if (isLong && trend1H.direction === 'DOWN') trendReversal = true;
        if (!isLong && trend1H.direction === 'UP') trendReversal = true;

        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `[趋势反转] 1H趋势已变 (${trend1H.direction})`;
        }

        // === 2. MULTI-STAGE TAKE PROFIT LOGIC ===
        if (finalAction === 'HOLD') {
            
            // Estimate "Initial" Position Size based on 10% Equity Rule
            // Use (TotalEquity - UPL) to simulate "Entry Equity" so Ratio doesn't drift with PnL
            // This ensures strict sequential stage triggering.
            const equityAtEntry = totalEquity - rawUpl;
            const estInitialValUsd = equityAtEntry * 0.10;
            
            // Approx Contracts
            const estInitialQty = (estInitialValUsd * leverageVal) / (avgEntry * CONTRACT_VAL);
            
            // Ratio of Current vs Initial
            const ratio = posSize / estInitialQty;
            
            // --- Helper: check if we are truly in a stage based on ROI ---
            // If we have very small position but low ROI, we are NOT in Stage 4, we are just poor.
            // This prevents "Small Initial Position" from being treated as "Stage 4 Tail".
            
            // STAGE 1 Check:
            const isStage1Logic = () => {
                 if (netRoi >= 0.05 && ratio > 0.85) return true;
                 // Fallback: If Ratio is small (e.g. manual small open) but ROI hasn't hit Stage 2 yet, treat as Stage 1
                 if (ratio <= 0.85 && netRoi >= 0.05 && netRoi < 0.08) return true;
                 return false;
            };

            // STAGE 2 Check:
            const isStage2Logic = () => {
                 // Standard path: Ratio reduced, ROI increased
                 if (netRoi >= 0.08 && ratio > 0.55 && ratio <= 0.85) return true;
                 // Fallback: Small position, ROI in Stage 2 zone
                 if (ratio <= 0.55 && netRoi >= 0.08 && netRoi < 0.12) return true;
                 return false;
            };

            // STAGE 3 Check:
            const isStage3Logic = () => {
                 if (netRoi >= 0.12 && ratio > 0.30 && ratio <= 0.55) return true;
                 // Fallback: Small position, ROI in Stage 3 zone (but not yet secure enough for tail)
                 // Actually, if ROI > 12%, we are happy. 
                 return false;
            };
            
            // STAGE 4 Check:
            // STRICT REQUIREMENT: Must have achieved Stage 3 Profit Levels (ROI >= 12%) before entering Stage 4 logic.
            const isStage4Logic = () => {
                 // Only enter Stage 4 if we are "Tail" size AND we have "Tail" profits.
                 if (ratio <= 0.30 && netRoi >= 0.12) return true;
                 return false;
            };


            // --- EXECUTION ---
            
            if (isStage1Logic()) {
                finalAction = isLong ? "SELL" : "BUY";
                finalSize = (posSize * 0.3).toFixed(0); 
                invalidationReason = `[阶段一止盈] ROI ${(netRoi*100).toFixed(2)}% >= 5% -> 平仓30%`;
            }
            else if (isStage2Logic()) {
                 finalAction = isLong ? "SELL" : "BUY";
                 // Target 40% Remaining (approx close 30% of initial)
                 let targetSell = estInitialQty * 0.3;
                 // Safety: Don't sell more than we have
                 if (targetSell > posSize) targetSell = posSize;
                 
                 finalSize = targetSell.toFixed(0);
                 invalidationReason = `[阶段二止盈] ROI ${(netRoi*100).toFixed(2)}% >= 8% -> 再平30%`;
            }
            else if (isStage3Logic()) {
                finalAction = isLong ? "SELL" : "BUY";
                // Target 20% Remaining (approx close 20% of initial)
                let targetSell = estInitialQty * 0.2;
                if (targetSell > posSize) targetSell = posSize;
                
                finalSize = targetSell.toFixed(0);
                invalidationReason = `[阶段三止盈] ROI ${(netRoi*100).toFixed(2)}% >= 12% -> 再平20% (保留尾仓)`;
            }
            else if (isStage4Logic()) {
                // Rule: "In this stage, when net profit retraces more than 5% (to 7%)"
                if (netRoi < 0.07) {
                    finalAction = "CLOSE";
                    invalidationReason = `[阶段四清仓] ROI回撤至 ${(netRoi*100).toFixed(2)}% (<7%) -> 获利了结`;
                } else {
                    // Logic: Trailing Stop
                    const roiBuffer = 0.05;
                    const priceBuffer = (roiBuffer * avgEntry) / leverageVal;
                    
                    let targetSL = 0;
                    if (isLong) targetSL = currentPrice - priceBuffer;
                    else targetSL = currentPrice + priceBuffer;
                    
                    // Floor SL at 7% profit
                    const minRoi = 0.07;
                    const minProfitDelta = (minRoi * avgEntry) / leverageVal;
                    let floorSL = isLong ? avgEntry + minProfitDelta : avgEntry - minProfitDelta;
                    
                    let finalSLVal = isLong ? Math.max(targetSL, floorSL) : Math.min(targetSL, floorSL);
                    
                    finalAction = "UPDATE_TPSL";
                    finalSL = finalSLVal.toFixed(decimals);
                    invalidationReason = `[阶段四护盘] 移动止损追踪 (回撤阈值5%)`;
                }
            }
            else {
                // If we are holding small position but ROI is small (e.g. just opened 2% equity manually),
                // we fall through here. We just HOLD.
                // We also check Maintenance SL for Break Even here.
            }

            // === SPECIAL MAINTENANCE: SL UPDATE (Independent of Stage Logic) ===
            // This ensures ANY profitable trade eventually gets BE protection
            if (finalAction === 'HOLD' && netRoi > 0.02) {
                 // Trigger BE move if we are past Stage 1 physically (Ratio < 0.85) OR if ROI is good enough
                 if (ratio <= 0.85) {
                     const currentSL = parseFloat(p.slTriggerPx || "0");
                     const isSLSafe = isLong ? (currentSL > avgEntry) : (currentSL > 0 && currentSL < avgEntry);
                     
                     if (!isSLSafe) {
                         finalAction = "UPDATE_TPSL";
                         const feeBuffer = avgEntry * 0.001; 
                         finalSL = isLong ? (avgEntry + feeBuffer).toFixed(decimals) : (avgEntry - feeBuffer).toFixed(decimals);
                         invalidationReason = `[风控] 既然已部分止盈，强制移动止损至保本位`;
                     }
                 }
            }
        }

    } else {
        // No Position: Check Entry
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "10%"; // Rule: 10% of Total Account
            finalSL = entry3m.sl.toFixed(decimals);
        }
    }

    // --- Prompt Construction ---
    const systemPrompt = `
你是一个严格执行 **${coinKey} 趋势策略** 的交易机器人。
**严禁** 使用任何其他指标（RSI, MACD, KDJ 等），只关注 EMA15 和 EMA60。
当前时间: ${new Date().toLocaleString()}

**核心原则**:
1. **净利润至上**: 所有收益评估必须扣除双边手续费(约0.1%)，保本是第一要务。
2. **多阶段止盈 (由代码逻辑主导，你只需确认)**:
   - 阶段一(ROI>5%): 平30%。
   - 阶段二(ROI>8%): 再平30%（按初始仓位计） + 并将止损设置跨过盈亏平衡价（持多单向上跨越，持空单向下跨越）。
   - 阶段三(ROI>12%): 再平20%（按初始仓位计）。
   - 阶段四(尾仓): 实施 5% ROI 的移动止损（Trailing Stop），或在利润回撤至 7% 以下时直接清仓。

**策略规则**:
1. **1H 趋势**:  ${trend1H.direction} (自 ${new Date(trend1H.timestamp).toLocaleTimeString()})   
   - 只要EMA15 > EMA60 且 K线阳线即为UP。
   - 只要EMA15 < EMA60 且 K线阴线即为DOWN
2. **3m 入场**:
   - 做多: 1H涨势下，3m图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。金叉K线收盘进场。
   - 做空: 1H跌势下，3m图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。死叉K线收盘进场。
3. **资金**: 10% 权益。
4. **止损**: 3m 趋势下前一个反向交叉区间的极值（多单找死叉区间最低，空单找金叉区间最高）。

**当前状态**:
- 1H: ${trend1H.description}
- 3m: ${entry3m.structure}
- 信号: ${entry3m.signal ? "触发开仓" : entry3m.reason}
- 持仓: ${posAnalysis}
- 建议动作: ${finalAction} ${finalSize !== "0" ? `(数量: ${finalSize})` : ""}

**输出要求**:
1. 返回格式必须为 JSON。
2. **market_assessment**: 必须明确包含以下两行结论：
   - 【1H趋势】：${trend1H.description} 明确指出当前1小时级别EMA15和EMA60的关系（ [金叉 EMA15>60] 或 [死叉 EMA15<60]）是上涨还是下跌。
   - 【3m入场】：：${entry3m.structure} - ${entry3m.signal ? "满足入场" : "等待机会"}明确指出当前3分钟级别是否满足策略定义的入场条件，并说明原因。
3. **重要**: 所有文本分析字段（stage_analysis, market_assessment, hot_events_overview, eth_analysis, reasoning, invalidation_condition）必须使用 **中文 (Simplified Chinese)** 输出。
4. **hot_events_overview**: 直接输出 "策略配置已禁用热点分析"。
5. 根据 "建议动作" 生成最终 JSON。

请基于上述逻辑生成JSON决策。
`;

    try {
        const text = await callDeepSeek(apiKey, [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Account: ${totalEquity} USDT. Coin: ${coinKey}.` }
        ]);

        const tDirection = trend1H.description;
        const tEntry = `${entry3m.structure} - ${entry3m.signal ? "满足入场" : entry3m.reason}`;

        let decision: AIDecision = {
            coin: coinKey,
            instId: INST_ID,
            stage_analysis: "EMA严格趋势策略 (四阶段止盈版)",
            market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
            hot_events_overview: "策略配置已禁用热点分析", // Hardcoded per user request
            coin_analysis: `趋势: ${tDirection}。状态: ${posAnalysis}`,
            trading_decision: {
                action: finalAction as any,
                confidence: "100%", 
                position_size: finalSize,
                leverage: DEFAULT_LEVERAGE, 
                profit_target: finalTP,
                stop_loss: finalSL,
                invalidation_condition: invalidationReason || "Trend Reversal"
            },
            reasoning: `逻辑判定: ${finalAction}。${invalidationReason}`,
            action: finalAction as any,
            size: "0",
            leverage: DEFAULT_LEVERAGE
        };

        try {
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const aiJson = JSON.parse(cleanText);
            
            if(aiJson.market_assessment) decision.market_assessment = aiJson.market_assessment;
            // Force disable hot events overwrite
            decision.hot_events_overview = "策略配置已禁用热点分析";
            if(aiJson.coin_analysis) decision.coin_analysis = aiJson.coin_analysis;
            if(aiJson.reasoning) decision.reasoning = `${decision.reasoning} | AI视角: ${aiJson.reasoning}`;

        } catch (e) {
            console.warn(`[${coinKey}] AI JSON parse failed, using local logic.`);
        }

        // --- SIZE CALCULATION REFACTOR (Fix for "Balance Sufficient but Forced Min") ---
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            
            let contracts = 0;
            const leverage = parseFloat(DEFAULT_LEVERAGE); 
            // Correct Margin Calculation: (ContractVal * Price) / Leverage
            const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;

            // Determine if this is an OPEN (Increase) or CLOSE (Reduce) action
            let isClose = false;
            if (hasPosition) {
                const p = primaryPosition!;
                if (p.posSide === 'long' && finalAction === 'SELL') isClose = true;
                if (p.posSide === 'short' && finalAction === 'BUY') isClose = true;
            }

            if (finalSize.includes('%')) {
                // Percentage Based (Usually Opening)
                const pct = parseFloat(finalSize) / 100; 
                const strategyAmountU = totalEquity * pct;
                
                // If Opening: Check Balance
                // If Closing: Ignore Balance, just calc size
                if (!isClose) {
                    const maxAffordableU = availEquity; // USE FULL BALANCE, NO BUFFER (Exchange handles tiny buffers)
                    const targetAmountU = Math.min(strategyAmountU, maxAffordableU);
                    contracts = Math.floor(targetAmountU / marginPerContract);
                } else {
                    // Closing logic with % (unlikely in this strategy but good for safety)
                    contracts = Math.floor(strategyAmountU / marginPerContract);
                }
            } else {
                // Fixed Number (Usually Partial Close from Stage Logic)
                contracts = Math.floor(parseFloat(finalSize));
            }

            // --- MIN SIZE ENFORCEMENT & BALANCE CHECK ---
            
            if (contracts < MIN_SZ) {
                if (isClose) {
                     // For CLOSE/REDUCE:
                     // If calculated reduction is 0 (e.g. 30% of 1 contract = 0.3 -> 0),
                     // BUT we have a position, we should force at least 1 contract close 
                     // IF the user actually holds >= MIN_SZ.
                     const held = hasPosition ? parseFloat(primaryPosition!.pos) : 0;
                     if (held >= MIN_SZ) {
                         contracts = MIN_SZ; // Force minimum close to ensure TP happens
                         decision.reasoning += ` [止盈] 计算量小于最小单位，强制执行最小单位平仓`;
                     } else {
                         // We hold less than min size (dust)? Or 0?
                         // If 0, do nothing. If dust, try to close all.
                         contracts = Math.floor(held);
                     }
                } else {
                    // For OPEN:
                    // Only force Min Size if we actually have money for it.
                    const costForMin = marginPerContract * MIN_SZ;
                    
                    // STRICT CHECK: Do we have enough avail equity for MIN_SZ?
                    if (availEquity >= costForMin) {
                        contracts = MIN_SZ;
                        // Only add warning if the STRATEGY wanted less than min, but we boosted it.
                        // If we are just opening standard min, it's fine.
                        decision.reasoning += ` [保底交易] 余额充足(${availEquity.toFixed(2)}U >= ${costForMin.toFixed(2)}U)，强制最小开仓`;
                    } else {
                        // Truly insufficient
                        decision.action = 'HOLD';
                        decision.size = "0";
                        decision.reasoning += ` [资金不足] 需${costForMin.toFixed(2)}U (Lev:${leverage}x), 余额${availEquity.toFixed(2)}U`;
                        contracts = 0;
                    }
                }
            }

            // Final Safe-guard
            if (contracts > 0 && decision.action !== 'HOLD') {
                decision.size = contracts.toString();
                const estimatedValue = (contracts * CONTRACT_VAL * currentPrice).toFixed(2);
                decision.reasoning += ` [拟执行: ${contracts}张 (${estimatedValue}U)]`;
            } else if (decision.action !== 'HOLD') {
                decision.action = 'HOLD'; 
            }
        }

        return decision;

    } catch (error: any) {
        console.error(`Strategy Error for ${coinKey}:`, error);
        return {
            coin: coinKey,
            instId: INST_ID,
            stage_analysis: "错误",
            market_assessment: "N/A",
            hot_events_overview: "N/A",
            coin_analysis: "N/A",
            trading_decision: { action: 'HOLD', confidence: "0%", position_size: "0", leverage: "0", profit_target: "", stop_loss: "", invalidation_condition: "" },
            reasoning: `系统错误: ${error.message}`,
            action: 'HOLD',
            size: "0",
            leverage: "0"
        };
    }
}

// --- Orchestrator ---
export const getTradingDecision = async (
    apiKey: string,
    marketData: MarketDataCollection,
    accountData: AccountContext
): Promise<AIDecision[]> => {
    // Disabled News Fetching to save tokens
    // const newsContext = await fetchRealTimeNews();

    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
