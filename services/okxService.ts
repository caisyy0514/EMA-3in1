
import { AccountBalance, CandleData, MarketDataCollection, PositionData, TickerData, AIDecision, AccountContext, SingleMarketData } from "../types";
import { COIN_CONFIG, DEFAULT_LEVERAGE, MOCK_TICKER } from "../constants";
import CryptoJS from 'crypto-js';

const randomVariation = (base: number, percent: number) => {
  return base + base * (Math.random() - 0.5) * (percent / 100);
};

const BASE_URL = "https://www.okx.com";

const signRequest = (method: string, requestPath: string, body: string = '', secretKey: string) => {
  const timestamp = new Date().toISOString();
  const message = timestamp + method + requestPath + body;
  const hmac = CryptoJS.HmacSHA256(message, secretKey);
  const signature = CryptoJS.enc.Base64.stringify(hmac);
  return { timestamp, signature };
};

const getHeaders = (method: string, requestPath: string, body: string = '', config: any) => {
  const { timestamp, signature } = signRequest(method, requestPath, body, config.okxSecretKey);
  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': config.okxApiKey,
    'OK-ACCESS-PASSPHRASE': config.okxPassphrase,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-SIMULATED': '0' 
  };
};

// EMA Calculation Helper inside Data Service
const calculateEMA = (data: CandleData[], period: number): number[] => {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  
  // Use first close as initial EMA
  let ema = parseFloat(data[0].c);
  result.push(ema);
  
  for (let i = 1; i < data.length; i++) {
    const price = parseFloat(data[i].c);
    ema = price * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
};

// Populate candles with EMA15 and EMA60
const enrichCandlesWithEMA = (candles: CandleData[]): CandleData[] => {
    if(!candles || candles.length === 0) return [];
    
    // API returns newest first (index 0 is latest time), but EMA calculation is easier with oldest first.
    // However, our formatCandles currently reverses them to be Oldest -> Newest (Chart friendly).
    // Let's ensure they are Oldest -> Newest before calculating.
    
    const ema15 = calculateEMA(candles, 15);
    const ema60 = calculateEMA(candles, 60);
    
    return candles.map((c, i) => ({
        ...c,
        ema15: ema15[i],
        ema60: ema60[i]
    }));
};

async function fetchSingleCoinData(coinKey: string, config: any): Promise<SingleMarketData> {
    const instId = COIN_CONFIG[coinKey].instId;
    
    // 1. Ticker (Critical)
    const tickerRes = await fetch(`${BASE_URL}/api/v5/market/ticker?instId=${instId}`);
    const tickerJson = await tickerRes.json();
    if (tickerJson.code !== '0') throw new Error(`Ticker Error: ${tickerJson.msg}`);

    // Optimization: Remove unused calls (5m, 15m, Funding, OI) to save rate limits
    // Only fetch what is strictly needed for the Strategy (1H Trend, 3m Entry)

    // 2. 1H for Trend
    const candles1HRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${instId}&bar=1H&limit=300`);
    const candles1HJson = await candles1HRes.json();
    if (candles1HJson.code !== '0') throw new Error(`1H Candle Error: ${candles1HJson.msg}`);

    // 3. 3m for Entry/Exit
    const candles3mRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${instId}&bar=3m&limit=300`);
    const candles3mJson = await candles3mRes.json();
    if (candles3mJson.code !== '0') throw new Error(`3m Candle Error: ${candles3mJson.msg}`);

    return {
      ticker: tickerJson.data[0],
      candles5m: [], // Unused
      candles15m: [], // Unused
      candles1H: enrichCandlesWithEMA(formatCandles(candles1HJson.data)),
      candles3m: enrichCandlesWithEMA(formatCandles(candles3mJson.data)),
      fundingRate: "0", // Unused
      openInterest: "0", // Unused
      orderbook: {}, 
      trades: [],
    };
}

