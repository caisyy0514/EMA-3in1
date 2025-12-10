

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

// --- News Fetcher (Internet Search Capability) ---
const fetchRealTimeNews = async (): Promise<string> => {
    try {
        // Limit increased to 5 for better context
        const url = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest&limit=5";
        const res = await fetch(url);
        if (!res.ok) return "暂无法连接互联网新闻源";
        
        const json = await res.json();
        if (json.Data && Array.isArray(json.Data)) {
            const items = json.Data.slice(0, 5).map((item: any) => {
                const time = new Date(item.published_on * 1000).toLocaleTimeString();
                return `- [${time}] ${item.title}`;
            });
            return items.join("\n");
        }
        return "扫描未发现即时重大新闻";
    } catch (e) {
        return "实时搜索暂时不可用 (API Connection Error)";
    }
};

// --- Strategy Logic: EMA Trend Tracking ---

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
    
    // Logic 1: EMA Relationship (Dominant Trend)
    // If EMA15 > EMA60, it is an UPTREND structurally
    
    const isGold = ema15 > ema60;
    const isDeath = ema15 < ema60;
    
    // Logic 2: Candle Color (Strength Indicator)
    const close = parseFloat(latest.c);
    const open = parseFloat(latest.o);
    const isYang = close > open; 
    const isYin = close < open;
    
    if (isGold) {
        const strength = isYang ? "强势" : "回调中";
        return { 
            direction: 'UP', 
            timestamp: parseInt(latest.ts), 
            description: `上涨 (${strength} / EMA金叉)`
        };
    }
    
    if (isDeath) {
        const strength = isYin ? "强势" : "反弹中";
        return { 
            direction: 'DOWN', 
            timestamp: parseInt(latest.ts),
            description: `下跌 (${strength} / EMA死叉)`
        };
    }
    
    return { direction: 'NEUTRAL', timestamp: parseInt(latest.ts), description: "均线粘合/震荡" };
}

function analyze3mEntry(candles: CandleData[], trendDirection: string) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "数据不足", structure: "未知" };
    
    const i = candles.length - 1; // Latest completed candle
    const curr = candles[i] as any;
    
    if (!curr.ema15 || !curr.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "未知" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉多头区域" : "死叉空头区域";
    const LOOKBACK_WINDOW = 5; // Scan last 5 candles for signal (approx 15 mins)

    // Long Logic: Trend UP -> Find Death Cross -> Then Gold Cross
    if (trendDirection === 'UP') {
        // Must be in Gold structure currently to consider buying
        if (!currentGold) {
             return { signal: false, action: 'HOLD', sl: 0, reason: "1H上涨，但3m当前处于死叉区域", structure };
        }

        // Look back for the crossover event within the window
        for (let k = 0; k < LOOKBACK_WINDOW; k++) {
            const idx = i - k;
            if (idx < 1) break;
            
            const c = candles[idx] as any;
            const p = candles[idx-1] as any;
            
            // Check for crossover at this candle: EMA15 crossed UP EMA60
            const crossedUp = c.ema15 > c.ema60 && p.ema15 <= p.ema60;
            
            if (crossedUp) {
                let foundDeathZone = false;
                let lowestInDeathZone = parseFloat(c.l); // Start tracking SL from crossover candle
                
                // Scan backwards from p (idx-1) to validate Death Zone
                for (let x = idx - 1; x >= 0; x--) {
                    const prevC = candles[x] as any;
                    if (prevC.ema15 < prevC.ema60) {
                        foundDeathZone = true;
                        const low = parseFloat(prevC.l);
                        if (low < lowestInDeathZone) lowestInDeathZone = low;
                    } else {
                        // Found a gold cross before death zone, stop scanning
                        if (foundDeathZone) break;
                    }
                }
                
                // If we found a death zone, this signal is valid
                if (foundDeathZone) {
                    return { 
                        signal: true, 
                        action: 'BUY', 
                        sl: lowestInDeathZone, 
                        reason: `1H上涨 + 3m死叉后金叉 (处于有效入场窗口, 发生于${k}根K线前)`,
                        structure
                    };
                }
            }
        }
    }
    
    // Short Logic: Trend DOWN -> Find Gold Cross -> Then Death Cross
    if (trendDirection === 'DOWN') {
        // Must be in Death structure currently to consider selling
        if (currentGold) {
             return { signal: false, action: 'HOLD', sl: 0, reason: "1H下跌，但3m当前处于金叉区域", structure };
        }

        for (let k = 0; k < LOOKBACK_WINDOW; k++) {
            const idx = i - k;
            if (idx < 1) break;
            
            const c = candles[idx] as any;
            const p = candles[idx-1] as any;
            
            // Check for crossover at this candle: EMA15 crossed DOWN EMA60
            const crossedDown = c.ema15 < c.ema60 && p.ema15 >= p.ema60;
            
            if (crossedDown) {
                let foundGoldZone = false;
                let highestInGoldZone = parseFloat(c.h);
                
                for (let x = idx - 1; x >= 0; x--) {
                    const prevC = candles[x] as any;
                    if (prevC.ema15 > prevC.ema60) {
                        foundGoldZone = true;
                        const high = parseFloat(prevC.h);
                        if (high > highestInGoldZone) highestInGoldZone = high;
                    } else {
                        if (foundGoldZone) break;
                    }
                }
                
                if (foundGoldZone) {
                    return { 
                        signal: true, 
                        action: 'SELL', 
                        sl: highestInGoldZone, 
                        reason: `1H下跌 + 3m金叉后死叉 (处于有效入场窗口, 发生于${k}根K线前)`,
                        structure
                    };
                }
            }
        }
    }
    
    if (trendDirection === 'UP') return { signal: false, action: 'HOLD', sl: 0, reason: "1H上涨中，等待3m回调信号", structure };
    if (trendDirection === 'DOWN') return { signal: false, action: 'HOLD', sl: 0, reason: "1H下跌中，等待3m反弹信号", structure };

    return { signal: false, action: 'HOLD', sl: 0, reason: "1H趋势不明确，暂无入场", structure };
}

