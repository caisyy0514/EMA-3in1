
import { AIDecision, MarketDataCollection, AccountContext, CandleData } from "../types";
import { CONTRACT_VAL_ETH, INSTRUMENT_ID, TAKER_FEE_RATE, DEFAULT_LEVERAGE } from "../constants";

// --- Technical Indicator Helpers ---

// Define Tick Size for ETH-USDT
const TICK_SIZE = 0.01;

const calcEMA = (prices: number[], period: number): number => {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
};

// Calculate full array of EMA values
const calcEMAArray = (prices: number[], period: number): number[] => {
    if (prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray: number[] = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        // Standard EMA formula: Price(t) * k + EMA(y) * (1-k)
        // Initialize with first price (simple moving average approximation for first point or just price)
        const val = i === 0 ? prices[0] : prices[i] * k + emaArray[i-1] * (1 - k);
        emaArray.push(val);
    }
    return emaArray;
};

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
// 使用 CryptoCompare 公共 API 获取实时热点
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

// --- Strategy Logic: ETH EMA Trend Tracking ---

function analyze1HTrend(candles: CandleData[]) {
    // Need enough data for EMA60 stability
    if (candles.length < 100) return { direction: 'NEUTRAL', timestamp: 0, description: "数据不足" };
    
    // EMA data is now pre-calculated in candles (from okxService)
    // We assume the candle structure has ema15 and ema60 populated if available
    // BUT okxService implementation calculates EMA inside it and returns CandleData type.
    // However, types.ts CandleData doesn't explicitly have ema15/60? 
    // Wait, previous instructions updated okxService to add these. 
    // And previous instructions updated types.ts to include ema15/ema60?
    // Let's assume the data passed here HAS ema15 and ema60 on the object, 
    // but types.ts might need casting if it wasn't fully updated or we access via bracket notation.
    // Actually, based on previous prompt execution, types.ts WAS updated.
    
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
    const prev = candles[i-1] as any;

    if (!curr.ema15 || !curr.ema60 || !prev.ema15 || !prev.ema60) {
         return { signal: false, action: 'HOLD', sl: 0, reason: "指标数据不足", structure: "未知" };
    }
    
    const currentGold = curr.ema15 > curr.ema60;
    const structure = currentGold ? "金叉多头区域" : "死叉空头区域";

    // Long Logic: Trend UP -> Find Death Cross -> Then Gold Cross
    if (trendDirection === 'UP') {
        // 1. Check if we JUST crossed up (Gold Cross trigger)
        // Condition: EMA15[i] > EMA60[i] AND EMA15[i-1] <= EMA60[i-1]
        const justCrossedUp = curr.ema15 > curr.ema60 && prev.ema15 <= prev.ema60;
        
        if (justCrossedUp) {
            // 2. Validate "Preceding Death Cross Sequence"
            let foundDeathZone = false;
            let lowestInDeathZone = parseFloat(curr.l); // Start tracking SL
            
            for (let x = i - 1; x >= 0; x--) {
                const c = candles[x] as any;
                if (c.ema15 < c.ema60) {
                    foundDeathZone = true;
                    const low = parseFloat(c.l);
                    if (low < lowestInDeathZone) lowestInDeathZone = low;
                } else {
                    if (foundDeathZone) break;
                }
            }
            
            if (foundDeathZone) {
                return { 
                    signal: true, 
                    action: 'BUY', 
                    sl: lowestInDeathZone, 
                    reason: "1H上涨 + 3m死叉后金叉",
                    structure
                };
            }
        }
    }
    
    // Short Logic: Trend DOWN -> Find Gold Cross -> Then Death Cross
    if (trendDirection === 'DOWN') {
        // 1. Check if we JUST crossed down (Death Cross trigger)
        const justCrossedDown = curr.ema15 < curr.ema60 && prev.ema15 >= prev.ema60;
        
        if (justCrossedDown) {
            // 2. Validate "Preceding Gold Cross Sequence"
            let foundGoldZone = false;
            let highestInGoldZone = parseFloat(curr.h);
            
            for (let x = i - 1; x >= 0; x--) {
                const c = candles[x] as any;
                if (c.ema15 > c.ema60) {
                    foundGoldZone = true;
                    const high = parseFloat(c.h);
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
                    reason: "1H下跌 + 3m金叉后死叉",
                    structure
                };
            }
        }
    }
    
    // Return explicit reasons/structure even if no signal
    if (trendDirection === 'UP') return { signal: false, action: 'HOLD', sl: 0, reason: "1H上涨中，等待3m回调信号", structure };
    if (trendDirection === 'DOWN') return { signal: false, action: 'HOLD', sl: 0, reason: "1H下跌中，等待3m反弹信号", structure };

    return { signal: false, action: 'HOLD', sl: 0, reason: "1H趋势不明确，暂无入场", structure };
}

