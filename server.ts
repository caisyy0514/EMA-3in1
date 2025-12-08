
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { MarketDataCollection, AccountContext, AIDecision, SystemLog, AppConfig } from './types';
import { DEFAULT_CONFIG, COIN_CONFIG } from './constants';
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
// Store latest decision per coin
let latestDecisions: Record<string, AIDecision> = {};
let decisionHistory: AIDecision[] = []; 
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

    // Determine interval: 3m default, 1m if ANY position exists
    let intervalMs = 180000; 
    if (accountData && accountData.positions.length > 0) {
        // If any position size > 0, speed up
        const hasActivePos = accountData.positions.some(p => parseFloat(p.pos) > 0);
        if (hasActivePos) intervalMs = 60000;
    }

    if (now - lastAnalysisTime < intervalMs) return;

    // Use setTimeout to run async logic
    setTimeout(async () => {
        try {
            lastAnalysisTime = now;
            addLog('INFO', `正在调用云端战神引擎 (多币种并行)... 频率: ${intervalMs/1000}s`);
            
            if (!marketData || !accountData) return;

            // Analyze ALL coins
            const decisions = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData);
            
            // Process Each Decision
            for (const decision of decisions) {
                // Update State
                decision.timestamp = Date.now();
                latestDecisions[decision.coin] = decision; // Map by coin
                
                decisionHistory.unshift(decision);
                if (decisionHistory.length > 1000) decisionHistory = decisionHistory.slice(0, 1000);
                
                const conf = decision.trading_decision?.confidence || "0%";
                addLog('INFO', `[${decision.coin}] 决策: ${decision.action} (${conf})`);

                // Find specific position for this coin
                const position = accountData.positions.find(p => p.instId === decision.instId);

                // Execute Actions
                if (decision.action === 'UPDATE_TPSL') {
                    if (position) {
                        const newSL = decision.trading_decision.stop_loss;
                        const newTP = decision.trading_decision.profit_target;
                        const isValid = (p: string) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0;
                        
                        if (isValid(newSL) || isValid(newTP)) {
                            if (position.posSide === 'net') {
                                addLog('WARNING', `[${decision.coin}] 单向持仓模式不支持自动更新止损`);
                            } else {
                                try {
                                    const res = await okxService.updatePositionTPSL(
                                        decision.instId, 
                                        position.posSide, 
                                        position.pos, 
                                        isValid(newSL) ? newSL : undefined,
                                        isValid(newTP) ? newTP : undefined,
                                        config
                                    );
                                    addLog('SUCCESS', `[${decision.coin}] 止损更新: ${res.msg}`);
                                } catch(err: any) {
                                    addLog('ERROR', `[${decision.coin}] 更新止损失败: ${err.message}`);
                                }
                            }
                        }
                    }
                } else if (decision.action !== 'HOLD') {
                    try {
                        const res = await okxService.executeOrder(decision, config);
                        addLog('TRADE', `[${decision.coin}] 执行: ${decision.action} ${decision.size} 张. 结果: ${res.msg}`);
                    } catch(err: any) {
                        addLog('ERROR', `[${decision.coin}] 订单失败: ${err.message}`);
                    }
                }

                // Rolling Logic
                if (decision.action === 'HOLD' && position) {
                    const uplRatio = parseFloat(position.uplRatio) * 100;
                    if (uplRatio >= 50) { // Safety check, prompt said 5% profit, usually calculated relative to Margin or Equity? Prompt said "5% Profit". Logic in AI service sets ACTION to BUY if 5% equity gain. This block is for extra margin? 
                         // Wait, previous implementation had this separate rolling logic. 
                         // The prompt says "Profit 5% then add 5%". This is handled in AI Service now returning 'BUY'.
                         // We can remove this separate rolling block or keep it as a backup for margin addition if not adding size?
                         // AI Service logic: "if (upl >= profitThreshold) finalAction = BUY". This executes executeOrder above.
                         // So we don't need double logic. I'll comment this out to avoid double execution or conflicts, relying on AI Service decision 'BUY'.
                         // addLog('INFO', `[${decision.coin}] 收益率 ${uplRatio.toFixed(2)}% - 滚仓由AI决策触发`);
                    }
                }
            }

        } catch (e: any) {
            addLog('ERROR', `策略执行异常: ${e.message}`);
        }
    }, 0);
};

// Start Loop
setInterval(runTradingLoop, 5000);

// --- API Endpoints ---

app.get('/api/status', (req, res) => {
    res.json({
        isRunning,
        config: { ...config, okxSecretKey: '***', okxPassphrase: '***', deepseekApiKey: '***' },
        marketData,
        accountData,
        latestDecisions, // Return map
        logs
    });
});

app.get('/api/history', (req, res) => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const recent = decisionHistory.filter(d => (d.timestamp || 0) > now - oneHour);
    const actions = decisionHistory.filter(d => d.action !== 'HOLD').slice(0, 50);
    res.json({ recent, actions });
});

app.post('/api/config', (req, res) => {
    const newConfig = req.body;
    config = {
        ...config,
        ...newConfig,
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    addLog('INFO', `系统初始化完成 (支持币种: ${Object.keys(COIN_CONFIG).join(', ')})`);
});