export const fetchMarketData = async (config: any): Promise<MarketDataCollection> => {
  if (config.isSimulation) {
    return generateMockMarketData();
  }

  const results: Partial<MarketDataCollection> = {};
  const coins = Object.keys(COIN_CONFIG);
  
  // Use sequential processing to strictly respect Rate Limits (Status 429)
  for (const coin of coins) {
      try {
          const data = await fetchSingleCoinData(coin, config);
          results[coin] = data;
          // Small delay (200ms) between coins to avoid bursting the API
          await new Promise(r => setTimeout(r, 200));
      } catch (e: any) {
          console.error(`Failed to fetch data for ${coin}:`, e.message);
          // Don't fail entire batch if one coin fails
      }
  }
  
  return results as MarketDataCollection;
};

// Fetch Pending Algo Orders (TP/SL)
const fetchAlgoOrders = async (instId: string, config: any): Promise<any[]> => {
    if (config.isSimulation) return [];
    try {
        const path = `/api/v5/trade/orders-algo-pending?instId=${instId}&ordType=conditional,oco,move_order_stop`;
        const headers = getHeaders('GET', path, '', config);
        const res = await fetch(BASE_URL + path, { method: 'GET', headers });
        const json = await res.json();
        return json.code === '0' ? json.data : [];
    } catch (e) {
        console.warn("Failed to fetch algo orders", e);
        return [];
    }
};

export const fetchAccountData = async (config: any): Promise<AccountContext> => {
  if (config.isSimulation) {
    return generateMockAccountData();
  }

  try {
    const balPath = '/api/v5/account/balance?ccy=USDT';
    const balHeaders = getHeaders('GET', balPath, '', config);
    const balRes = await fetch(BASE_URL + balPath, { method: 'GET', headers: balHeaders });
    const balJson = await balRes.json();

    // Fetch positions for ALL instruments
    const posPath = `/api/v5/account/positions?instType=SWAP`;
    const posHeaders = getHeaders('GET', posPath, '', config);
    const posRes = await fetch(BASE_URL + posPath, { method: 'GET', headers: posHeaders });
    const posJson = await posRes.json();

    if (balJson.code && balJson.code !== '0') throw new Error(`Balance API: ${balJson.msg}`);
    
    const balanceData = balJson.data?.[0]?.details?.[0]; 
    
    let positions: PositionData[] = [];
    
    if (posJson.data && posJson.data.length > 0) {
        // Filter only positions relevant to our supported coins
        const supportedInstIds = Object.values(COIN_CONFIG).map(c => c.instId);
        const relevantPositions = posJson.data.filter((p: any) => supportedInstIds.includes(p.instId));

        if (relevantPositions.length > 0) {
             // We need to fetch Algo orders for EACH relevant position's instrument
             // Optimization: Fetch all algos in loop? Or just assume one call per instrument if API requires it.
             // OKX pending algos API requires instId or it returns for all? Docs say instId optional but recommended.
             // Let's fetch for each relevant instId in parallel.
             
             const uniqueInstIds = [...new Set(relevantPositions.map((p: any) => p.instId))];
             const algoOrdersMap: Record<string, any[]> = {};
             
             await Promise.all(uniqueInstIds.map(async (instId: any) => {
                 algoOrdersMap[instId] = await fetchAlgoOrders(instId, config);
             }));

             positions = relevantPositions.map((rawPos: any) => {
                const position: PositionData = {
                    instId: rawPos.instId,
                    posSide: rawPos.posSide,
                    pos: rawPos.pos,
                    avgPx: rawPos.avgPx,
                    breakEvenPx: rawPos.breakEvenPx,
                    upl: rawPos.upl,
                    uplRatio: rawPos.uplRatio,
                    mgnMode: rawPos.mgnMode,
                    margin: rawPos.margin,
                    liqPx: rawPos.liqPx,
                    cTime: rawPos.cTime,
                    leverage: rawPos.lever
                };
                
                 // Find SL/TP orders specific to this position side
                 const algos = algoOrdersMap[rawPos.instId] || [];
                 if (algos.length > 0) {
                     const slOrder = algos.find((o: any) => o.posSide === rawPos.posSide && o.slTriggerPx && parseFloat(o.slTriggerPx) > 0);
                     const tpOrder = algos.find((o: any) => o.posSide === rawPos.posSide && o.tpTriggerPx && parseFloat(o.tpTriggerPx) > 0);
                     
                     if (slOrder) position.slTriggerPx = slOrder.slTriggerPx;
                     if (tpOrder) position.tpTriggerPx = tpOrder.tpTriggerPx;
                 }
                 return position;
            });
        }
    }
    
    return {
      balance: {
        totalEq: balanceData?.eq || "0",
        availEq: balanceData?.availEq || "0",
        uTime: balJson.data?.[0]?.uTime || Date.now().toString()
      },
      positions
    };

  } catch (error: any) {
     console.error("OKX Account API Error:", error);
     throw new Error(`账户数据获取失败: ${error.message}`);
  }
};