// --- Main Decision Function ---

export const getTradingDecision = async (
  apiKey: string,
  marketData: MarketDataCollection,
  accountData: AccountContext
): Promise<AIDecision> => {
  if (!apiKey) throw new Error("请输入 DeepSeek API Key");

  // --- 1. Data Prep ---
  const currentPrice = parseFloat(marketData.ticker?.last || "0");
  const totalEquity = parseFloat(accountData.balance.totalEq);
  
  // Strategy Analysis
  const trend1H = analyze1HTrend(marketData.candles1H);
  const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction);
  
  // Position Info
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
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
      
      posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, 浮盈: ${upl} U`;

      // 1. Check Trend Reversal (Immediate Close)
      if (trend1H.direction === 'UP' && !isLong) finalAction = "CLOSE";
      else if (trend1H.direction === 'DOWN' && isLong) finalAction = "CLOSE";
      
      // 2. Rolling (Pyramiding)
      // Rule: Profit 5% -> Add 5%. Interpreted as PnL >= 5% of Account Equity
      if (finalAction === "HOLD") {
          const profitThreshold = totalEquity * 0.05;
          if (upl >= profitThreshold) {
              finalAction = isLong ? "BUY" : "SELL";
              finalSize = "5%"; // Will be calc'd later
              invalidationReason = "Rolling: Profit > 5%";
          }
      }
      
      // 3. Trailing SL Logic
      // Rule: Move to BE if profitable. Then trail 3-5 candles.
      if (finalAction === "HOLD" || finalAction.includes("BUY") || finalAction.includes("SELL")) {
          // Calculate Trailing SL
          const recent3m = marketData.candles3m.slice(-5);
          let newSL = parseFloat(p.slTriggerPx || "0");
          let shouldUpdate = false;
          
          const entryPx = parseFloat(p.avgPx);
          
          // Calculate Fee-Adjusted Break Even Price
          // 0.06% buffer on each side (0.12% total) covers Taker(0.05%) + Taker(0.05%) + Slippage
          const FEE_BUFFER = 0.0012; 
          
          if (isLong) {
              const breakEvenPrice = entryPx * (1 + FEE_BUFFER);
              const lowestRecent = Math.min(...recent3m.map(c => parseFloat(c.l)));
              
              // 1. Calculate Technical Trail (Candle Structure)
              // Rule: Lowest of last 5 candles minus 1 tick (TICK_SIZE)
              let targetSL = lowestRecent - TICK_SIZE;
              
              // 2. Apply "Cross Break Even" Rule if Net Profitable
              if (currentPrice > breakEvenPrice) {
                  // If we are in net profit, SL MUST be above BreakEven
                  // We take the higher of the Technical Trail and the BE Price
                  targetSL = Math.max(targetSL, breakEvenPrice);
              }
              
              // 3. Execution Rule: Only Move UP, Never Down. And must be below current price.
              if (targetSL > newSL && targetSL < currentPrice) {
                  newSL = targetSL;
                  shouldUpdate = true;
              }

          } else {
              const breakEvenPrice = entryPx * (1 - FEE_BUFFER);
              const highestRecent = Math.max(...recent3m.map(c => parseFloat(c.h)));
              
              // 1. Calculate Technical Trail
              // Rule: Highest of last 5 candles plus 1 tick (TICK_SIZE)
              let targetSL = highestRecent + TICK_SIZE;
              
              // 2. Apply Rule
              if (currentPrice < breakEvenPrice) {
                  // If in net profit, SL MUST be below BreakEven
                  targetSL = Math.min(targetSL, breakEvenPrice);
              }
              
              // 3. Execution Rule: Only Move DOWN, Never Up.
              // Note: newSL 0 means no SL set yet.
              if ((newSL === 0 || targetSL < newSL) && targetSL > currentPrice) {
                  newSL = targetSL;
                  shouldUpdate = true;
              }
          }
          
          if (shouldUpdate && finalAction === "HOLD") {
              finalAction = "UPDATE_TPSL";
              finalSL = newSL.toFixed(2);
          }
          if (shouldUpdate && (finalAction === "BUY" || finalAction === "SELL")) {
              // If adding position, we also update SL for the whole stack
              finalSL = newSL.toFixed(2);
          }
      }

  } else {
      // No Position: Check Entry
      if (entry3m.signal) {
          finalAction = entry3m.action;
          finalSize = "5%"; // Initial Size
          finalSL = entry3m.sl.toFixed(2);
      }
  }

  // --- News ---
  const newsContext = await fetchRealTimeNews();

  // --- Prompt Construction (Verification) ---
  const systemPrompt = `
你是一个严格执行 **ETH EMA 趋势追踪策略** 的交易机器人。
当前时间: ${new Date().toLocaleString()}

