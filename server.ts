
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
let latestDecisions: Record<string, AIDecision> = {};
let decisionHistory: AIDecision[] = []; 
let logs: SystemLog[] = [];
let lastAnalysisTime = 0;
let isProcessing = false;

// --- Cleanup State ---
let previousActiveInstIds: Set<string> = new Set();
let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 30 * 1000; // Increased frequency (30s)

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

const runTradingLoop = async () => {
    if (isProcessing) return;
    isProcessing = true;
    try {
        try {
            marketData = await okxService.fetchMarketData(config);
            accountData = await okxService.fetchAccountData(config);
        } catch (e: any) {
            if (isRunning) addLog('ERROR', `数据获取异常: ${e.message}`);
            return;
        }

        // --- ORPHANED ORDER CLEANUP (GHOST PROTECTOR) ---
        if (accountData && !config.isSimulation) {
            const currentActiveInstIds = new Set(
                accountData.positions
                .filter(p => parseFloat(p.pos) > 0)
                .map(p => p.instId)
            );

            // 1. Transition-based Cleanup (Triggered immediately after position goes to 0)
            for (const instId of previousActiveInstIds) {
                if (!currentActiveInstIds.has(instId)) {
                    addLog('INFO', `检测到 [${instId}] 仓位已清理，正在抹除残留的移动止盈委托...`);
                    const count = await okxService.checkAndCancelOrphanedAlgos(instId, config);
                    if (count > 0) addLog('SUCCESS', `已清理 [${instId}] 残留委托: ${count}个`);
                }
            }
            previousActiveInstIds = currentActiveInstIds;

            // 2. Continuous Guard (Garbage Collection)
            if (Date.now() - lastCleanupTime > CLEANUP_INTERVAL) {
                lastCleanupTime = Date.now();
                const allPossibleInstIds = Object.values(COIN_CONFIG).map(c => c.instId);
                for (const instId of allPossibleInstIds) {
                    if (!currentActiveInstIds.has(instId)) {
                         // Check every inactive coin to ensure no dangling reduceOnly orders exist
                         await okxService.checkAndCancelOrphanedAlgos(instId, config);
                    }
                }
            }
        }

        if (!isRunning) return;
        const now = Date.now();
        let intervalMs = 180000; 
        if (accountData && accountData.positions.length > 0) {
            const hasActivePos = accountData.positions.some(p => parseFloat(p.pos) > 0);
            if (hasActivePos) intervalMs = 60000;
        }
        if (now - lastAnalysisTime < intervalMs) return;
        lastAnalysisTime = now;
        
        if (!marketData || !accountData) return;
        const decisions = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData, logs);
        for (const decision of decisions) {
            decision.timestamp = Date.now();
            latestDecisions[decision.coin] = decision;
            decisionHistory.unshift(decision);
            if (decisionHistory.length > 1000) decisionHistory = decisionHistory.slice(0, 1000);
            const position = accountData.positions.find(p => p.instId === decision.instId);
            if (decision.action === 'UPDATE_TPSL') {
                if (position) {
                    const newSL = decision.trading_decision.stop_loss;
                    const isValid = (p: string) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0;
                    if (isValid(newSL)) {
                        try {
                            const res = await okxService.updatePositionTPSL(decision.instId, position.posSide as 'long' | 'short', position.pos, newSL, undefined, config);
                            addLog('SUCCESS', `[${decision.coin}] 风控移动: ${res.msg}`);
                        } catch(err: any) {
                            addLog('ERROR', `[${decision.coin}] 风控更新失败: ${err.message}`);
                        }
                    }
                }
            } else if (decision.action !== 'HOLD') {
                try {
                    const res = await okxService.executeOrder(decision, config);
                    addLog('TRADE', `[${decision.coin}] 动作: ${decision.action} ${decision.size}张. 结果: ${res.msg}`);
                } catch(err: any) {
                    addLog('ERROR', `[${decision.coin}] 下单失败: ${err.message}`);
                }
            }
        }
    } catch (e: any) {
        addLog('ERROR', `Loop Panic: ${e.message}`);
    } finally {
        isProcessing = false;
    }
};

setInterval(runTradingLoop, 5000);

app.get('/api/status', (req, res) => {
    res.json({ isRunning, config: { ...config, okxSecretKey: '***', okxPassphrase: '***', deepseekApiKey: '***' }, marketData, accountData, latestDecisions, logs });
});

app.get('/api/history', (req, res) => {
    const now = Date.now();
    const actions = decisionHistory.filter(d => d.action !== 'HOLD').slice(0, 50);
    res.json({ recent: decisionHistory.slice(0, 50), actions });
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
    addLog('INFO', '配置变更已应用');
    res.json({ success: true });
});

app.post('/api/toggle', (req, res) => {
    const { running } = req.body;
    isRunning = running;
    addLog('INFO', isRunning ? '>>> 引擎开启 <<<' : '>>> 引擎休眠 <<<');
    res.json({ success: true, isRunning });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server on ${PORT}`);
    addLog('INFO', '系统冷启动完成，正在监控行情...');
});
