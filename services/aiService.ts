
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
    
    // Check the LATEST CLOSED candle (index length-1) and the one before (length-2)
    // to detect a FRESH CROSS.
    const curr = candles[candles.length - 1] as any;
    const prev = candles[candles.length - 2] as any;
    
    if (!curr.ema15 || !curr.ema60 || !prev.ema15 || !prev.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "未知" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉区域" : "死叉区域";

    // --- LONG ENTRY LOGIC ---
    // 1. Trend UP
    // 2. Fresh Gold Cross (Prev: Death, Curr: Gold)
    // 3. Confirm Previous Death Zone existed (at least 1 candle)
    if (trendDirection === 'UP') {
        // Check for Fresh Gold Cross
        const isFreshGoldCross = (prev.ema15 <= prev.ema60) && (curr.ema15 > curr.ema60);
        
        if (isFreshGoldCross) {
            // Find Lowest Low of the PRIOR Death Zone
            // Scan backwards from 'prev' until we find a Gold Cross again
            let lowestInZone = parseFloat(prev.l); // Start with prev candle low
            let foundStartOfDeathZone = false;
            let lookbackLimit = 100; // Safety break

            for (let i = candles.length - 2; i >= 0 && lookbackLimit > 0; i--) {
                const c = candles[i] as any;
                if (c.ema15 <= c.ema60) {
                    // Still in Death Zone
                    const l = parseFloat(c.l);
                    if (l < lowestInZone) lowestInZone = l;
                } else {
                    // Found the Gold Cross BEFORE the Death Zone
                    foundStartOfDeathZone = true;
                    break;
                }
                lookbackLimit--;
            }

            if (foundStartOfDeathZone) {
                return { 
                    signal: true, 
                    action: 'BUY', 
                    sl: lowestInZone, 
                    reason: `1H看涨 + 3m死叉转金叉 (死叉区间最低点止损)`,
                    structure: "刚形成金叉"
                };
            }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: "1H看涨，等待3m金叉信号", structure };
    }
    
    // --- SHORT ENTRY LOGIC ---
    // 1. Trend DOWN
    // 2. Fresh Death Cross (Prev: Gold, Curr: Death)
    // 3. Confirm Previous Gold Zone existed
    if (trendDirection === 'DOWN') {
        // Check for Fresh Death Cross
        const isFreshDeathCross = (prev.ema15 >= prev.ema60) && (curr.ema15 < curr.ema60);
        
        if (isFreshDeathCross) {
            // Find Highest High of the PRIOR Gold Zone
            let highestInZone = parseFloat(prev.h);
            let foundStartOfGoldZone = false;
            let lookbackLimit = 100;

            for (let i = candles.length - 2; i >= 0 && lookbackLimit > 0; i--) {
                const c = candles[i] as any;
                if (c.ema15 >= c.ema60) {
                    // Still in Gold Zone
                    const h = parseFloat(c.h);
                    if (h > highestInZone) highestInZone = h;
                } else {
                    // Found the Death Cross BEFORE the Gold Zone
                    foundStartOfGoldZone = true;
                    break;
                }
                lookbackLimit--;
            }

            if (foundStartOfGoldZone) {
                return { 
                    signal: true, 
                    action: 'SELL', 
                    sl: highestInZone, 
                    reason: `1H看跌 + 3m金叉转死叉 (金叉区间最高点止损)`,
                    structure: "刚形成死叉"
                };
            }
        }
        return { signal: false, action: 'HOLD', sl: 0, reason: "1H看跌，等待3m死叉信号", structure };
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "1H趋势不明确或不满足入场", structure };
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
    let finalTP = "";
    let invalidationReason = "";
    
    // --- Decision Logic ---
    if (hasPosition) {
        const p = primaryPosition!;
        const posSize = parseFloat(p.pos);
        const avgEntry = parseFloat(p.avgPx);
        // uplRatio: 0.05 = 5%
        const uplRatio = parseFloat(p.uplRatio); 
        const isLong = p.posSide === 'long';
        
        posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, ROI: ${(uplRatio * 100).toFixed(2)}%`;

        // === STOP LOSS CHECK (Hard SL is preferred, but logic check here) ===
        // Note: Logic assumes OKX handles Algo Order SL. 
        // We only actively close if 1H Trend Reverses completely.
        
        let trendReversal = false;
        if (isLong && trend1H.direction === 'DOWN') trendReversal = true;
        if (!isLong && trend1H.direction === 'UP') trendReversal = true;

        if (trendReversal) {
            finalAction = "CLOSE";
            invalidationReason = `[趋势反转] 1H趋势已变 (${trend1H.direction})`;
        }

        // === TAKE PROFIT LOGIC (Step-wise) ===
        if (finalAction === 'HOLD') {
            
            // TP2: 8% Profit -> Close All
            if (uplRatio >= 0.08) {
                finalAction = "CLOSE";
                invalidationReason = `[止盈 TP2] 收益达标 ${(uplRatio*100).toFixed(2)}% (>=8%) -> 全部止盈`;
            }
            // TP1: 5% Profit -> Close 50%
            // Problem: How to know if we already triggered TP1?
            // Heuristic: Check if current position size is close to "Initial Size".
            // Initial Size is 10% of Equity.
            // Current Value = posSize * contractVal * price / leverage? No, Position Value = posSize * contractVal * price.
            // Let's use Margin. Initial Margin ~= Equity * 0.10.
            // Current Margin ~= p.margin.
            // If p.margin > (Equity * 0.10) * 0.8, we likely haven't sold half yet.
            // (Using 0.8 as a buffer zone).
            else if (uplRatio >= 0.05) {
                const estimatedInitialMargin = totalEquity * 0.10;
                const currentMargin = parseFloat(p.margin);
                
                // If current margin is > 70% of estimated initial margin, assume we haven't done TP1 yet.
                // This prevents repetitive selling of the remaining half.
                if (currentMargin > (estimatedInitialMargin * 0.7)) {
                    finalAction = isLong ? "SELL" : "BUY";
                    finalSize = (posSize * 0.5).toFixed(2); // 50%
                    invalidationReason = `[止盈 TP1] 收益达标 ${(uplRatio*100).toFixed(2)}% (>=5%) -> 平半仓`;
                }
            }
        }

    } else {
        // No Position: Check Entry
        if (entry3m.signal) {
            finalAction = entry3m.action;
            finalSize = "10%"; // New Rule: 10% of Total Account
            finalSL = entry3m.sl.toFixed(config.tickSize < 0.01 ? 4 : 2);
            
            // Pre-calculate TP prices for display/logging? 
            // The bot uses active monitoring for TPs based on %, but we can set hard TPs if needed.
            // Prompt says: "Pre-set two TP orders".
            // Since OKX API usually attaches ONE TP, complex split TPs need active management or OCO.
            // Our system supports active monitoring (see above).
            // We will stick to Active TP monitoring in `executeOrder` or `analyzeCoin` loop 
            // because `executeOrder` only attaches one TP algo.
            // We will let the bot loop handle the 5% and 8% triggers.
        }
    }

    // --- Prompt Construction ---
    const systemPrompt = `
你是一个严格执行 **${coinKey} 趋势策略** 的交易机器人。
当前时间: ${new Date().toLocaleString()}

**策略规则**:
1. **1H 趋势**: 
   - 涨势: 价格 > EMA60 且 EMA15 > EMA60.
   - 跌势: 价格 < EMA60 且 EMA15 < EMA60.
2. **3m 入场**:
   - 做多: 1H涨势下，3m图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。金叉K线收盘进场。
   - 做空: 1H跌势下，3m图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。死叉K线收盘进场。
   - **执行指令**: 如果 "3m 信号" 显示 "TRIGGERED"，说明满足条件，**必须**输出 ACTION 为 BUY 或 SELL，不要因为"错过最佳点"而观望。只要信号触发，就是有效。
3. **资金**: 10% 权益。
4. **止损**: 3m 趋势下前一个反向交叉区间的极值（多单找死叉区间最低，空单找金叉区间最高）。
5. **止盈**: 5%收益平半仓，8%收益清仓。

**当前状态**:
- 1H: ${trend1H.description}
- 3m: ${entry3m.structure}
- 信号: ${entry3m.signal ? "触发开仓" : entry3m.reason}
- 持仓: ${posAnalysis}

**输出要求**:
1. 返回格式必须为 JSON。
2. **重要**: 所有文本分析字段（stage_analysis, market_assessment, hot_events_overview, eth_analysis, reasoning, invalidation_condition）必须使用 **中文 (Simplified Chinese)** 输出。
3. **hot_events_overview** 字段：请仔细阅读提供的 News 英文数据，将其翻译并提炼为简练的中文市场热点摘要。
4. **market_assessment** 字段：必须明确包含以下两行结论：
   - 【1H趋势】：${trend1H.description} 明确指出当前1小时级别EMA15和EMA60的关系（ [金叉 EMA15>60] 或 [死叉 EMA15<60]）是上涨还是下跌。
   - 【3m入场】：：${entry3m.structure} - ${entry3m.signal ? "满足入场" : "等待机会"}明确指出当前3分钟级别是否满足策略定义的入场条件，并说明原因。

请基于上述逻辑生成JSON决策。
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
            stage_analysis: "EMA严格趋势策略",
            market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
            hot_events_overview: "正在分析热点...",
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
            if(aiJson.hot_events_overview) decision.hot_events_overview = aiJson.hot_events_overview;
            if(aiJson.coin_analysis) decision.coin_analysis = aiJson.coin_analysis;
            if(aiJson.reasoning) decision.reasoning = `${decision.reasoning} | AI视角: ${aiJson.reasoning}`;

        } catch (e) {
            console.warn(`[${coinKey}] AI JSON parse failed, using local logic.`);
        }

        // --- SIZE CALCULATION (Preserving DOGE/SOL fixes) ---
        if (finalAction === 'BUY' || finalAction === 'SELL') {
            
            let contracts = 0;

            if (finalSize.includes('%')) {
                // New Rule: 10% of Equity
                const pct = parseFloat(finalSize) / 100; // 0.10 or 0.50 (for partial close)
                
                // If it's an Entry (not partial close), base on Total Equity
                // If it's Partial Close (SELL/BUY to reduce), logic above calculated "50% of POS". 
                // Wait, finalSize logic above:
                // Entry: "10%" -> Strategy Amount = Equity * 0.10
                // Partial: "15.5" (Already number) -> processed in else block.
                
                const strategyAmountU = totalEquity * pct;
                
                // Safety: 85% of Available (Buffer)
                const maxAffordableU = availEquity * 0.85; 

                const targetAmountU = Math.min(strategyAmountU, maxAffordableU);
                
                const leverage = parseFloat(DEFAULT_LEVERAGE); 
                const marginPerContract = (CONTRACT_VAL * currentPrice) / leverage;
                
                let rawContracts = targetAmountU / marginPerContract;
                
                // --- FIX for DOGE (Integer Only) ---
                if (config.minSz >= 1) {
                    contracts = Math.floor(rawContracts);
                } else {
                    // ETH/SOL (Decimals allowed)
                    contracts = Math.floor(rawContracts * 100) / 100;
                }

                // --- FIX for SOL (Small Size < 0.01) ---
                if (contracts < MIN_SZ) {
                    const costForMin = marginPerContract * MIN_SZ;
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
                // Partial Close (Size is already a number string like "15.5")
                contracts = parseFloat(finalSize);
                if (config.minSz >= 1) contracts = Math.floor(contracts);
            }

            if (contracts > 0 && decision.action !== 'HOLD') {
                decision.size = contracts.toString();
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
    const newsContext = await fetchRealTimeNews();

    const promises = Object.keys(COIN_CONFIG).map(async (coinKey) => {
        if (!marketData[coinKey]) return null;
        return await analyzeCoin(coinKey, apiKey, marketData[coinKey], accountData, newsContext);
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is AIDecision => r !== null);
};
