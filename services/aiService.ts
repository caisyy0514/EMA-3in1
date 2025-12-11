
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
        if (!currentGold) {
             return { signal: false, action: 'HOLD', sl: 0, reason: "1H上涨，但3m当前处于死叉区域", structure };
        }

        // Look back for the crossover event within the window
        for (let k = 0; k < LOOKBACK_WINDOW; k++) {
            const idx = i - k;
            if (idx < 1) break;
            
            const c = candles[idx] as any;
            const p = candles[idx-1] as any;
            
            // EMA15 crossed UP EMA60
            const crossedUp = c.ema15 > c.ema60 && p.ema15 <= p.ema60;
            
            if (crossedUp) {
                // Determine Initial SL: Lowest point of the PRIOR Death Interval
                let lowestInPriorDeathZone = Infinity;
                let foundDeathZone = false;
                
                // Scan backwards from the crossover point (idx-1)
                for (let x = idx - 1; x >= 0; x--) {
                    const prevC = candles[x] as any;
                    if (prevC.ema15 < prevC.ema60) {
                        foundDeathZone = true;
                        const low = parseFloat(prevC.l);
                        if (low < lowestInPriorDeathZone) lowestInPriorDeathZone = low;
                    } else {
                        // We found a Gold cross BEFORE the Death zone -> Death zone ended (going backwards)
                        if (foundDeathZone) break;
                    }
                }
                
                if (foundDeathZone && lowestInPriorDeathZone !== Infinity) {
                    return { 
                        signal: true, 
                        action: 'BUY', 
                        sl: lowestInPriorDeathZone, 
                        reason: `1H上涨 + 3m死叉后金叉 (有效入场)`,
                        structure
                    };
                }
            }
        }
    }
    
    // Short Logic: Trend DOWN -> Find Gold Cross -> Then Death Cross
    if (trendDirection === 'DOWN') {
        if (currentGold) {
             return { signal: false, action: 'HOLD', sl: 0, reason: "1H下跌，但3m当前处于金叉区域", structure };
        }

        for (let k = 0; k < LOOKBACK_WINDOW; k++) {
            const idx = i - k;
            if (idx < 1) break;
            
            const c = candles[idx] as any;
            const p = candles[idx-1] as any;
            
            // EMA15 crossed DOWN EMA60
            const crossedDown = c.ema15 < c.ema60 && p.ema15 >= p.ema60;
            
            if (crossedDown) {
                // Determine Initial SL: Highest point of the PRIOR Gold Interval
                let highestInPriorGoldZone = -Infinity;
                let foundGoldZone = false;
                
                for (let x = idx - 1; x >= 0; x--) {
                    const prevC = candles[x] as any;
                    if (prevC.ema15 > prevC.ema60) {
                        foundGoldZone = true;
                        const high = parseFloat(prevC.h);
                        if (high > highestInPriorGoldZone) highestInPriorGoldZone = high;
                    } else {
                        if (foundGoldZone) break;
                    }
                }
                
                if (foundGoldZone && highestInPriorGoldZone !== -Infinity) {
                    return { 
                        signal: true, 
                        action: 'SELL', 
                        sl: highestInPriorGoldZone, 
                        reason: `1H下跌 + 3m金叉后死叉 (有效入场)`,
                        structure
                    };
                }
            }
        }
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "无有效交叉信号", structure };
}

