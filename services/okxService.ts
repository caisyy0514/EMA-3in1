
import { AccountBalance, CandleData, MarketDataCollection, PositionData, TickerData, AIDecision, AccountContext } from "../types";
import { INSTRUMENT_ID, MOCK_TICKER, CONTRACT_VAL_ETH, DEFAULT_LEVERAGE } from "../constants";
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

export const fetchMarketData = async (config: any): Promise<MarketDataCollection> => {
  if (config.isSimulation) {
    return generateMockMarketData();
  }

  try {
    const tickerRes = await fetch(`${BASE_URL}/api/v5/market/ticker?instId=${INSTRUMENT_ID}`);
    const tickerJson = await tickerRes.json();
    
    // Existing (Optional but kept for compatibility)
    const candles5mRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${INSTRUMENT_ID}&bar=5m&limit=50`);
    const candles5mJson = await candles5mRes.json();
    
    // 15m (Kept for compatibility)
    const candles15mRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${INSTRUMENT_ID}&bar=15m&limit=50`);
    const candles15mJson = await candles15mRes.json();

    // NEW: 1H for Trend - Increased to 300 to ensure EMA60 is accurate
    const candles1HRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${INSTRUMENT_ID}&bar=1H&limit=300`);
    const candles1HJson = await candles1HRes.json();

    // NEW: 3m for Entry/Exit - Increased limit to 300 to capture pre-cross intervals
    const candles3mRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${INSTRUMENT_ID}&bar=3m&limit=300`);
    const candles3mJson = await candles3mRes.json();

    const fundingRes = await fetch(`${BASE_URL}/api/v5/public/funding-rate?instId=${INSTRUMENT_ID}`);
    const fundingJson = await fundingRes.json();
    
    const oiRes = await fetch(`${BASE_URL}/api/v5/public/open-interest?instId=${INSTRUMENT_ID}`);
    const oiJson = await oiRes.json();

    if (tickerJson.code !== '0') throw new Error(`OKX API Error (Ticker): ${tickerJson.msg}`);

    return {
      ticker: tickerJson.data[0],
      candles5m: formatCandles(candles5mJson.data),
      candles15m: formatCandles(candles15mJson.data),
      candles1H: formatCandles(candles1HJson.data),
      candles3m: formatCandles(candles3mJson.data),
      fundingRate: fundingJson.data[0]?.fundingRate || "0",
      openInterest: oiJson.data[0]?.oi || "0",
      orderbook: {}, 
      trades: [],
    };
  } catch (error: any) {
    console.error("OKX API 获取失败:", error);
    throw new Error(`无法连接 OKX API: ${error.message}`);
  }
};

