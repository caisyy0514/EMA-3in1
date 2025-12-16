
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
                if ((candles.length - 1) - i > TOLERANCE_CANDLES + 2) break; 
            }

            // 2. Evaluate if Cross is within Tolerance
            if (crossIndex !== -1) {
                const candlesSinceCross = (candles.length - 1) - crossIndex;
                
                if (candlesSinceCross <= TOLERANCE_CANDLES) {
                    // 3. Calculate SL (Lowest of Previous Death Zone)
                    let lowestInZone = parseFloat(candles[crossIndex - 1].l);
                    let lookbackLimit = 150; 

                    for (let i = crossIndex - 1; i >= 0 && lookbackLimit > 0; i--) {
                        const c = candles[i] as any;
                        if (c.ema15 <= c.ema60) {
                            // In previous Death Zone
                            const l = parseFloat(c.l);
                            if (l < lowestInZone) lowestInZone = l;
                        } else {
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
        const posCreationTime = parseInt(p.cTime);

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
        // 任何阶段，只要1H大趋势反转，必须无条件离场
        let trendReversal = false;
        if (isLong && trend1H.direction === 'DOWN') trendReversal = true;
        if (!isLong && trend1H.direction === 'UP') trendReversal = true;

        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `[趋势反转] 1H趋势已变 (${trend1H.direction})，强制平仓`;
        }

        // === 2. SEQUENTIAL TAKE PROFIT & TRAILING STOP (Backtracking Logic) ===
        
        if (finalAction === 'HOLD') {
            
            // 计算"估算初始开仓总量" (Estimated Initial Total Quantity)
            // 公式: (总权益 - 未结盈亏) * 10% * 杠杆 / (入场价 * 合约面值)
            const equityAtEntry = totalEquity - rawUpl;
            const strategyAllocatedEquity = equityAtEntry * 0.10; 
            const estInitialQty = (strategyAllocatedEquity * leverageVal) / (avgEntry * CONTRACT_VAL);
            
            // --- ACTION BACKTRACKING STAGE DETERMINATION ---
            // 依据日志回溯确定当前处于哪个阶段
            let currentStage = 1;

            // Filter logs related to this coin AND occurred AFTER position creation
            const relevantLogs = logs.filter(log => {
                return log.timestamp.getTime() > posCreationTime && log.message.includes(`[${coinKey}]`);
            });

            const hasStage1TP = relevantLogs.some(l => l.message.includes("阶段一止盈") && l.type === 'TRADE'); // Check TRADE type to ensure execution
            const hasStage2TP = relevantLogs.some(l => l.message.includes("阶段二止盈") && l.type === 'TRADE');
            const hasStage3TP = relevantLogs.some(l => l.message.includes("阶段三止盈") && l.type === 'TRADE');

            if (hasStage3TP) currentStage = 4;
            else if (hasStage2TP) currentStage = 3;
            else if (hasStage1TP) currentStage = 2;
            else currentStage = 1;

            // --- STAGE EXECUTION ---

            // --- STAGE 1 (满仓阶段) ---
            if (currentStage === 1) {
                // Rule: Net ROI >= 5% -> Close 30% of INITIAL
                if (netRoi >= 0.05) {
                    finalAction = isLong ? "SELL" : "BUY";
                    finalSize = (estInitialQty * 0.3).toFixed(0); 
                    invalidationReason = `[阶段一止盈] 净ROI ${(netRoi*100).toFixed(2)}% ≥ 5% -> 平仓初始量的30%`;
                }
            }

            // --- STAGE 2 (执行过一次止盈) ---
            else if (currentStage === 2) { 
                // Rule 1: Net ROI >= 8% -> Close 30% of INITIAL
                if (netRoi >= 0.08) {
                    finalAction = isLong ? "SELL" : "BUY";
                    finalSize = (estInitialQty * 0.3).toFixed(0);
                    invalidationReason = `[阶段二止盈] 净ROI ${(netRoi*100).toFixed(2)}% ≥ 8% -> 再平初始量的30%`;
                } 
                // Rule 2: Force Break Even SL (Stage 2 Mandatory)
                else {
                    const currentSL = parseFloat(p.slTriggerPx || "0");
                    const feeBuffer = avgEntry * 0.002;
                    const bePrice = isLong ? avgEntry + feeBuffer : avgEntry - feeBuffer;
                    
                    const isSecured = isLong ? (currentSL >= bePrice) : (currentSL > 0 && currentSL <= bePrice);
                    
                    if (!isSecured) {
                        finalAction = "UPDATE_TPSL";
                        finalSL = bePrice.toFixed(decimals);
                        invalidationReason = `[阶段二风控] 已过阶段一，调整剩余仓位止损至成本价`;
                    }
                }
            }

            // --- STAGE 3 (执行过两次止盈) ---
            else if (currentStage === 3) {
                // Rule: Net ROI >= 12% -> Close 20% of INITIAL
                if (netRoi >= 0.12) {
                    finalAction = isLong ? "SELL" : "BUY";
                    finalSize = (estInitialQty * 0.2).toFixed(0);
                    invalidationReason = `[阶段三止盈] 净ROI ${(netRoi*100).toFixed(2)}% ≥ 12% -> 再平初始量的20%`;
                }
                // (保本损已在阶段二设置)
            }

            // --- STAGE 4 (尾仓阶段) ---
            else if (currentStage === 4) { 
                // Rule: Trailing Stop for the remaining 20%
                // 1. Calculate Price Delta equivalent to 5% ROI
                const roiGap = 0.05;
                const priceGap = (roiGap * avgEntry) / leverageVal;
                
                // 2. Calculate Target SL based on CURRENT price
                let targetSL = isLong ? currentPrice - priceGap : currentPrice + priceGap;
                
                // 3. Compare with Existing SL
                const currentSL = parseFloat(p.slTriggerPx || "0");
                let needUpdate = false;
                
                if (isLong) {
                    // Update if Target SL is higher than Current SL
                    if (currentSL === 0 || targetSL > currentSL) {
                        finalSL = targetSL.toFixed(decimals);
                        needUpdate = true;
                    } 
                } else {
                    // Update if Target SL is lower than Current SL
                    if (currentSL === 0 || targetSL < currentSL) {
                        finalSL = targetSL.toFixed(decimals);
                        needUpdate = true;
                    }
                }
                
                if (needUpdate) {
                    finalAction = "UPDATE_TPSL";
                    invalidationReason = `[阶段四护盘] 尾仓追踪: 设置回撤5%止损 (当前ROI ${(netRoi*100).toFixed(2)}%)`;
                }
            }
        }

    } else {
        // --- NO POSITION: ENTRY LOGIC ---
        // 保持原有的开仓判断不变: 3m 趋势下前一个反向交叉区间的极值
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "10%"; // Rule: 10% of Total Account
            finalSL = entry3m.sl.toFixed(decimals); 
            invalidationReason = `[开仓] 3m策略信号触发, 止损设为前一交叉极值(${finalSL})`;
        }
    }

    // --- Prompt Construction ---
    const systemPrompt = `
你是一个严格执行 **${coinKey} 趋势策略** 的交易机器人。
**严禁** 使用任何其他指标，只关注 EMA15 和 EMA60。
当前时间: ${new Date().toLocaleString()}

**核心原则**:
1. **净利润至上**: 所有收益评估必须扣除双边手续费(约0.1%)。
2. **多阶段止盈 (基于初始开仓总量)**:
   - 阶段一(满仓): ROI≥5% 平初始量的30%。
   - 阶段二(余~70%): ROI≥8% 平初始量的30% + 移动止损至成本价。
   - 阶段三(余~40%): ROI≥12% 平初始量的20%。
   - 阶段四(余~20%): 尾仓设置动态追踪止损，从高点回撤5%ROI即清仓。

**策略规则**:
1. **1H 趋势**:  ${trend1H.direction}
2. **3m 入场**: ${entry3m.structure}
3. **资金**: 10% 权益。
4. **开仓止损**: 3m 趋势下前一个反向交叉区间的极值。

**当前状态**:
- 1H: ${trend1H.description}
- 3m: ${entry3m.structure}
- 信号: ${entry3m.signal ? "触发开仓" : entry3m.reason}
- 持仓: ${posAnalysis}
- 建议动作: ${finalAction} ${finalSize !== "0" ? `(数量: ${finalSize})` : ""}

**输出要求**:
1. 返回格式必须为 JSON。
2. **market_assessment**: 包含【1H趋势】和【3m入场】的中文描述。
3. **reasoning**: 解释阶段判断逻辑，明确当前所属的止盈阶段。
4. 根据 "建议动作" 生成最终 JSON。
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
            
            // SANITIZATION: Ensure fields are strings to prevent React rendering crashes
            const ensureString = (val: any) => {
                if (typeof val === 'string') return val;
                if (typeof val === 'object') return JSON.stringify(val);
                return String(val || '');
            };

            if(aiJson.market_assessment) decision.market_assessment = ensureString(aiJson.market_assessment);
            // Force disable hot events overwrite
            decision.hot_events_overview = "策略配置已禁用热点分析";
            if(aiJson.coin_analysis) decision.coin_analysis = ensureString(aiJson.coin_analysis);
            if(aiJson.reasoning) {
                 const reasoningStr = ensureString(aiJson.reasoning);
                 decision.reasoning = `${decision.reasoning} | AI视角: ${reasoningStr}`;
            }

        } catch (e) {
            console.warn(`[${coinKey}] AI JSON parse failed, using local logic.`);
        }

        // --- SIZE CALCULATION (Strict Balance Check Logic) ---
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            
            let contracts = 0;
            const leverage = parseFloat(DEFAULT_LEVERAGE); 
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
                
                if (!isClose) {
                    // STRICT BALANCE CHECK FOR OPENING
                    // 1. Calculate ideal contract size based on Strategy
                    contracts = Math.floor(strategyAmountU / marginPerContract);
                    const costForIdeal = contracts * marginPerContract;

                    // 2. Check if we can afford the ideal size
                    if (availEquity >= costForIdeal) {
                        // We can afford it, proceed with calculated contracts
                        // If calculated contracts < MIN_SZ, that's a strategy constraint, handled below
                    } else {
                        // We cannot afford ideal size, scale down to max affordable
                        contracts = Math.floor(availEquity / marginPerContract);
                    }
                } else {
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
                     const held = hasPosition ? parseFloat(primaryPosition!.pos) : 0;
                     if (held >= MIN_SZ) {
                         contracts = MIN_SZ; 
                         decision.reasoning += ` [止盈] 计算量小于最小单位，强制执行最小单位平仓`;
                     } else {
                         contracts = Math.floor(held); // Close dust
                     }
                } else {
                    // For OPEN:
                    // Check if we can afford MIN_SZ
                    const costForMin = marginPerContract * MIN_SZ;
                    
                    if (availEquity >= costForMin) {
                        contracts = MIN_SZ;
                        decision.reasoning += ` [保底交易] 策略仓位不足最小单位，强制最小开仓`;
                    } else {
                        decision.action = 'HOLD';
                        decision.size = "0";
                        decision.reasoning += ` [资金不足] 需${costForMin.toFixed(2)}U, 余额${availEquity.toFixed(2)}U`;
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
    accountData: AccountContext,
    logs: SystemLog[]
): Promise<AIDecision[]> => {
    // Disabled News Fetching to save tokens
    // const newsContext = await fetchRealTimeNews();

    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, logs);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