// Helper to set leverage before order
const setLeverage = async (instId: string, lever: string, posSide: string, config: any) => {
    if (config.isSimulation) return;
    
    const path = "/api/v5/account/set-leverage";
    const body = JSON.stringify({
        instId,
        lever,
        mgnMode: "isolated",
        posSide
    });
    const headers = getHeaders('POST', path, body, config);
    const response = await fetch(BASE_URL + path, { method: 'POST', headers, body });
    const json = await response.json();
    
    if (json.code !== '0') {
        throw new Error(`设置杠杆失败 (${lever}x): ${json.msg} (Code: ${json.code})`);
    }
    return json;
};

// Ensure account is in Long/Short mode
const ensureLongShortMode = async (config: any) => {
    if (config.isSimulation) return;
    const path = "/api/v5/account/config";
    const headers = getHeaders('GET', path, '', config);
    const response = await fetch(BASE_URL + path, { method: 'GET', headers });
    const json = await response.json();
    
    if (json.code === '0' && json.data && json.data[0]) {
        if (json.data[0].posMode !== 'long_short_mode') {
            console.log("Current posMode:", json.data[0].posMode, "Switching to long_short_mode...");
            const setPath = "/api/v5/account/set-position-mode";
            const setBody = JSON.stringify({ posMode: 'long_short_mode' });
            const setHeaders = getHeaders('POST', setPath, setBody, config);
            const setRes = await fetch(BASE_URL + setPath, { method: 'POST', headers: setHeaders, body: setBody });
            const setJson = await setRes.json();
            if (setJson.code !== '0') {
                throw new Error(`无法切换持仓模式为双向持仓: ${setJson.msg}。请确保无持仓后重试。`);
            }
        }
    }
};

// Fetch order details to get avgPx
const getOrderDetails = async (instId: string, ordId: string, config: any) => {
    const path = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
    const headers = getHeaders('GET', path, '', config);
    const res = await fetch(BASE_URL + path, { method: 'GET', headers: headers });
    const json = await res.json();
    if (json.code === '0' && json.data && json.data.length > 0) {
        return json.data[0];
    }
    throw new Error(`无法获取订单详情: ${json.msg}`);
};