// Fetch Pending Algo Orders (TP/SL)
const fetchAlgoOrders = async (config: any): Promise<any[]> => {
    if (config.isSimulation) return [];
    try {
        const path = `/api/v5/trade/orders-algo-pending?instId=${INSTRUMENT_ID}&ordType=conditional,oco`;
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

    // Fetch positions for the specific instrument, or remove instId param to fetch all
    const posPath = `/api/v5/account/positions?instId=${INSTRUMENT_ID}`;
    const posHeaders = getHeaders('GET', posPath, '', config);
    const posRes = await fetch(BASE_URL + posPath, { method: 'GET', headers: posHeaders });
    const posJson = await posRes.json();

    if (balJson.code && balJson.code !== '0') throw new Error(`Balance API: ${balJson.msg}`);
    
    const balanceData = balJson.data?.[0]?.details?.[0]; 
    
    let positions: PositionData[] = [];
    
    if (posJson.data && posJson.data.length > 0) {
        const algoOrders = await fetchAlgoOrders(config);
        
        positions = posJson.data.map((rawPos: any) => {
            const position: PositionData = {
                instId: rawPos.instId,
                posSide: rawPos.posSide,
                pos: rawPos.pos,
                avgPx: rawPos.avgPx,
                breakEvenPx: rawPos.breakEvenPx, // Map Exchange Breakeven Price
                upl: rawPos.upl,
                uplRatio: rawPos.uplRatio,
                mgnMode: rawPos.mgnMode,
                margin: rawPos.margin,
                liqPx: rawPos.liqPx,
                cTime: rawPos.cTime,
                leverage: rawPos.lever
            };
            
             // Find SL/TP orders specific to this position side
             if (algoOrders.length > 0) {
                 const slOrder = algoOrders.find((o: any) => o.instId === rawPos.instId && o.posSide === rawPos.posSide && o.slTriggerPx && parseFloat(o.slTriggerPx) > 0);
                 const tpOrder = algoOrders.find((o: any) => o.instId === rawPos.instId && o.posSide === rawPos.posSide && o.tpTriggerPx && parseFloat(o.tpTriggerPx) > 0);
                 
                 if (slOrder) position.slTriggerPx = slOrder.slTriggerPx;
                 if (tpOrder) position.tpTriggerPx = tpOrder.tpTriggerPx;
             }
             return position;
        });
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

export const executeOrder = async (order: AIDecision, config: any): Promise<any> => {
  if (config.isSimulation) {
    console.log("SIMULATION: Executing Order", order);
    return { code: "0", msg: "模拟下单成功", data: [{ ordId: "sim_" + Date.now() }] };
  }
  
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
            instId: INSTRUMENT_ID,
            posSide: 'long', 
            mgnMode: 'isolated'
        });
        const headersLong = getHeaders('POST', closePath, closeLongBody, config);
        const resLong = await fetch(BASE_URL + closePath, { method: 'POST', headers: headersLong, body: closeLongBody });
        const jsonLong = await resLong.json();
        
        if (jsonLong.code === '0') return jsonLong; // 成功
        
        // 2. 如果平多单失败，尝试平空单 (Try Closing SHORT)
        const closeShortBody = JSON.stringify({ 
            instId: INSTRUMENT_ID, 
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

    // --- BUY / SELL ---
    
    // 1. Determine Position Side
    const posSide = order.action === 'BUY' ? 'long' : 'short';
    const side = order.action === 'BUY' ? 'buy' : 'sell';

    // 2. Set Leverage First (Crucial for V5)
    try {
        await setLeverage(INSTRUMENT_ID, order.leverage || DEFAULT_LEVERAGE, posSide, config);
    } catch (e: any) {
        throw new Error(`无法设置战神策略杠杆: ${e.message}`);
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
    const sizeStr = sizeFloat.toFixed(2);

    const bodyObj: any = {
        instId: INSTRUMENT_ID,
        tdMode: "isolated", 
        side: side,
        posSide: posSide, 
        ordType: "market",
        sz: sizeStr
    };
    
    // Attach TP/SL (attachAlgoOrds)
    const tpPrice = order.trading_decision?.profit_target;
    const slPrice = order.trading_decision?.stop_loss;
    const cleanPrice = (p: string | undefined) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0 ? p : null;

    const validTp = cleanPrice(tpPrice);
    const validSl = cleanPrice(slPrice);

    if (validTp || validSl) {
        const algoOrder: any = {};
        if (validTp) {
            algoOrder.tpTriggerPx = validTp;
            algoOrder.tpOrdPx = '-1'; // Market close
        }
        if (validSl) {
            algoOrder.slTriggerPx = validSl;
            algoOrder.slOrdPx = '-1'; // Market close
        }
        bodyObj.attachAlgoOrds = [algoOrder];
    }
    
    const requestBody = JSON.stringify(bodyObj);
    const headers = getHeaders('POST', path, requestBody, config);
    
    const response = await fetch(BASE_URL + path, { method: 'POST', headers: headers, body: requestBody });
    const json = await response.json();

    if (json.code !== '0') {
        let errorMsg = `Code ${json.code}: ${json.msg}`;
        if (json.data) errorMsg += ` (Data: ${JSON.stringify(json.data)})`;

        if (json.code === '51008') {
            errorMsg = "余额不足 (51008): 账户资金无法支付当前开仓保证金及手续费，系统将尝试降低仓位重试。";
        }
        throw new Error(errorMsg);
    }
    return json;

  } catch (error: any) {
      console.error("Trade execution failed:", error);
      throw error;
  }
};

export const updatePositionTPSL = async (instId: string, posSide: 'long' | 'short', size: string, slPrice?: string, tpPrice?: string, config?: any) => {
    if (config.isSimulation) {
        console.log(`[SIM] Updated TP/SL for ${posSide}: SL=${slPrice}, TP=${tpPrice}, Size=${size}`);
        return { code: "0", msg: "模拟更新成功" };
    }

    try {
        // 1. Fetch existing algo orders (Pre-fetch to know what to cancel later)
        const pendingAlgos = await fetchAlgoOrders(config);
        
        const toCancel = pendingAlgos
            .filter((o: any) => o.instId === instId && o.posSide === posSide)
            .map((o: any) => ({ algoId: o.algoId, instId }));

        // 2. Place new Algo Order (Conditional Close) FIRST
        // If placing fails, we throw and DO NOT cancel old orders (safeguard)
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

        // 3. Cancel existing SL/TP orders ONLY after new ones are successfully placed (or if we are just clearing)
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
  const currentPrice = 3250 + Math.sin(now / 10000) * 50; 
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
          h: (Math.max(open, close) + 2).toFixed(2), 
          l: (Math.min(open, close) - 2).toFixed(2), 
          c: close.toFixed(2), 
          vol: (Math.random() * 100).toFixed(2) 
      });
      price = parseFloat(open.toFixed(2)) + (Math.random() - 0.5) * 10;
    }
    return candles.reverse();
  };

  return {
    ticker: { ...MOCK_TICKER, last: currentPrice.toFixed(2), ts: now.toString() },
    candles5m: generateCandles(50, 300000),
    candles15m: generateCandles(50, 900000),
    candles1H: generateCandles(100, 3600000), 
    candles3m: generateCandles(300, 180000), 
    fundingRate: "0.0001",
    openInterest: "50000",
    orderbook: [],
    trades: []
  };
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
