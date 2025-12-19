
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

        // === 2. EXCHANGE ENTRUSTMENT MONITORING ===
        // 止盈动作不再由AI触发，而是开仓时已托管给交易所。
        // AI仅负责：1. 检测阶段二达标时，移动止损到成本价(保护剩余仓位)。2. 日志记录。
        
        if (finalAction === 'HOLD') {
            
            // --- STAGE LOGGING ---
            const hitStages: string[] = [];
            if (netRoi >= 0.05) hitStages.push("一(5%)");
            if (netRoi >= 0.078) hitStages.push("二(8% 触发缓冲)"); // ROI 判定缓冲 0.078
            if (netRoi >= 0.12) hitStages.push("三(12%)");

            if (hitStages.length > 0) {
                 invalidationReason = `[托管运行中] 已达标阶段: ${hitStages.join(', ')}。止盈单由交易所自动执行。`;
            }

            // --- STAGE 2 MAINTENANCE: BREAK EVEN PROTECTION ---
            // Rule: If Stage 2 passed (ROI >= 7.8%), Check Break Even
            // 交易所止盈单只负责减仓，不负责改剩余仓位的止损，所以这里必须由AI执行。
            if (netRoi >= 0.078) {
                const currentSL = parseFloat(p.slTriggerPx || "0");
                const feeBuffer = avgEntry * 0.002;
                
                // bePrice 精度严格归一化
                let bePrice = isLong ? avgEntry + feeBuffer : avgEntry - feeBuffer;
                bePrice = parseFloat(bePrice.toFixed(decimals)); 
                
                const isSecured = isLong ? (currentSL >= bePrice) : (currentSL > 0 && currentSL <= bePrice);
                
                if (!isSecured) {
                    finalAction = "UPDATE_TPSL";
                    finalSL = bePrice.toFixed(decimals);
                    invalidationReason = `[阶段二风控] 净ROI达标，调整止损至成本价(${finalSL})`;
                }
            }
            
            // --- STAGE 4 MONITORING ---
            // 尾仓追踪止损已在开仓时设置(Move Order Stop)，无需AI操作。
            if (netRoi >= 0.12) {
                 invalidationReason += ` [尾仓追踪激活] ROI>12%，交易所移动止盈单已激活。`;
            }
        }

    } else {
        // --- NO POSITION: ENTRY LOGIC ---
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "15%"; 
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
2. **多阶段止盈 (交易所托管)**: 阶段二(ROI≥8%)时，AI需负责将剩余仓位止损移动至成本价；开仓后立即下达止盈委托。

**策略规则**:
1. **1H 趋势**:  ${trend1H.direction}
2. **3m 入场**: ${entry3m.structure}
3. **资金**: 15% 权益。
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
3. **reasoning**: 解释阶段判断逻辑。
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
            stage_analysis: "EMA严格趋势策略 (交易所全托管版)",
            market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
            hot_events_overview: "策略配置已禁用热点分析", 
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
            const ensureString = (val: any) => (typeof val === 'string' ? val : String(val || ''));
            if(aiJson.market_assessment) decision.market_assessment = ensureString(aiJson.market_assessment);
            decision.hot_events_overview = "策略配置已禁用热点分析";
            if(aiJson.coin_analysis) decision.coin_analysis = ensureString(aiJson.coin_analysis);
            if(aiJson.reasoning) decision.reasoning = `${decision.reasoning} | AI视角: ${ensureString(aiJson.reasoning)}`;
        } catch (e) {
            console.warn(`[${coinKey}] AI JSON parse failed.`);
        }

        // --- SIZE CALCULATION (Strict Balance Check) ---
        // 修正：UPDATE_TPSL 指令不需要进行 size 校验
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            
            let contracts = 0;
            const leverage = parseFloat(DEFAULT_LEVERAGE); 
            const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;
            const minMarginRequired = marginPerContract * MIN_SZ;

            let isClose = false;
            if (hasPosition) {
                const p = primaryPosition!;
                if (p.posSide === 'long' && finalAction === 'SELL') isClose = true;
                if (p.posSide === 'short' && finalAction === 'BUY') isClose = true;
            }

            let calcDetails = "";

            if (!isClose) {
                let targetContracts = 0;
                let rawContracts = 0;
                
                if (finalSize.includes('%')) {
                    const pct = parseFloat(finalSize) / 100; 
                    const strategyMarginAlloc = totalEquity * pct;
                    rawContracts = strategyMarginAlloc / marginPerContract;
                } else {
                    rawContracts = parseFloat(finalSize);
                }

                let targetContractsFormatted = Math.floor(rawContracts / MIN_SZ) * MIN_SZ;
                const precision = MIN_SZ.toString().split('.')[1]?.length || 0;
                targetContracts = parseFloat(targetContractsFormatted.toFixed(precision));

                const targetMargin = targetContracts * marginPerContract;
                const openValUSDT = targetContracts * CONTRACT_VAL * currentPrice;
                calcDetails = `[测算] 目标: ${targetContracts}张 (价值${openValUSDT.toFixed(1)}U), 需保证金: ${targetMargin.toFixed(2)}U, 可用: ${availEquity.toFixed(2)}U`;

                if (availEquity >= targetMargin && targetContracts >= MIN_SZ) {
                    contracts = targetContracts;
                    calcDetails += ` -> 资金充足`;
                } else {
                    if (availEquity >= minMarginRequired) {
                         contracts = MIN_SZ;
                         calcDetails += ` -> 保底执行最小开仓`;
                    } else {
                         contracts = 0;
                         decision.action = 'HOLD';
                         calcDetails += ` -> 保证金不足最小单位`;
                    }
                }
            } else {
                let rawContracts = parseFloat(finalSize);
                let targetContractsFormatted = Math.floor(rawContracts / MIN_SZ) * MIN_SZ;
                const precision = MIN_SZ.toString().split('.')[1]?.length || 0;
                contracts = parseFloat(targetContractsFormatted.toFixed(precision));
                const held = hasPosition ? parseFloat(primaryPosition!.pos) : 0;
                if (contracts < MIN_SZ) {
                    if (held < MIN_SZ) contracts = held;
                    else if (contracts > 0) contracts = MIN_SZ;
                }
                if (contracts > held) contracts = held;
                contracts = parseFloat(contracts.toFixed(precision));
                calcDetails = `[平仓] 计划: ${contracts}张, 持仓: ${held}张`;
            }

            if (contracts > 0 && decision.action !== 'HOLD') {
                decision.size = contracts.toString();
                decision.reasoning += ` || ${calcDetails}`;
                if (decision.trading_decision) decision.trading_decision.position_size = contracts.toString();
            } else if (decision.action !== 'HOLD' && !isClose) {
                decision.action = 'HOLD';
                decision.reasoning += ` || ${calcDetails}`;
            }
        } else if (finalAction === 'UPDATE_TPSL') {
            // 指令已就绪，保持 decision.action 为 UPDATE_TPSL，不需要 size 校验
            decision.size = "0";
        }

        return decision;

    } catch (error: any) {
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
    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, logs);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