// Place Segmented Algo Strategy
const placeAlgoStrategy = async (instId: string, posSide: string, avgPx: string, totalSz: string, config: any) => {
    if (config.isSimulation) return;
    
    console.log(`[Strategy] Placing segmented TPs for ${instId} ${posSide}, Entry: ${avgPx}, Size: ${totalSz}`);

    const entryPrice = parseFloat(avgPx);
    const size = parseFloat(totalSz);
    
    // Find Coin Config for minSz and contractVal
    const coinKey = Object.keys(COIN_CONFIG).find(k => COIN_CONFIG[k].instId === instId);
    if (!coinKey) return;
    const coinConf = COIN_CONFIG[coinKey];
    const MIN_SZ = coinConf.minSz;
    const TICK_SIZE = coinConf.tickSize;
    const leverage = parseFloat(DEFAULT_LEVERAGE);

    // Helper for formatting price
    const fmtPrice = (p: number) => {
        // Simple fix for precision based on tickSize
        const decimals = TICK_SIZE < 0.01 ? 4 : 2; 
        // Or more robust implementation using tickSize
        return p.toFixed(decimals);
    };

    // Calculate TP Prices
    // Long: Price = Entry * (1 + ROI/Lev)
    // Short: Price = Entry * (1 - ROI/Lev)
    const getTpPrice = (roi: number) => {
        if (posSide === 'long') return entryPrice * (1 + roi / leverage);
        return entryPrice * (1 - roi / leverage);
    };

    const p1 = fmtPrice(getTpPrice(0.05)); // 5%
    const p2 = fmtPrice(getTpPrice(0.08)); // 8%
    const p3 = fmtPrice(getTpPrice(0.12)); // 12%

    // Calculate Quantities (Quantized)
    const q1Raw = size * 0.30;
    const q2Raw = size * 0.30;
    const q3Raw = size * 0.20;
    
    // Quantize function
    const quantize = (s: number) => {
        const val = Math.floor(s / MIN_SZ) * MIN_SZ;
        // Fix float precision
        const prec = MIN_SZ.toString().split('.')[1]?.length || 0;
        return parseFloat(val.toFixed(prec));
    };

    const q1 = quantize(q1Raw);
    const q2 = quantize(q2Raw);
    const q3 = quantize(q3Raw);
    
    // Q4 is remainder
    let q4 = size - q1 - q2 - q3;
    const prec = MIN_SZ.toString().split('.')[1]?.length || 0;
    q4 = parseFloat(q4.toFixed(prec));

    // Prepare Algo Orders
    const algoPath = "/api/v5/trade/order-algo";
    const side = posSide === 'long' ? 'sell' : 'buy'; // Close side

    const placeConditional = async (triggerPx: string, sz: number) => {
        if (sz < MIN_SZ) return;
        const body = JSON.stringify({
            instId,
            tdMode: 'isolated',
            side,
            posSide,
            ordType: 'conditional',
            sz: sz.toString(),
            reduceOnly: true,
            tpTriggerPx: triggerPx,
            tpOrdPx: '-1' // Market Close
        });
        const headers = getHeaders('POST', algoPath, body, config);
        await fetch(BASE_URL + algoPath, { method: 'POST', headers, body });
    };

    const placeTrailing = async (activationPx: string, sz: number) => {
        if (sz < MIN_SZ) return;
        
        // FIX: Calculate callback based on ROI 5% -> Price Change %
        // ROI 5% = PriceChange% * Leverage
        // PriceChange% = 0.05 / Leverage
        const roiCallback = 0.05;
        const rawPriceCallback = roiCallback / leverage;
        
        // CONSTRAINT: Exchange only supports 0.1% step (0.001 precision)
        // We floor it to 3 decimal places to be compatible (e.g. 0.0025 -> 0.002)
        // Ensure minimum is 0.001 (0.1%)
        const flooredCallback = Math.floor(rawPriceCallback * 1000) / 1000;
        const finalCallback = Math.max(0.001, flooredCallback);
        
        const callbackRatioStr = finalCallback.toFixed(3); 

        const body = JSON.stringify({
            instId,
            tdMode: 'isolated',
            side,
            posSide,
            ordType: 'move_order_stop',
            sz: sz.toString(),
            reduceOnly: true,
            callbackRatio: callbackRatioStr, 
            activePx: activationPx // Activate at Stage 3 Price
        });
        const headers = getHeaders('POST', algoPath, body, config);
        await fetch(BASE_URL + algoPath, { method: 'POST', headers, body });
    };

    // Execute Placements (Parallel)
    const promises = [];
    if (q1 >= MIN_SZ) promises.push(placeConditional(p1, q1));
    if (q2 >= MIN_SZ) promises.push(placeConditional(p2, q2));
    if (q3 >= MIN_SZ) promises.push(placeConditional(p3, q3));
    if (q4 >= MIN_SZ) promises.push(placeTrailing(p3, q4)); // Activate trailing at P3

    try {
        await Promise.all(promises);
        console.log("Algo Strategy Placed Successfully");
    } catch (e) {
        console.error("Failed to place algo strategy", e);
    }
};

