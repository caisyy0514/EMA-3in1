
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

const calculateEMA = (data: CandleData[], period: number): number[] => {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = parseFloat(data[0].c);
  result.push(ema);
  for (let i = 1; i < data.length; i++) {
    const price = parseFloat(data[i].c);
    ema = price * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
};

const enrichCandlesWithEMA = (candles: CandleData[]): CandleData[] => {
    if(!candles || candles.length === 0) return [];
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
    const tickerRes = await fetch(`${BASE_URL}/api/v5/market/ticker?instId=${instId}`);
    const tickerJson = await tickerRes.json();
    if (tickerJson.code !== '0') throw new Error(`Ticker Error: ${tickerJson.msg}`);

    const candles1HRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${instId}&bar=1H&limit=300`);
    const candles1HJson = await candles1HRes.json();
    if (candles1HJson.code !== '0') throw new Error(`1H Candle Error: ${candles1HJson.msg}`);

    const candles3mRes = await fetch(`${BASE_URL}/api/v5/market/candles?instId=${instId}&bar=3m&limit=300`);
    const candles3mJson = await candles3mRes.json();
    if (candles3mJson.code !== '0') throw new Error(`3m Candle Error: ${candles3mJson.msg}`);

    return {
      ticker: tickerJson.data[0],
      candles5m: [], 
      candles15m: [], 
      candles1H: enrichCandlesWithEMA(formatCandles(candles1HJson.data)),
      candles3m: enrichCandlesWithEMA(formatCandles(candles3mJson.data)),
      fundingRate: "0", 
      openInterest: "0", 
      orderbook: {}, 
      trades: [],
    };
}

export const fetchMarketData = async (config: any): Promise<MarketDataCollection> => {
  if (config.isSimulation) return generateMockMarketData();
  const results: Partial<MarketDataCollection> = {};
  const coins = Object.keys(COIN_CONFIG);
  for (const coin of coins) {
      try {
          const data = await fetchSingleCoinData(coin, config);
          results[coin] = data;
          await new Promise(r => setTimeout(r, 200));
      } catch (e: any) {
          console.error(`Failed to fetch data for ${coin}:`, e.message);
      }
  }
  return results as MarketDataCollection;
};

const fetchAlgoOrders = async (instId: string, config: any): Promise<any[]> => {
    if (config.isSimulation) return [];
    try {
        const path = `/api/v5/trade/orders-algo-pending?instId=${instId}`;
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
  if (config.isSimulation) return generateMockAccountData();
  try {
    const balPath = '/api/v5/account/balance?ccy=USDT';
    const balHeaders = getHeaders('GET', balPath, '', config);
    const balRes = await fetch(BASE_URL + balPath, { method: 'GET', headers: balHeaders });
    const balJson = await balRes.json();
    const posPath = `/api/v5/account/positions?instType=SWAP`;
    const posHeaders = getHeaders('GET', posPath, '', config);
    const posRes = await fetch(BASE_URL + posPath, { method: 'GET', headers: posHeaders });
    const posJson = await posRes.json();
    if (balJson.code && balJson.code !== '0') throw new Error(`Balance API: ${balJson.msg}`);
    const balanceData = balJson.data?.[0]?.details?.[0]; 
    let positions: PositionData[] = [];
    if (posJson.data && posJson.data.length > 0) {
        const supportedInstIds = Object.values(COIN_CONFIG).map(c => c.instId);
        const relevantPositions = posJson.data.filter((p: any) => supportedInstIds.includes(p.instId));
        if (relevantPositions.length > 0) {
             const uniqueInstIds = [...new Set(relevantPositions.map((p: any) => p.instId))];
             const algoOrdersMap: Record<string, any[]> = {};
             await Promise.all(uniqueInstIds.map(async (instId: any) => {
                 algoOrdersMap[instId] = await fetchAlgoOrders(instId, config);
             }));
             positions = relevantPositions.map((rawPos: any) => {
                const position: PositionData = {
                    instId: rawPos.instId, posSide: rawPos.posSide, pos: rawPos.pos,
                    avgPx: rawPos.avgPx, breakEvenPx: rawPos.breakEvenPx, upl: rawPos.upl,
                    uplRatio: rawPos.uplRatio, mgnMode: rawPos.mgnMode, margin: rawPos.margin,
                    liqPx: rawPos.liqPx, cTime: rawPos.cTime, leverage: rawPos.lever
                };
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
      balance: { totalEq: balanceData?.eq || "0", availEq: balanceData?.availEq || "0", uTime: balJson.data?.[0]?.uTime || Date.now().toString() },
      positions
    };
  } catch (error: any) {
     throw new Error(`账户数据获取失败: ${error.message}`);
  }
};

const setLeverage = async (instId: string, lever: string, posSide: string, config: any) => {
    if (config.isSimulation) return;
    const path = "/api/v5/account/set-leverage";
    const body = JSON.stringify({ instId, lever, mgnMode: "isolated", posSide });
    const headers = getHeaders('POST', path, body, config);
    const response = await fetch(BASE_URL + path, { method: 'POST', headers, body });
    const json = await response.json();
    if (json.code !== '0') throw new Error(`设置杠杆失败 (${lever}x): ${json.msg}`);
    return json;
};

const ensureLongShortMode = async (config: any) => {
    if (config.isSimulation) return;
    const path = "/api/v5/account/config";
    const headers = getHeaders('GET', path, '', config);
    const response = await fetch(BASE_URL + path, { method: 'GET', headers });
    const json = await response.json();
    if (json.code === '0' && json.data && json.data[0]) {
        if (json.data[0].posMode !== 'long_short_mode') {
            const setPath = "/api/v5/account/set-position-mode";
            const setBody = JSON.stringify({ posMode: 'long_short_mode' });
            const setHeaders = getHeaders('POST', setPath, setBody, config);
            await fetch(BASE_URL + setPath, { method: 'POST', headers: setHeaders, body: setBody });
        }
    }
};

const getOrderDetails = async (instId: string, ordId: string, config: any) => {
    const path = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
    const headers = getHeaders('GET', path, '', config);
    const res = await fetch(BASE_URL + path, { method: 'GET', headers: headers });
    const json = await res.json();
    if (json.code === '0' && json.data && json.data.length > 0) return json.data[0];
    throw new Error(`无法获取订单详情: ${json.msg}`);
};

// Place Segmented Algo Strategy
const placeAlgoStrategy = async (instId: string, posSide: string, avgPx: string, totalSz: string, config: any) => {
    if (config.isSimulation) return;
    const entryPrice = parseFloat(avgPx);
    const size = parseFloat(totalSz);
    const coinKey = Object.keys(COIN_CONFIG).find(k => COIN_CONFIG[k].instId === instId);
    if (!coinKey) return;
    const coinConf = COIN_CONFIG[coinKey];
    const MIN_SZ = coinConf.minSz;
    const TICK_SIZE = coinConf.tickSize;
    const leverage = parseFloat(DEFAULT_LEVERAGE);
    const decimals = TICK_SIZE < 0.01 ? 4 : 2;
    const sizePrecision = MIN_SZ.toString().split('.')[1]?.length || 0;

    const fmtPrice = (p: number) => p.toFixed(decimals);
    const getTpPrice = (roi: number) => posSide === 'long' ? entryPrice * (1 + roi / leverage) : entryPrice * (1 - roi / leverage);

    const p1 = fmtPrice(getTpPrice(0.05)); 
    const p2 = fmtPrice(getTpPrice(0.08)); 
    const p3 = fmtPrice(getTpPrice(0.12)); 

    // --- GREEDY ALLOCATION WITH MIN_SZ FLOOR ---
    let remaining = size;
    const calculateGreedySize = (pct: number) => {
        if (remaining <= 0) return 0;
        // Intended is the raw percentage of the total original size
        let intended = size * pct;
        // Ensure intended meets minSz
        let final = Math.max(intended, MIN_SZ);
        // Cap by remaining
        if (final > remaining) final = remaining;
        
        remaining = parseFloat((remaining - final).toFixed(sizePrecision));
        return parseFloat(final.toFixed(sizePrecision));
    };

    const s1 = calculateGreedySize(0.30);
    const s2 = calculateGreedySize(0.30);
    const s3 = calculateGreedySize(0.20);
    const s4 = parseFloat(remaining.toFixed(sizePrecision)); // Trailing gets the rest

    const algoPath = "/api/v5/trade/order-algo";
    const side = posSide === 'long' ? 'sell' : 'buy'; 

    const placeConditional = async (triggerPx: string, sz: number, stage: string) => {
        if (sz < MIN_SZ) return;
        const body = JSON.stringify({
            instId, tdMode: 'isolated', side, posSide, ordType: 'conditional',
            sz: sz.toString(), reduceOnly: true, tpTriggerPx: triggerPx, tpOrdPx: '-1'
        });
        const headers = getHeaders('POST', algoPath, body, config);
        await fetch(BASE_URL + algoPath, { method: 'POST', headers, body });
    };

    const placeTrailing = async (activationPx: string, sz: number) => {
        if (sz < MIN_SZ) return;
        const rawPriceCallback = 0.05 / leverage;
        const flooredCallback = Math.floor(rawPriceCallback * 1000) / 1000;
        const finalCallback = Math.max(0.001, flooredCallback);
        const body = JSON.stringify({
            instId, tdMode: 'isolated', side, posSide, ordType: 'move_order_stop',
            sz: sz.toString(), reduceOnly: true, callbackRatio: finalCallback.toFixed(3), activePx: activationPx
        });
        const headers = getHeaders('POST', algoPath, body, config);
        await fetch(BASE_URL + algoPath, { method: 'POST', headers, body });
    };

    const promises = [];
    if (s1 >= MIN_SZ) promises.push(placeConditional(p1, s1, "1"));
    if (s2 >= MIN_SZ) promises.push(placeConditional(p2, s2, "2"));
    if (s3 >= MIN_SZ) promises.push(placeConditional(p3, s3, "3"));
    if (s4 >= MIN_SZ) promises.push(placeTrailing(p3, s4));

    try {
        await Promise.all(promises);
    } catch (e) {
        console.error("Algo Placement Error", e);
    }
};

// Check and cancel orphaned algos (Aggressive cleanup)
export const checkAndCancelOrphanedAlgos = async (instId: string, config: any) => {
   if (config.isSimulation) return 0;
   try {
       // Query ALL algos for this instrument
       const algos = await fetchAlgoOrders(instId, config);
       if (!algos || algos.length === 0) return 0;

       // Filter any strategy order that is reduceOnly (should not exist if pos=0)
       // We include move_order_stop, conditional, oco, etc.
       const orphans = algos.filter((o: any) => o.reduceOnly === 'true');
       
       if (orphans.length > 0) {
           console.log(`[Cleanup] Found ${orphans.length} ghost strategy orders for ${instId}. Purging...`);
           const toCancel = orphans.map((o: any) => ({ algoId: o.algoId, instId }));
           const path = "/api/v5/trade/cancel-algos";
           const body = JSON.stringify(toCancel);
           const headers = getHeaders('POST', path, body, config);
           const res = await fetch(BASE_URL + path, { method: 'POST', headers, body });
           const json = await res.json();
           return json.code === '0' ? orphans.length : 0;
       }
       return 0;
   } catch (e: any) {
       console.error(`Purge failed for ${instId}:`, e.message);
       return 0;
   }
};

export const executeOrder = async (order: AIDecision, config: any): Promise<any> => {
  if (config.isSimulation) return { code: "0", msg: "模拟成功", data: [{ ordId: "sim_" + Date.now() }] };
  const targetInstId = order.instId;
  try {
    await ensureLongShortMode(config);
    if (order.action === 'CLOSE') {
        const closePath = "/api/v5/trade/close-position";
        const bodyLong = JSON.stringify({ instId: targetInstId, posSide: 'long', mgnMode: 'isolated' });
        const resLong = await fetch(BASE_URL + closePath, { method: 'POST', headers: getHeaders('POST', closePath, bodyLong, config), body: bodyLong });
        const jsonLong = await resLong.json();
        if (jsonLong.code === '0') return jsonLong;
        const bodyShort = JSON.stringify({ instId: targetInstId, posSide: 'short', mgnMode: 'isolated' });
        const resShort = await fetch(BASE_URL + closePath, { method: 'POST', headers: getHeaders('POST', closePath, bodyShort, config), body: bodyShort });
        return await resShort.json();
    }
    let apiPosSide = '', apiSide = '', reduceOnly = false;
    const posPath = `/api/v5/account/positions?instId=${targetInstId}`;
    const posRes = await fetch(BASE_URL + posPath, { method: 'GET', headers: getHeaders('GET', posPath, '', config) });
    const posJson = await posRes.json();
    const currentPos = (posJson.data && posJson.data.length > 0) ? posJson.data[0] : null;
    if (currentPos && parseFloat(currentPos.pos) > 0) {
        apiPosSide = currentPos.posSide;
        if (currentPos.posSide === 'long') {
            apiSide = order.action === 'BUY' ? 'buy' : 'sell';
            reduceOnly = order.action === 'SELL';
        } else {
            apiSide = order.action === 'SELL' ? 'sell' : 'buy';
            reduceOnly = order.action === 'BUY';
        }
    } else {
        apiPosSide = order.action === 'BUY' ? 'long' : 'short';
        apiSide = order.action === 'BUY' ? 'buy' : 'sell';
        reduceOnly = false;
    }
    await setLeverage(targetInstId, order.leverage || DEFAULT_LEVERAGE, apiPosSide, config);
    const placeOrderWithRetry = async (currentSz: string, retries: number): Promise<any> => {
        const bodyObj: any = { instId: targetInstId, tdMode: "isolated", side: apiSide, posSide: apiPosSide, ordType: "market", sz: currentSz, reduceOnly };
        const slPrice = order.trading_decision?.stop_loss;
        if (slPrice && !reduceOnly && parseFloat(slPrice) > 0) {
            bodyObj.attachAlgoOrds = [{ slTriggerPx: slPrice, slOrdPx: '-1' }];
        }
        const requestBody = JSON.stringify(bodyObj);
        const headers = getHeaders('POST', "/api/v5/trade/order", requestBody, config);
        const response = await fetch(BASE_URL + "/api/v5/trade/order", { method: 'POST', headers, body: requestBody });
        const json = await response.json();
        const actualCode = (json.code === '1' && json.data?.[0]?.sCode) ? json.data[0].sCode : json.code;
        if (actualCode === '51008' && retries > 0) {
            const reduced = (parseFloat(currentSz) * 0.8).toFixed(2);
            if (parseFloat(reduced) >= 0.01) return placeOrderWithRetry(reduced, retries - 1);
        }
        if (json.code !== '0') throw new Error(`OKX API ${json.code}: ${json.msg}`);
        return json;
    };
    const orderRes = await placeOrderWithRetry(order.size, 2); 
    if (!reduceOnly && orderRes.code === '0') {
        const ordId = orderRes.data?.[0]?.ordId;
        if (ordId) {
            await new Promise(r => setTimeout(r, 800));
            const details = await getOrderDetails(targetInstId, ordId, config);
            const avgPx = details.avgPx || details.fillPx;
            if (avgPx && parseFloat(avgPx) > 0) {
                await placeAlgoStrategy(targetInstId, apiPosSide, avgPx, details.sz || order.size, config);
            }
        }
    }
    return orderRes;
  } catch (error: any) {
      throw error;
  }
};

export const updatePositionTPSL = async (instId: string, posSide: 'long' | 'short', size: string, slPrice?: string, tpPrice?: string, config?: any) => {
    if (config.isSimulation) return { code: "0", msg: "模拟成功" };
    try {
        const pendingAlgos = await fetchAlgoOrders(instId, config);
        const toCancel = [];
        if (slPrice) {
            pendingAlgos.filter((o: any) => o.instId === instId && o.posSide === posSide && o.slTriggerPx && parseFloat(o.slTriggerPx) > 0)
                .forEach((o: any) => toCancel.push({ algoId: o.algoId, instId }));
        }
        const path = "/api/v5/trade/order-algo";
        if (slPrice) {
            const body = JSON.stringify({ instId, posSide, tdMode: 'isolated', side: posSide === 'long' ? 'sell' : 'buy', ordType: 'conditional', sz: size, reduceOnly: true, slTriggerPx: slPrice, slOrdPx: '-1' });
            const res = await fetch(BASE_URL + path, { method: 'POST', headers: getHeaders('POST', path, body, config), body });
            const json = await res.json();
            if (json.code !== '0') throw new Error(`SL Update Failed: ${json.msg}`);
        }
        if (toCancel.length > 0) {
            const cancelPath = "/api/v5/trade/cancel-algos";
            const cancelBody = JSON.stringify(toCancel);
            await fetch(BASE_URL + cancelPath, { method: 'POST', headers: getHeaders('POST', cancelPath, cancelBody, config), body: cancelBody });
        }
        return { code: "0", msg: "更新成功" };
    } catch (e: any) {
        throw new Error(`TPSL失败: ${e.message}`);
    }
};

export const addMargin = async (params: { instId: string; posSide: string; type: string; amt: string }, config: any) => {
   if (config.isSimulation) return { code: "0", msg: "成功" };
   const path = "/api/v5/account/position/margin-balance";
   const body = JSON.stringify(params);
   const res = await fetch(BASE_URL + path, { method: 'POST', headers: getHeaders('POST', path, body, config), body });
   return await res.json();
}

function formatCandles(apiCandles: any[]): CandleData[] {
  if (!apiCandles || !Array.isArray(apiCandles)) return [];
  return apiCandles.map((c: string[]) => ({ ts: c[0], o: c[1], h: c[2], l: c[3], c: c[4], vol: c[5] })).reverse(); 
}

function generateMockMarketData(): MarketDataCollection {
  const now = Date.now();
  const result: any = {};
  Object.keys(COIN_CONFIG).forEach(coin => {
      const config = COIN_CONFIG[coin];
      const basePrice = coin === 'BTC' ? 65000 : coin === 'ETH' ? 3250 : coin === 'BNB' ? 600 : coin === 'SOL' ? 145 : coin === 'OKB' ? 50 : (coin === 'XRP' ? 2.50 : 0.35);
      const currentPrice = basePrice + Math.sin(now / 10000) * (basePrice * 0.01);
      const generateCandles = (count: number, intervalMs: number) => {
        const candles: CandleData[] = [];
        let price = currentPrice;
        for (let i = 0; i < count; i++) {
          const ts = (now - i * intervalMs).toString();
          const open = price;
          const close = randomVariation(open, 0.5);
          candles.push({ ts, o: open.toFixed(2), h: (Math.max(open, close) + basePrice * 0.005).toFixed(2), l: (Math.min(open, close) - basePrice * 0.005).toFixed(2), c: close.toFixed(2), vol: (Math.random() * 100).toFixed(2) });
          price = parseFloat(open.toFixed(2)) + (Math.random() - 0.5) * (basePrice * 0.01);
        }
        return enrichCandlesWithEMA(candles.reverse());
      };
      result[coin] = { ticker: { ...MOCK_TICKER, instId: config.instId, last: currentPrice.toFixed(2), ts: now.toString() }, candles5m: [], candles15m: [], candles1H: generateCandles(100, 3600000), candles3m: generateCandles(300, 180000), fundingRate: "0.0001", openInterest: "50000", orderbook: [], trades: [] };
  });
  return result;
}

function generateMockAccountData(): AccountContext {
  return { balance: { totalEq: "1000.00", availEq: "1000.00", uTime: Date.now().toString() }, positions: [] };
}
