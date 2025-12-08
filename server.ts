
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { MarketDataCollection, AccountContext, AIDecision, SystemLog, AppConfig } from './types';
import { DEFAULT_CONFIG, INSTRUMENT_ID } from './constants';
import * as okxService from './services/okxService';
import * as aiService from './services/aiService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors() as any);
app.use(express.json() as any);
app.use(express.static(path.join(__dirname, 'dist')) as any);

// --- Server State ---
let config: AppConfig = { ...DEFAULT_CONFIG };
let isRunning = false;
let marketData: MarketDataCollection | null = null;
let accountData: AccountContext | null = null;
let latestDecision: AIDecision | null = null;
let decisionHistory: AIDecision[] = []; // Store history
let logs: SystemLog[] = [];
let lastAnalysisTime = 0;

// Helper to add logs
const addLog = (type: SystemLog['type'], message: string) => {
  const log: SystemLog = { 
      id: Date.now().toString() + Math.random(), 
      timestamp: new Date(), 
      type, 
      message 
  };
  logs.push(log);
  // Keep last 200 logs to prevent memory overflow
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(`[${type}] ${message}`);
};

// --- Background Trading Loop ---
const runTradingLoop = async () => {
    // 1. Fetch Data
    try {
        marketData = await okxService.fetchMarketData(config);
        accountData = await okxService.fetchAccountData(config);
    } catch (e: any) {
        if (isRunning) addLog('ERROR', `数据同步失败: ${e.message}`);
        return;
    }

    if (!isRunning) return;

    // 2. AI Analysis Logic
    const now = Date.now();

    // Determine interval based on position status
    // Default to 3 minutes (180000ms) for empty position
    // If holding position, switch to 1 minute (60000ms)
    let intervalMs = 180000; 

    if (accountData) {
        const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
        // Check if position exists and size > 0 (absolute value check implies holding)
        if (primaryPosition && parseFloat(primaryPosition.pos) > 0) {
            intervalMs = 60000;
        }
    }

    if (now - lastAnalysisTime < intervalMs) return;

    // Use setTimeout instead of setImmediate to avoid TS errors
    setTimeout(async () => {
        try {
            lastAnalysisTime = now;
            addLog('INFO', `正在调用云端战神引擎... (当前频率: ${intervalMs/1000}秒/次)`);
            
            if (!marketData || !accountData) return;

            // Updated to use deepseekApiKey
            const decision = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData);
            
            // Timestamp and Store History
            decision.timestamp = Date.now();
            latestDecision = decision;
            decisionHistory.unshift(decision);
            // Keep last 1000 items in memory
            if (decisionHistory.length > 1000) decisionHistory = decisionHistory.slice(0, 1000);
            
            const conf = decision.trading_decision?.confidence || "0%";
            addLog('INFO', `[${decision.stage_analysis.substring(0, 10)}..] 决策: ${decision.action} (置信度 ${conf})`);

            // Find main position for management
            const primaryPosition = accountData?.positions.find(p => p.instId === INSTRUMENT_ID);

            // Execute Actions
            if (decision.action === 'UPDATE_TPSL') {
                 // Capture local reference for type narrowing
                 if (primaryPosition) {
                    const newSL = decision.trading_decision.stop_loss;
                    const newTP = decision.trading_decision.profit_target;
                    
                    const isValid = (p: string) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0;
                    
                    if (isValid(newSL) || isValid(newTP)) {
                        // Ensure strict type check against 'net' to allow TS to narrow posSide to 'long' | 'short'
                        if (primaryPosition.posSide === 'net') {
                             addLog('WARNING', '单向持仓模式不支持自动更新止损/止盈');
                        } else {
                            try {
                                const res = await okxService.updatePositionTPSL(
                                    INSTRUMENT_ID, 
                                    primaryPosition.posSide, 
                                    primaryPosition.pos, 
                                    isValid(newSL) ? newSL : undefined,
                                    isValid(newTP) ? newTP : undefined,
                                    config
                                );
                                addLog('SUCCESS', `云端止损更新: ${res.msg}`);
                            } catch(err: any) {
                                addLog('ERROR', `更新止损失败: ${err.message}`);
                            }
                        }
                    }
                 }
            } else if (decision.action !== 'HOLD') {
                try {
                    const res = await okxService.executeOrder(decision, config);
                    addLog('TRADE', `执行订单: ${decision.action} ${decision.size} 张. 结果: ${res.msg}`);
                } catch(err: any) {
                    addLog('ERROR', `订单执行失败: ${err.message}`);
                }
            }

            // Rolling Logic
            if (decision.action === 'HOLD' && primaryPosition) {
                const uplRatio = parseFloat(primaryPosition.uplRatio) * 100;
                if (uplRatio >= 50) {
                     addLog('SUCCESS', `触发自动滚仓: 收益率 ${uplRatio.toFixed(2)}%`);
                     try {
                         await okxService.addMargin({
                            instId: INSTRUMENT_ID,
                            posSide: primaryPosition.posSide,
                            type: 'add',
                            amt: (parseFloat(primaryPosition.upl) * 0.5).toFixed(2)
                         }, config);
                         addLog('TRADE', '滚仓成功');
                     } catch(e: any) {
                         addLog('ERROR', `滚仓失败: ${e.message}`);
                     }
                }
            }

        } catch (e: any) {
            addLog('ERROR', `策略执行异常: ${e.message}`);
        }
    }, 0);
};

// Start Loop
// Check loop condition every 5 seconds (must be smaller than analysis interval)
setInterval(runTradingLoop, 5000);

// --- API Endpoints ---

app.get('/api/status', (req, res) => {
    res.json({
        isRunning,
        config: { ...config, okxSecretKey: '***', okxPassphrase: '***', deepseekApiKey: '***' }, // Hide sensitive
        marketData,
        accountData,
        latestDecision,
        logs
    });
});

app.get('/api/history', (req, res) => {
    const now = Date.now();
    // 1 Hour in milliseconds
    const oneHour = 60 * 60 * 1000;
    
    // Recent 1 hour reports
    const recent = decisionHistory.filter(d => (d.timestamp || 0) > now - oneHour);
    
    // Last 50 NON-HOLD reports
    const actions = decisionHistory.filter(d => d.action !== 'HOLD').slice(0, 50);
    
    res.json({ recent, actions });
});

app.post('/api/config', (req, res) => {
    const newConfig = req.body;
    // Merge logic
    config = {
        ...config,
        ...newConfig,
        // Keep old secrets if sending masked version
        okxSecretKey: newConfig.okxSecretKey === '***' ? config.okxSecretKey : newConfig.okxSecretKey,
        okxPassphrase: newConfig.okxPassphrase === '***' ? config.okxPassphrase : newConfig.okxPassphrase,
        deepseekApiKey: newConfig.deepseekApiKey === '***' ? config.deepseekApiKey : newConfig.deepseekApiKey,
    };
    addLog('INFO', '配置已通过 Web 更新');
    res.json({ success: true });
});

app.post('/api/toggle', (req, res) => {
    const { running } = req.body;
    isRunning = running;
    addLog('INFO', isRunning ? '>>> 策略引擎已启动 <<<' : '>>> 策略引擎已暂停 <<<');
    res.json({ success: true, isRunning });
});

// Serve React App
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    addLog('INFO', `系统初始化完成，等待指令...`);
});