export const executeOrder = async (order: AIDecision, config: any): Promise<any> => {
  if (config.isSimulation) {
    console.log(`[${order.coin}] SIMULATION: Executing Order`, order);
    return { code: "0", msg: "模拟下单成功", data: [{ ordId: "sim_" + Date.now() }] };
  }
  
  const targetInstId = order.instId;

  try {
    // 0. Ensure Position Mode is correct
    try {
        await ensureLongShortMode(config);
    } catch (e: any) {
        console.warn("Position Mode Check Failed:", e.message);
        // Continue but warn
    }

    if (order.action === 'CLOSE') {
        const closePath = "/api/v5/trade/close-position";
        
        // 1. 尝试平多单 (Try Closing LONG)
        const closeLongBody = JSON.stringify({
            instId: targetInstId,
            posSide: 'long', 
            mgnMode: 'isolated'
        });
        const headersLong = getHeaders('POST', closePath, closeLongBody, config);
        const resLong = await fetch(BASE_URL + closePath, { method: 'POST', headers: headersLong, body: closeLongBody });
        const jsonLong = await resLong.json();
        
        if (jsonLong.code === '0') return jsonLong; // 成功
        
        // 2. 如果平多单失败，尝试平空单 (Try Closing SHORT)
        const closeShortBody = JSON.stringify({ 
            instId: targetInstId, 
            posSide: 'short', 
            mgnMode: 'isolated' 
        });
        const headersShort = getHeaders('POST', closePath, closeShortBody, config);
        const resShort = await fetch(BASE_URL + closePath, { method: 'POST', headers: headersShort, body: closeShortBody });
        const jsonShort = await resShort.json();

        if (jsonShort.code === '0') return jsonShort; // 成功

        // 3. 如果都失败，抛出详细错误 (Both failed)
        const longMsg = jsonLong.code === '51000' || jsonLong.msg.includes('不存在') ? '多单不存在' : jsonLong.msg;
        const shortMsg = jsonShort.code === '51000' || jsonShort.msg.includes('不存在') ? '空单不存在' : jsonShort.msg;
        
        throw new Error(`平仓失败 (多: ${longMsg}, 空: ${shortMsg})`);
    }

    // --- BUY / SELL (OPEN OR PARTIAL CLOSE) ---

    // 1. Fetch CURRENT Position Status to determine Side & ReduceOnly
    // This fixes the issue where SELL on Long was treated as Open Short
    let apiPosSide = '';
    let apiSide = '';
    let reduceOnly = false;

    // Fetch position specifically for this instrument
    const posPath = `/api/v5/account/positions?instId=${targetInstId}`;
    const posHeaders = getHeaders('GET', posPath, '', config);
    const posRes = await fetch(BASE_URL + posPath, { method: 'GET', headers: posHeaders });
    const posJson = await posRes.json();
    const currentPos = (posJson.data && posJson.data.length > 0) ? posJson.data[0] : null;

    if (currentPos && parseFloat(currentPos.pos) > 0) {
        // Position Exists
        apiPosSide = currentPos.posSide; // Stick to existing position side
        
        if (currentPos.posSide === 'long') {
            if (order.action === 'BUY') {
                apiSide = 'buy'; // Add to Long
                reduceOnly = false;
            } else if (order.action === 'SELL') {
                apiSide = 'sell'; // Close Long (Partial TP)
                reduceOnly = true; // IMPORTANT: Prevent Reverse Open
            }
        } else if (currentPos.posSide === 'short') {
            if (order.action === 'SELL') {
                apiSide = 'sell'; // Add to Short
                reduceOnly = false;
            } else if (order.action === 'BUY') {
                apiSide = 'buy'; // Close Short (Partial TP)
                reduceOnly = true; // IMPORTANT: Prevent Reverse Open
            }
        }
    } else {
        // No Position - Standard Open
        if (order.action === 'BUY') {
            apiPosSide = 'long';
            apiSide = 'buy';
        } else if (order.action === 'SELL') {
            apiPosSide = 'short';
            apiSide = 'sell';
        }
        reduceOnly = false;
    }

    // 2. Set Leverage First (Crucial for V5)
    try {
        await setLeverage(targetInstId, order.leverage || DEFAULT_LEVERAGE, apiPosSide, config);
    } catch (e: any) {
        throw new Error(`无法设置杠杆: ${e.message}`);
    }

    // 3. Prepare Order with Attached Algo Orders (TP/SL)
    const path = "/api/v5/trade/order";
    
    // Validate Size
    let sizeFloat = 0;
    try {
        sizeFloat = parseFloat(order.size);
        if (sizeFloat < 0.01) throw new Error("数量过小 (<0.01张)");
    } catch (e) {
        throw new Error("无效数量: " + order.size);
    }
    const initialSizeStr = sizeFloat.toFixed(2);
    
    // Check TPs and SLs once to pass into recursive function
    const slPrice = order.trading_decision?.stop_loss;
    const cleanPrice = (p: string | undefined) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0 ? p : null;
    const validSl = cleanPrice(slPrice);

    // Recursive Order Placement for Automatic Retries on 51008
    const placeOrderWithRetry = async (currentSz: string, retries: number): Promise<any> => {
        const bodyObj: any = {
            instId: targetInstId,
            tdMode: "isolated", 
            side: apiSide,
            posSide: apiPosSide, 
            ordType: "market",
            sz: currentSz,
            reduceOnly: reduceOnly
        };

        if (validSl && !reduceOnly) {
            // Only attach SL if we are NOT purely closing (reduceOnly)
            // Note: We DO NOT attach TP here anymore, as we use segmented TP strategy later
            const algoOrder: any = {};
            // Attach SL
            algoOrder.slTriggerPx = validSl;
            algoOrder.slOrdPx = '-1'; // Market close
            bodyObj.attachAlgoOrds = [algoOrder];
        }
        
        const requestBody = JSON.stringify(bodyObj);
        const headers = getHeaders('POST', path, requestBody, config);
        
        const response = await fetch(BASE_URL + path, { method: 'POST', headers: headers, body: requestBody });
        const json = await response.json();

        // FIX: Extract the actual error code from data if the top-level code is '1'
        const actualCode = (json.code === '1' && json.data && json.data.length > 0 && json.data[0].sCode) 
                            ? json.data[0].sCode 
                            : json.code;

        // Specific handling for Insufficient Balance (Code 51008)
        if (actualCode === '51008' && retries > 0) {
            console.warn(`[${targetInstId}] Balance Insufficient (51008). Reducing size by 20% and retrying... Current: ${currentSz}`);
            // Reduce by 20%
            const reduced = (parseFloat(currentSz) * 0.8).toFixed(2);
            
            // Check if reduced size is still valid (>= 0.01)
            if (parseFloat(reduced) >= 0.01) {
                return placeOrderWithRetry(reduced, retries - 1);
            }
        }

        if (json.code !== '0') {
            let errorMsg = `Code ${json.code}: ${json.msg}`;
            if (json.data && json.data.length > 0) {
                 const d = json.data[0];
                 if (d.sMsg) errorMsg += ` (sMsg: ${d.sMsg})`;
                 else if (d.sCode) errorMsg += ` (sCode: ${d.sCode})`;
                 else errorMsg += ` (Data: ${JSON.stringify(json.data)})`;
            } else if (json.data) {
                errorMsg += ` (Data: ${JSON.stringify(json.data)})`;
            }
            if (actualCode === '51008') {
                errorMsg = "余额不足 (51008): 账户资金无法支付开仓保证金(已自动重试降低仓位但仍失败)。";
            }
            throw new Error(errorMsg);
        }
        return json;
    };

    const orderRes = await placeOrderWithRetry(initialSizeStr, 2); 

    // --- AUTOMATIC ALGO STRATEGY PLACEMENT ---
    // If this was an OPEN order (not reduceOnly), we must now place the segmented TP orders
    if (!reduceOnly && orderRes.code === '0') {
        const ordId = orderRes.data?.[0]?.ordId;
        if (ordId) {
            // Short delay to ensure order is processed/fill is available
            await new Promise(r => setTimeout(r, 800));
            try {
                // Fetch filled details to get exact average price
                const orderDetails = await getOrderDetails(targetInstId, ordId, config);
                const avgPx = orderDetails.avgPx || orderDetails.fillPx; // Fill price
                
                if (avgPx && parseFloat(avgPx) > 0) {
                    // Place the segmented TP strategy
                    // Note: We use the 'currentSz' that was actually sent (available in orderDetails.sz) 
                    // in case retries reduced it.
                    const finalSize = orderDetails.sz || initialSizeStr;
                    
                    await placeAlgoStrategy(targetInstId, apiPosSide, avgPx, finalSize, config);
                } else {
                    console.warn(`Order ${ordId} filled but avgPx invalid or zero.`);
                }
            } catch (e: any) {
                console.error("Failed to place post-order algo strategy:", e.message);
                // We do not fail the main execution promise here, as the position is already open.
                // Just log the error.
            }
        }
    }

    return orderRes;

  } catch (error: any) {
      console.error(`Trade execution failed for ${targetInstId}:`, error);
      throw error;
  }
};