// --- Single Coin Analysis ---
// Returns AIDecision for a specific coin
const analyzeCoin = async (
    coinKey: string,
    apiKey: string,
    marketData: SingleMarketData,
    accountData: AccountContext,
    newsContext: string
): Promise<AIDecision> => {
    
    const config = COIN_CONFIG[coinKey];
    if (!config) throw new Error(`Unknown coin: ${coinKey}`);
    
    const TICK_SIZE = config.tickSize;
    const CONTRACT_VAL = config.contractVal;
    const INST_ID = config.instId;
    const MIN_SZ = config.minSz || 1; 

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
    let invalidationReason = "";
    
    // --- Decision Logic ---
    if (hasPosition) {
        const p = primaryPosition!;
        const posSize = parseFloat(p.pos);
        const upl = parseFloat(p.upl);
        const isLong = p.posSide === 'long';
        const entryPx = parseFloat(p.avgPx);
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, 浮盈: ${upl} U`;

        // 1. Check Trend Reversal (Immediate Close)
        if (trend1H.direction === 'UP' && !isLong) finalAction = "CLOSE";
        else if (trend1H.direction === 'DOWN' && isLong) finalAction = "CLOSE";
        
        // 2. Rolling (Pyramiding)
        if (finalAction === "HOLD") {
            const profitThreshold = totalEquity * 0.05;
            if (upl >= profitThreshold) {
                finalAction = isLong ? "BUY" : "SELL";
                finalSize = "5%"; 
                invalidationReason = "Rolling: Profit > 5%";
            }
        }
        
        // 3. Trailing SL Logic (Structure Based - Interval Extremes)
        if (finalAction === "HOLD" || finalAction.includes("BUY") || finalAction.includes("SELL")) {
            let currentSL = parseFloat(p.slTriggerPx || "0");
            let newSL = currentSL;
            let shouldUpdate = false;
            
            // Use 3m candles for structure analysis
            const candles = marketData.candles3m;

            if (isLong) {
                // LONG Logic:
                // Move SL UP if we find a *new* Death Cross interval (dip) whose lowest point is higher than current SL.
                
                let lowestInZone = Infinity;
                let foundZone = false;
                let inZone = false;
                
                // Scan backwards from latest completed candle
                for (let i = candles.length - 1; i >= 0; i--) {
                    const c = candles[i] as any;
                    if (!c.ema15 || !c.ema60) continue;
                    
                    const isDeath = c.ema15 < c.ema60;
                    
                    if (isDeath) {
                        inZone = true;
                        const l = parseFloat(c.l);
                        if (l < lowestInZone) lowestInZone = l;
                    } else {
                        // We are in Gold (or neutral)
                        if (inZone) {
                            // We were in a Death Zone, now we are out (moving backwards).
                            // This means we found the most recent completed Death Zone interval.
                            foundZone = true;
                            break; 
                        }
                    }
                }
                
                if (foundZone && lowestInZone !== Infinity) {
                    const proposedSL = lowestInZone - TICK_SIZE; // Use exact low minus 1 tick
                    
                    // Ratchet Rule: Only move SL UP.
                    // If Proposed SL > Current SL, update.
                    if ((currentSL === 0 || proposedSL > currentSL) && proposedSL < currentPrice) {
                        newSL = proposedSL;
                        shouldUpdate = true;
                    }
                }

            } else {
                // SHORT Logic:
                // Move SL DOWN if we find a *new* Gold Cross interval (rally) whose highest point is lower than current SL.
                
                let highestInZone = -Infinity;
                let foundZone = false;
                let inZone = false;
                
                for (let i = candles.length - 1; i >= 0; i--) {
                    const c = candles[i] as any;
                    if (!c.ema15 || !c.ema60) continue;
                    
                    const isGold = c.ema15 > c.ema60;
                    
                    if (isGold) {
                        inZone = true;
                        const h = parseFloat(c.h);
                        if (h > highestInZone) highestInZone = h;
                    } else {
                        if (inZone) {
                            foundZone = true;
                            break;
                        }
                    }
                }
                
                if (foundZone && highestInZone !== -Infinity) {
                    const proposedSL = highestInZone + TICK_SIZE; // Use exact high plus 1 tick
                    
                    // Ratchet Rule: Only move SL DOWN.
                    // If Proposed SL < Current SL, update.
                    if ((currentSL === 0 || proposedSL < currentSL) && proposedSL > currentPrice) {
                        newSL = proposedSL;
                        shouldUpdate = true;
                    }
                }
            }

            // Apply Update
            if (shouldUpdate) {
                if (finalAction === "HOLD") {
                    finalAction = "UPDATE_TPSL";
                }
                finalSL = newSL.toFixed(config.tickSize < 0.01 ? 4 : 2);
            }
        }

    } else {
        // No Position: Check Entry
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "5%"; // Initial Size
            finalSL = entry3m.sl.toFixed(config.tickSize < 0.01 ? 4 : 2);
        }
    }

    // --- Prompt Construction ---
    const systemPrompt = `
你是一个严格执行 **${coinKey} EMA 趋势追踪策略** 的交易机器人。
**严禁** 使用任何其他指标（RSI, MACD, KDJ 等），只关注 EMA15 和 EMA60。
当前时间: ${new Date().toLocaleString()}

**当前市场状态**:
- 1H 趋势 (趋势判断): ${trend1H.direction} (自 ${new Date(trend1H.timestamp).toLocaleTimeString()})
- 3m 信号 (入场时机): ${entry3m.signal ? "TRIGGERED" : "WAITING"}
- 3m 信号详情: ${entry3m.reason}
- 计算止损位 (SL): ${entry3m.sl}

**持仓状态**:
${posAnalysis}

**策略规则 (Strategy Rules)**:
1.1H 趋势 (趋势判断): ${trend1H.direction} (自 ${new Date(trend1H.timestamp).toLocaleTimeString()})   
   - 只要EMA15 > EMA60 且 K线阳线即为UP。
   - 只要EMA15 < EMA60 且 K线阴线即为DOWN
2. **入场逻辑 (3m)**: 
   - 必须在 1H 趋势方向上操作。
   - 看涨时: 等待 3m 图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。在金叉形成的 K 线收盘后买入。
   - 看跌时: 等待 3m 图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。在死叉形成的 K 线收盘后卖出。
   - **执行指令**: 如果 "3m 信号" 显示 "TRIGGERED"，说明满足条件，**必须**输出 ACTION 为 BUY 或 SELL，不要因为"错过最佳点"而观望。只要信号触发，就是有效。
3. **资金管理 (Rolling)**:
   - 首仓 5% 可用余额（Available Equity）。
   - 每盈利 5% 加仓 5%。
4. **止损管理 (智能移动 - 结构化)**:
   - **核心原则**: 止损位仅根据3m趋势的市场结构（交叉区间极值）向有利方向移动，锁定利润。
   - **做多持仓**:
     - 初始止损：入场前3m趋势[死叉区间]最低点。
     - 移动规则：若3m趋势出现**新**的[死叉区间]（价格回调导致EMA15<60），且该区间最低点 > 当前止损，则将止损**上移**至该新低点。否则保持不变。
   - **做空持仓**:
     - 初始止损：入场前3m趋势[金叉区间]最高点。
     - 移动规则：若3m趋势出现**新**的[金叉区间]（价格反弹导致EMA15>60），且该区间最高点 < 当前止损，则将止损**下移**至该新高点。否则保持不变。
5. **反转离场**:
   - 如果 1H 趋势反转 (与持仓方向相反)，立即平仓。

**执行规则**:
- 只有当 1H 趋势明确(UP/DOWN) 且 3m 出现特定交叉形态(死后金/金后死)才开仓。
- 首仓 5% 可用余额（Available Equity）。
- 盈利 > 5% 权益时滚仓加码 5%。
- 趋势反转立即平仓。
- 如果有持仓 且 需要移动止损 -> UPDATE_TPSL (Set new SL).
- 默认杠杆固定为 ${DEFAULT_LEVERAGE}x。

**输出要求**:
1. 返回格式必须为 JSON。
2. **重要**: 所有文本分析字段（stage_analysis, market_assessment, hot_events_overview, eth_analysis, reasoning, invalidation_condition）必须使用 **中文 (Simplified Chinese)** 输出。
3. **hot_events_overview** 字段：请仔细阅读提供的 News 英文数据，将其翻译并提炼为简练的中文市场热点摘要。
4. **market_assessment** 字段：必须明确包含以下两行结论：
   - 【1H趋势】：${trend1H.description} 明确指出当前1小时级别EMA15和EMA60的关系（ [金叉 EMA15>60] 或 [死叉 EMA15<60]）是上涨还是下跌。
   - 【3m入场】：：${entry3m.structure} - ${entry3m.signal ? "满足入场" : "等待机会"}明确指出当前3分钟级别是否满足策略定义的入场条件，并说明原因。

请基于上述计算结果生成 JSON 决策。
`;

    try {
        const text = await callDeepSeek(apiKey, [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Account: ${totalEquity} USDT. Coin: ${coinKey}. News Data: ${newsContext}` }
        ]);

        const tDirection = trend1H.description;
        const tEntry = `${entry3m.structure} - ${entry3m.signal ? "满足入场" : entry3m.reason}`;

        let decision: AIDecision = {
            coin: coinKey,
            instId: INST_ID,
            stage_analysis: "EMA趋势追踪",
            market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
            hot_events_overview: "正在分析热点...",
            coin_analysis: `EMA15/60 状态分析。趋势: ${tDirection}`,
            trading_decision: {
                action: finalAction as any,
                confidence: "100%", 
                position_size: finalSize,
                leverage: DEFAULT_LEVERAGE, 
                profit_target: "",
                stop_loss: finalSL,
                invalidation_condition: "Trend Reversal"
            },
            reasoning: `基于EMA15/60严格策略逻辑。1H趋势为${tDirection}。3m信号状态：${tEntry}。`,
            action: finalAction as any,
            size: "0",
            leverage: DEFAULT_LEVERAGE
        };

        try {
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const aiJson = JSON.parse(cleanText);
            
            if(aiJson.stage_analysis) decision.stage_analysis = aiJson.stage_analysis;
            if(aiJson.market_assessment) decision.market_assessment = aiJson.market_assessment;
            if(aiJson.hot_events_overview) decision.hot_events_overview = aiJson.hot_events_overview;
            if(aiJson.eth_analysis) decision.coin_analysis = aiJson.eth_analysis; // Handle legacy field name
            if(aiJson.coin_analysis) decision.coin_analysis = aiJson.coin_analysis;
            if(aiJson.reasoning) decision.reasoning = aiJson.reasoning;
            if(aiJson.trading_decision?.invalidation_condition) {
                 decision.trading_decision.invalidation_condition = aiJson.trading_decision.invalidation_condition;
            }

        } catch (e) {
            console.warn(`[${coinKey}] AI Response JSON parse failed, using defaults.`);
        }

        // Calc precise size for "5%"
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            // Strategy desired amount: 5% of Total Equity
            const strategyAmountU = totalEquity * 0.05;
            
            // Safety constraint: 90% of Available Equity (Leave 10% for fees/buffer/volatility)
            // Increased safety margin to prevent 51008 errors especially on volatile assets like DOGE
            const maxAffordableU = availEquity * 0.90;

            // Use the smaller of the two as the basis for calculation
            let targetAmountU = Math.min(strategyAmountU, maxAffordableU);

             // Minimum Margin Threshold Check (0.5 USDT)
             if (targetAmountU < 0.5) {
                 decision.action = 'HOLD';
                 decision.size = "0";
                 decision.reasoning += ` [资金不足: 可用余额低于安全下单阈值 (0.5U)]`;
            } else {
                const leverage = parseFloat(DEFAULT_LEVERAGE); 
                // Cost per contract (Margin required) = (ContractVal * Price) / Leverage
                const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;

                // Calculate contracts - Updated to allow fractions (0.01) based on MIN_SZ
                let contracts = targetAmountU / marginPerContract;
                
                // Truncate to 2 decimal places to avoid float issues, supporting 0.01 precision
                contracts = Math.floor(contracts * 100) / 100;

                // Enforce Minimum Size Rule
                if (contracts < MIN_SZ) {
                    // Check if we can afford the minimum size with maxAffordableU
                    const minMarginNeeded = marginPerContract * MIN_SZ;

                    if (maxAffordableU >= minMarginNeeded) {
                         contracts = MIN_SZ;
                         decision.reasoning += ` [资金微调: 策略仓位(${ (targetAmountU/marginPerContract).toFixed(3) })小于最小限制(${MIN_SZ})，强制执行最小单位]`;
                    } else {
                         decision.action = 'HOLD';
                         decision.size = "0";
                         decision.reasoning += ` [资金不足: 余额(${availEquity.toFixed(2)})不足以支付最小${MIN_SZ}张合约保证金(${ minMarginNeeded.toFixed(2) })]`;
                    }
                }
                
                if (decision.action !== 'HOLD') {
                     // Pass formatted string (2 decimals max)
                     decision.size = contracts.toString(); 
                     
                     if (targetAmountU < strategyAmountU && contracts > MIN_SZ) {
                          decision.reasoning += ` [资金管控: 因余额限制，仓位已调整]`;
                     }
                }
            }
        }

        return decision;

    } catch (error: any) {
        console.error(`Strategy Error for ${coinKey}:`, error);
        return {
            coin: coinKey,
            instId: INST_ID,
            stage_analysis: "策略执行错误",
            market_assessment: "无法评估",
            hot_events_overview: "数据获取失败",
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
    // 1. Fetch News (Global Context)
    const newsContext = await fetchRealTimeNews();

    // 2. Analyze Each Coin in Parallel
    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        // Check if we have data for this coin
        if (!marketData[coinKey]) return null;
        
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, newsContext);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