// --- Single Coin Analysis ---
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
    const MIN_SZ = config.minSz || 0.01;

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
        const avgEntry = parseFloat(p.avgPx);
        const upl = parseFloat(p.upl);
        const isLong = p.posSide === 'long';
        
        // Calculate ROI based on Price vs Entry (More accurate than UPL ratio for logic)
        // ROI = (Price - Entry) / Entry * Leverage (approx)
        // Or simpler: ROI = (Price - Entry) / Entry for un-leveraged change
        // Prompt asks for "Accumulated Profit" thresholds. UPL Ratio is usually suitable.
        // Let's use UPL Ratio provided by API or recalculate for safety.
        // uplRatio is usually "upl / margin".
        
        const uplRatio = parseFloat(p.uplRatio); // e.g. 0.05 = 5%
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, ROI: ${(uplRatio * 100).toFixed(2)}%`;

        // === 1. PASSIVE TAKE PROFIT / INVALIDATION (Trend Reversal) ===
        // If 1H Trend flips against position -> CLOSE ALL immediately
        let trendReversal = false;
        if (isLong && trend1H.direction === 'DOWN') trendReversal = true;
        if (!isLong && trend1H.direction === 'UP') trendReversal = true;

        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `[被动止盈] 1H趋势反转 (${trend1H.direction})`;
        }

        // === 2. EMERGENCY TAKE PROFIT (Volatility) ===
        // 3m Candle Volatility > 10%
        if (finalAction === 'HOLD') {
            const latest3m = marketData.candles3m[marketData.candles3m.length - 1];
            const high = parseFloat(latest3m.h);
            const low = parseFloat(latest3m.l);
            const open = parseFloat(latest3m.o);
            const volPct = (high - low) / open;
            
            if (volPct >= 0.10) {
                finalAction = "CLOSE";
                invalidationReason = `[紧急止盈] 3mK线极端波动 ${(volPct*100).toFixed(1)}%`;
            }
        }

        // === 3. ACTIVE TAKE PROFIT (Layered) ===
        // Only if trend is still valid
        if (finalAction === 'HOLD') {
            
            // Level 3: Profit >= 15% -> CLOSE ALL
            if (uplRatio >= 0.15) {
                finalAction = "CLOSE";
                invalidationReason = `[主动止盈 L3] 收益达标 ${(uplRatio*100).toFixed(1)}% (>15%)`;
            }
            // Level 2: Profit >= 10% -> CLOSE PARTIAL (Add 30%) + TIGHTEN SL
            // To prevent infinite loop closing, we use a window [10%, 13%]
            else if (uplRatio >= 0.10) {
                 // Trigger Partial Close if we are in the activation window
                 if (uplRatio < 0.13) {
                     // Approximate logic: Sell ~30% of original. 
                     // Assuming we already sold 50% at L1, we have 50% left. 30% of original is 60% of current.
                     // Let's just sell 50% of current for simplicity and safety.
                     finalAction = isLong ? "SELL" : "BUY"; // Reduce pos
                     finalSize = (posSize * 0.5).toFixed(2); // Close half of current
                     invalidationReason = `[主动止盈 L2] 收益 ${(uplRatio*100).toFixed(1)}% -> 减仓并收紧止损`;
                 }
                 
                 // Regardless of closing, we MUST tighten SL to 50% Profit Level
                 // 50% Profit Level = Entry + (Current - Entry) * 0.5
                 const profitDiff = Math.abs(currentPrice - avgEntry);
                 const halfProfitPrice = isLong 
                    ? avgEntry + (profitDiff * 0.5)
                    : avgEntry - (profitDiff * 0.5);
                 
                 // We will handle SL update in Step 4, overriding if better
                 finalSL = halfProfitPrice.toFixed(config.tickSize < 0.01 ? 4 : 2);
            }
            // Level 1: Profit >= 5% -> CLOSE PARTIAL (50%)
            // Window [5%, 8%]
            else if (uplRatio >= 0.05) {
                if (uplRatio < 0.08) {
                    finalAction = isLong ? "SELL" : "BUY";
                    finalSize = (posSize * 0.5).toFixed(2); // Close 50%
                    invalidationReason = `[主动止盈 L1] 收益 ${(uplRatio*100).toFixed(1)}% -> 锁定半仓利润`;
                }
            }
        }

        // === 4. TRAILING STOP LOSS (Ratchet) ===
        // Only if we are HOLDing or updating SL (not closing fully)
        if (finalAction === "HOLD" || finalAction === "UPDATE_TPSL" || (finalAction !== "CLOSE" && invalidationReason.includes("止盈"))) {
            let currentSL = parseFloat(p.slTriggerPx || "0");
            let structuralSL = currentSL; // Default to keeping current
            let shouldUpdate = false;
            
            const candles = marketData.candles3m;

            if (isLong) {
                // Rule: New Death Interval (EMA15 < 60) -> Lowest Point
                // Scan for the *most recent completed* Death Interval
                let lowestInZone = Infinity;
                let foundZone = false;
                let currentlyInDeath = candles[candles.length-1].ema15! < candles[candles.length-1].ema60!;
                
                // If currently in death, the interval is not complete, but the prompt says "appears new death interval".
                // Usually ratchet SL implies waiting for the "Swing Low" which is confirmed when trend resumes (Gold cross).
                // However, to be safe and responsive:
                // We will look for the *last confirmed* swing low (Completed Death Zone).
                
                for (let i = candles.length - 2; i >= 0; i--) {
                    const c = candles[i] as any;
                    const prev = candles[i-1] as any; // safety check
                    if (!prev) break;

                    const isDeath = c.ema15 < c.ema60;
                    
                    if (isDeath) {
                         // We are in a death zone
                         const l = parseFloat(c.l);
                         if (l < lowestInZone) lowestInZone = l;
                         foundZone = true;
                    } else {
                        // We are in Gold zone
                        if (foundZone) {
                            // We just exited a death zone (moving backwards)
                            // So we found the most recent COMPLETED death zone.
                            break; 
                        }
                    }
                }

                if (foundZone && lowestInZone !== Infinity) {
                    // Ratchet: Only move UP
                    // Also check if we have a calculated TP SL (from Level 2 logic above)
                    // We take the HIGHER of the two for Long (tighter stop)
                    
                    const proposedStructuralSL = lowestInZone - TICK_SIZE; 
                    
                    // Logic: Structural SL must be > Current SL to update
                    if (currentSL === 0 || proposedStructuralSL > currentSL) {
                        structuralSL = proposedStructuralSL;
                        shouldUpdate = true;
                    }
                }
                
                // Merge with TP Level 2 SL (if set above)
                if (finalSL) { // This holds the TP L2 SL calculated above
                    const tpSL = parseFloat(finalSL);
                    // Take the max (tightest)
                    structuralSL = Math.max(structuralSL, tpSL);
                    shouldUpdate = true;
                }

            } else { // Short
                // Rule: New Gold Interval (EMA15 > 60) -> Highest Point
                let highestInZone = -Infinity;
                let foundZone = false;
                
                for (let i = candles.length - 2; i >= 0; i--) {
                    const c = candles[i] as any;
                    const prev = candles[i-1] as any;
                    if (!prev) break;

                    const isGold = c.ema15 > c.ema60;
                    
                    if (isGold) {
                        const h = parseFloat(c.h);
                        if (h > highestInZone) highestInZone = h;
                        foundZone = true;
                    } else {
                        if (foundZone) break;
                    }
                }

                if (foundZone && highestInZone !== -Infinity) {
                    const proposedStructuralSL = highestInZone + TICK_SIZE;
                    // Ratchet: Only move DOWN
                    if (currentSL === 0 || proposedStructuralSL < currentSL) {
                        structuralSL = proposedStructuralSL;
                        shouldUpdate = true;
                    }
                }

                // Merge with TP Level 2 SL
                if (finalSL) {
                    const tpSL = parseFloat(finalSL);
                    // Take the min (tightest) for Short
                    structuralSL = structuralSL === 0 ? tpSL : Math.min(structuralSL, tpSL);
                    shouldUpdate = true;
                }
            }

            // Execute Update
            if (shouldUpdate) {
                // If we are already doing a SELL (Partial TP), we need to handle SL update separately or via "UPDATE_TPSL"
                // The current system handles ONE action per tick usually.
                // Priority: SL Update > Partial TP?
                // Prompt: "SL Priority > Adding/TP".
                // If structural SL hit, we close. Here we are just updating the trigger.
                
                // If we have a Partial Close pending (finalAction = SELL/BUY), we might not be able to update SL in same tick easily via `executeOrder`.
                // However, `updatePositionTPSL` is a separate call in server.ts.
                // We will use UPDATE_TPSL if action is HOLD.
                // If action is SELL (Partial), we assume the user prefers locking profit now. SL update can happen next tick.
                
                if (finalAction === "HOLD") {
                    finalAction = "UPDATE_TPSL";
                    finalSL = structuralSL.toFixed(config.tickSize < 0.01 ? 4 : 2);
                } else {
                    // We are partial closing. We can try to append info to reasoning so user knows SL should move next.
                    // Or we prioritize the SL update?
                    // "Partial Close" is putting money in pocket. "Updating SL" is future safety.
                    // Let's stick to Partial Close if triggered, SL update will catch up in 3 seconds.
                }
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
v**严禁** 使用任何其他指标（RSI, MACD, KDJ 等），只关注 EMA15 和 EMA60。
当前时间: ${new Date().toLocaleString()}

**市场状态**:
- 1H 趋势: ${trend1H.direction} (${trend1H.description})
- 3m 结构: ${entry3m.structure}
- 3m 信号: ${entry3m.signal ? "TRIGGERED" : "WAITING"} (${entry3m.reason})

**持仓状态**:
${posAnalysis}

**策略指令**:
1. **入场**: -必须在 1H 趋势方向上操作。看涨时: 等待 3m 图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。在金叉形成的 K 线收盘后买入。跌时: 等待 3m 图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。在死叉形成的 K 线收盘后卖出。
2. **止损 (棘轮)**: 
   - 始终使用硬止损 (Algo Order)。
   - 多单: 仅上移。目标 = 3m趋势下最新完成的死叉区间最低点。
   - 空单: 仅下移。目标 = 3m趋势下最新完成的金叉区间最高点。
3. **止盈 (分层)**:
   - 收益 > 5%: 平仓 50%。
   - 收益 > 10%: 再平仓 30%，并将止损移至盈利 50% 处。
   - 收益 > 15%: 全部平仓。
   - 1H 趋势反转: 立即全部平仓。
4. **资金**: 首仓 5% 权益。

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
            stage_analysis: "EMA趋势追踪 (Pro)",
            market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
            hot_events_overview: "正在分析热点...",
            coin_analysis: `趋势: ${tDirection}。状态: ${posAnalysis}`,
            trading_decision: {
                action: finalAction as any,
                confidence: "100%", 
                position_size: finalSize,
                leverage: DEFAULT_LEVERAGE, 
                profit_target: "",
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
            
            // Merge AI reasoning text but TRUST LOCAL CALCULATED ACTION for safety
            if(aiJson.market_assessment) decision.market_assessment = aiJson.market_assessment;
            if(aiJson.hot_events_overview) decision.hot_events_overview = aiJson.hot_events_overview;
            if(aiJson.coin_analysis) decision.coin_analysis = aiJson.coin_analysis;
            // We append AI reasoning to local reasoning
            if(aiJson.reasoning) decision.reasoning = `${decision.reasoning} | AI视角: ${aiJson.reasoning}`;

        } catch (e) {
            console.warn(`[${coinKey}] AI JSON parse failed, using local logic.`);
        }

        // --- SIZE CALCULATION (Fixing SOL < 0.01 and DOGE 51008) ---
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            
            // Check if this is a "Partial Close" (Size is already specific string like "15.5")
            // Or an "Entry" (Size is "5%")
            
            let contracts = 0;

            if (finalSize.includes('%')) {
                // Initial Entry: 5% of Equity
                const strategyAmountU = totalEquity * 0.05;
                
                // Safety: 85% of Available (Reduced from 90% to fix DOGE 51008 "Insufficient Balance")
                // Provide more buffer for fees and volatility
                const maxAffordableU = availEquity * 0.85; 

                const targetAmountU = Math.min(strategyAmountU, maxAffordableU);
                
                const leverage = parseFloat(DEFAULT_LEVERAGE); 
                // Margin needed per contract = (Val * Price) / Lev
                const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;
                
                // Raw Contracts
                let rawContracts = targetAmountU / marginPerContract;
                
                // --- FIX for DOGE (Integer Only) ---
                if (config.minSz >= 1) {
                    contracts = Math.floor(rawContracts);
                } else {
                    // ETH/SOL (Decimals allowed)
                    contracts = Math.floor(rawContracts * 100) / 100;
                }

                // --- FIX for SOL (Small Size < 0.01) ---
                // If calculated size is too small but we have money, force MIN_SZ
                if (contracts < MIN_SZ) {
                    const costForMin = marginPerContract * MIN_SZ;
                    // Check against maxAffordable (using the 85% buffer)
                    if (maxAffordableU >= costForMin) {
                        contracts = MIN_SZ;
                        decision.reasoning += ` [保底交易] 资金计算量不足${MIN_SZ}张，强制执行最小单位`;
                    } else {
                        decision.action = 'HOLD';
                        decision.size = "0";
                        decision.reasoning += ` [资金不足] 需 ${costForMin.toFixed(2)}U, 仅有 ${maxAffordableU.toFixed(2)}U`;
                        contracts = 0;
                    }
                }
            } else {
                // Partial Close (Size is already a number string from logic above)
                contracts = parseFloat(finalSize);
                // Apply integer fix for DOGE here too just in case
                if (config.minSz >= 1) contracts = Math.floor(contracts);
            }

            if (contracts > 0 && decision.action !== 'HOLD') {
                decision.size = contracts.toString();
            } else if (decision.action !== 'HOLD') {
                decision.action = 'HOLD'; // Fail-safe
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
    // 1. Fetch News (Global Context)
    const newsContext = await fetchRealTimeNews();

    // 2. Analyze Each Coin in Parallel
    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, newsContext);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