export const updatePositionTPSL = async (instId: string, posSide: 'long' | 'short', size: string, slPrice?: string, tpPrice?: string, config?: any) => {
    if (config.isSimulation) {
        console.log(`[SIM] Updated TP/SL for ${instId} ${posSide}: SL=${slPrice}, TP=${tpPrice}, Size=${size}`);
        return { code: "0", msg: "模拟更新成功" };
    }

    try {
        // 1. Fetch existing algo orders (Pre-fetch to know what to cancel later)
        const pendingAlgos = await fetchAlgoOrders(instId, config);
        
        // Filter SL algos to update (We usually don't want to cancel the Segmented TPs we just placed)
        // If tpPrice is provided (Manual override?), we might cancel TPs. 
        // But in this automated flow, we are mainly updating SL.
        
        const toCancel = [];
        
        if (slPrice) {
            // Cancel existing SLs
            const existingSLs = pendingAlgos.filter((o: any) => o.instId === instId && o.posSide === posSide && o.slTriggerPx && parseFloat(o.slTriggerPx) > 0);
            existingSLs.forEach((o: any) => toCancel.push({ algoId: o.algoId, instId }));
        }
        
        if (tpPrice) {
            // Cancel existing TPs if we are setting a new single TP (Unlikely in this new flow)
             const existingTPs = pendingAlgos.filter((o: any) => o.instId === instId && o.posSide === posSide && o.tpTriggerPx && parseFloat(o.tpTriggerPx) > 0);
             existingTPs.forEach((o: any) => toCancel.push({ algoId: o.algoId, instId }));
        }

        // 2. Place new Algo Order (Conditional Close) FIRST
        if (slPrice || tpPrice) {
            const path = "/api/v5/trade/order-algo";
            
            if (slPrice) {
                const slBody = JSON.stringify({
                    instId,
                    posSide,
                    tdMode: 'isolated',
                    side: posSide === 'long' ? 'sell' : 'buy', // Close Long = Sell
                    ordType: 'conditional',
                    sz: size, 
                    reduceOnly: true,
                    slTriggerPx: slPrice,
                    slOrdPx: '-1' // Market Close
                });
                const slHeaders = getHeaders('POST', path, slBody, config);
                const slRes = await fetch(BASE_URL + path, { method: 'POST', headers: slHeaders, body: slBody });
                const slJson = await slRes.json();
                if (slJson.code !== '0') throw new Error(`设置新止损失败: ${slJson.msg}`);
            }

            if (tpPrice) {
                 const tpBody = JSON.stringify({
                    instId,
                    posSide,
                    tdMode: 'isolated',
                    side: posSide === 'long' ? 'sell' : 'buy',
                    ordType: 'conditional',
                    sz: size,
                    reduceOnly: true,
                    tpTriggerPx: tpPrice,
                    tpOrdPx: '-1'
                });
                const tpHeaders = getHeaders('POST', path, tpBody, config);
                const tpRes = await fetch(BASE_URL + path, { method: 'POST', headers: tpHeaders, body: tpBody });
                const tpJson = await tpRes.json();
                if (tpJson.code !== '0') throw new Error(`设置新止盈失败: ${tpJson.msg}`);
            }
        } else {
             if (toCancel.length === 0) return { code: "0", msg: "无新的止盈止损价格" };
        }

        // 3. Cancel existing SL/TP orders ONLY after new ones are successfully placed
        if (toCancel.length > 0) {
            const cancelPath = "/api/v5/trade/cancel-algos";
            const cancelBody = JSON.stringify(toCancel);
            const headers = getHeaders('POST', cancelPath, cancelBody, config);
            await fetch(BASE_URL + cancelPath, { method: 'POST', headers: headers, body: cancelBody });
            console.log(`Cancelled ${toCancel.length} old algo orders after placing new ones.`);
        }

        return { code: "0", msg: "止盈止损更新成功" };

    } catch (e: any) {
        console.error("Update TPSL Failed:", e);
        throw new Error(`更新止盈止损失败: ${e.message}`);
    }
};