**策略状态**:
1. **1H 趋势**: ${trend1H.direction} (${trend1H.description})
   - 判定规则: 只要EMA15 > EMA60即为UP，EMA15 < EMA60即为DOWN，K线颜色仅代表强度。
2. **3m 结构**: ${entry3m.structure}
3. **3m 入场信号**: ${entry3m.signal ? entry3m.action + " triggered" : "None"} (Reason: ${entry3m.reason})
4. **计算建议**: Action=${finalAction}, SL=${finalSL || "Keep"}

**执行规则**:
- 只有当 1H 趋势明确(UP/DOWN) 且 3m 出现特定交叉形态(死后金/金后死)才开仓。
- 首仓 5% 权益。
- 盈利 > 5% 权益时滚仓加码 5%。
- 趋势反转立即平仓。
- 默认杠杆固定为 ${DEFAULT_LEVERAGE}x。

**输出要求**:
1. 返回格式必须为 JSON。
2. **重要**: 所有文本分析字段（stage_analysis, market_assessment, hot_events_overview, eth_analysis, reasoning, invalidation_condition）必须使用 **中文 (Simplified Chinese)** 输出。
3. **hot_events_overview** 字段：请仔细阅读提供的 News 英文数据，将其翻译并提炼为简练的中文市场热点摘要。
4. **market_assessment** 字段：必须明确包含以下两行结论：
   - 【1H趋势】：${trend1H.description}
   - 【3m入场】：${entry3m.structure} - ${entry3m.signal ? "满足入场" : "等待机会"}

请基于上述计算结果生成 JSON 决策。
`;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Account: ${totalEquity} USDT. News Data: ${newsContext}` }
    ]);

    // Construct Fallback strings for market assessment
    const tDirection = trend1H.description;
    const tEntry = `${entry3m.structure} - ${entry3m.signal ? "满足入场" : entry3m.reason}`;

    // We mostly trust our calculated 'finalAction' but let AI explain/confirm format
    let decision: AIDecision = {
        stage_analysis: "EMA趋势追踪",
        market_assessment: `【1H趋势】：${tDirection}\n【3m入场】：${tEntry}`,
        hot_events_overview: "正在分析热点...",
        eth_analysis: `EMA15/60 状态分析。趋势: ${tDirection}`,
        trading_decision: {
            action: finalAction as any,
            confidence: "100%", // Logic driven
            position_size: finalSize,
            leverage: DEFAULT_LEVERAGE, // Force 5x
            profit_target: "",
            stop_loss: finalSL,
            invalidation_condition: "Trend Reversal"
        },
        reasoning: `基于EMA15/60严格策略逻辑。1H趋势为${tDirection}。3m信号状态：${tEntry}。`,
        action: finalAction as any,
        size: "0",
        leverage: DEFAULT_LEVERAGE // Force 5x
    };

    // Parse AI reasoning if valid JSON
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiJson = JSON.parse(cleanText);
        
        // Map AI fields if they exist
        if(aiJson.stage_analysis) decision.stage_analysis = aiJson.stage_analysis;
        if(aiJson.market_assessment) decision.market_assessment = aiJson.market_assessment;
        if(aiJson.hot_events_overview) decision.hot_events_overview = aiJson.hot_events_overview;
        if(aiJson.eth_analysis) decision.eth_analysis = aiJson.eth_analysis;
        if(aiJson.reasoning) decision.reasoning = aiJson.reasoning;
        if(aiJson.trading_decision?.invalidation_condition) {
             decision.trading_decision.invalidation_condition = aiJson.trading_decision.invalidation_condition;
        }

    } catch (e) {
        // Ignore JSON parse error, use defaults but maybe keep text if it looks like reasoning
        console.warn("AI Response JSON parse failed, using defaults.");
    }

    // Calc precise size for "5%"
    if (finalAction === 'BUY' || finalAction === 'SELL') {
        const amountU = totalEquity * 0.05;
        const leverage = parseFloat(DEFAULT_LEVERAGE); // 5x
        const positionValue = amountU * leverage;
        const contracts = positionValue / (CONTRACT_VAL_ETH * currentPrice);
        decision.size = Math.max(contracts, 0.01).toFixed(2);
    }

    return decision;

  } catch (error: any) {
    console.error("Strategy Error:", error);
    return {
        stage_analysis: "策略执行错误",
        market_assessment: "无法评估",
        hot_events_overview: "数据获取失败",
        eth_analysis: "N/A",
        trading_decision: { action: 'hold', confidence: "0%", position_size: "0", leverage: "0", profit_target: "", stop_loss: "", invalidation_condition: "" },
        reasoning: `系统错误: ${error.message}`,
        action: 'HOLD',
        size: "0",
        leverage: "0"
    };
  }
};