export const addMargin = async (params: { instId: string; posSide: string; type: string; amt: string }, config: any) => {
   if (config.isSimulation) {
    return { code: "0", msg: "模拟追加保证金成功" };
  }
  try {
      const path = "/api/v5/account/position/margin-balance";
      const body = JSON.stringify(params);
      const headers = getHeaders('POST', path, body, config);
      const response = await fetch(BASE_URL + path, { method: 'POST', headers: headers, body: body });
      const json = await response.json();
      if (json.code !== '0') throw new Error(`追加失败: ${json.msg}`);
      return json;
  } catch (error: any) {
      throw new Error(`追加保证金错误: ${error.message}`);
  }
}

function formatCandles(apiCandles: any[]): CandleData[] {
  if (!apiCandles || !Array.isArray(apiCandles)) return [];
  return apiCandles.map((c: string[]) => ({
    ts: c[0],
    o: c[1],
    h: c[2],
    l: c[3],
    c: c[4],
    vol: c[5]
  })).reverse(); 
}

function generateMockMarketData(): MarketDataCollection {
  const now = Date.now();
  const result: any = {};
  
  Object.keys(COIN_CONFIG).forEach(coin => {
      const config = COIN_CONFIG[coin];
      // Mock different prices
      // Update logic to support XRP price around 2.5, BTC around 65000, BNB around 600, OKB around 50
      const basePrice = coin === 'BTC' ? 65000 : coin === 'ETH' ? 3250 : coin === 'BNB' ? 600 : coin === 'SOL' ? 145 : coin === 'OKB' ? 50 : (coin === 'XRP' ? 2.50 : 0.35);
      const currentPrice = basePrice + Math.sin(now / 10000) * (basePrice * 0.01);
      
      const generateCandles = (count: number, intervalMs: number) => {
        const candles: CandleData[] = [];
        let price = currentPrice;
        for (let i = 0; i < count; i++) {
          const ts = (now - i * intervalMs).toString();
          const open = price;
          const close = randomVariation(open, 0.5);
          candles.push({ 
              ts, 
              o: open.toFixed(2), 
              h: (Math.max(open, close) + basePrice * 0.005).toFixed(2), 
              l: (Math.min(open, close) - basePrice * 0.005).toFixed(2), 
              c: close.toFixed(2), 
              vol: (Math.random() * 100).toFixed(2) 
          });
          price = parseFloat(open.toFixed(2)) + (Math.random() - 0.5) * (basePrice * 0.01);
        }
        return enrichCandlesWithEMA(candles.reverse());
      };

      result[coin] = {
        ticker: { ...MOCK_TICKER, instId: config.instId, last: currentPrice.toFixed(2), ts: now.toString() },
        candles5m: generateCandles(50, 300000),
        candles15m: generateCandles(50, 900000),
        candles1H: generateCandles(100, 3600000), 
        candles3m: generateCandles(300, 180000), 
        fundingRate: "0.0001",
        openInterest: "50000",
        orderbook: [],
        trades: []
      };
  });
  
  return result;
}

function generateMockAccountData(): AccountContext {
  return {
    balance: {
      totalEq: "100.00", 
      availEq: "100.00",
      uTime: Date.now().toString(),
    },
    positions: []
  };
}
