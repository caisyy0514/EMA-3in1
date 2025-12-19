
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
let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 15 * 1000; // 维持 15s 巡检

const addLog = (type: SystemLog['type'], message: string) => {
  const log: SystemLog = { 
      id: Date.now().toString() + Math.random(), 
      timestamp: new Date(), 
      type, 
      message 
  };
  logs.push(log);
  if (logs.length > 500) logs = logs.slice(-500); 
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

        // --- 强化：幽灵单地毯式清理 (GHOST BUSTER v3) ---
        if (accountData && !config.isSimulation) {
            const currentActiveInstIds = new Set(
                accountData.positions
                .filter(p => parseFloat(p.pos) > 0)
                .map(p => p.instId)
            );

            // 每 15 秒强制巡检全币种，只要没仓位就强制清空所有策略委托
            if (Date.now() - lastCleanupTime > CLEANUP_INTERVAL) {
                lastCleanupTime = Date.now();
                const allPossibleInstIds = Object.values(COIN_CONFIG).map(c => c.instId);
                
                for (const instId of allPossibleInstIds) {
                    if (!currentActiveInstIds.has(instId)) {
                        // 强制暴力清理该 instId 下所有策略单
                        const purgedAlgos = await okxService.checkAndCancelOrphanedAlgos(instId, config);
                        
                        if (purgedAlgos.length > 0) {
                            const coinName = Object.keys(COIN_CONFIG).find(k => COIN_CONFIG[k].instId === instId) || instId;
                            addLog('WARNING', `[${coinName}] 发现幽灵单！正在执行暴力清理...`);
                            purgedAlgos.forEach(o => {
                                addLog('INFO', `[${coinName}] 已清理: ID=${o.id} | 类型=${o.type} | 触发价=${o.triggerPx} | 激活价=${o.activePx}`);
                            });
                            addLog('SUCCESS', `[${coinName}] 清理完毕，共清除 ${purgedAlgos.length} 个残留委托单`);
                        }
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

        addLog('INFO', `>>> 引擎启动全币种技术扫描 (频率: ${intervalMs/1000}s) <<<`);
        const decisions = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData, logs);
        
        for (const decision of decisions) {
            decision.timestamp = Date.now();
            latestDecisions[decision.coin] = decision;
            decisionHistory.unshift(decision);
            if (decisionHistory.length > 1000) decisionHistory = decisionHistory.slice(0, 1000);
            
            const position = accountData.positions.find(p => p.instId === decision.instId);
            const logMsg = `[${decision.coin}] 状态: ${decision.action} | 分析: ${decision.reasoning}`;
            
            if (decision.action !== 'HOLD') {
                addLog('INFO', logMsg);
            } else {
                const marketBrief = decision.market_assessment.replace(/\n/g, ' ');
                addLog('INFO', `[${decision.coin}] 监控中: ${marketBrief}`);
            }

            if (decision.action === 'UPDATE_TPSL') {
                if (position) {
                    const newSL = decision.trading_decision.stop_loss;
                    const isValid = (p: string) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0;
                    if (isValid(newSL)) {
                        try {
                            const res = await okxService.updatePositionTPSL(decision.instId, position.posSide as 'long' | 'short', position.pos, newSL, undefined, config);
                            addLog('SUCCESS', `[${decision.coin}] 移动止损指令下达: ${newSL} | 结果: ${res.msg}`);
                        } catch(err: any) {
                            addLog('ERROR', `[${decision.coin}] 止损更新失败: ${err.message}`);
                        }
                    }
                }
            } else if (decision.action !== 'HOLD') {
                try {
                    addLog('INFO', `[${decision.coin}] 触发交易指令: ${decision.action} ${decision.size}张...`);
                    const res = await okxService.executeOrder(decision, config);
                    addLog('TRADE', `[${decision.coin}] 指令执行完毕: ${decision.action} 结果: ${res.msg}`);
                } catch(err: any) {
                    addLog('ERROR', `[${decision.coin}] 指令执行失败: ${err.message}`);
                }
            }
        }
    } catch (e: any) {
        addLog('ERROR', `系统运行崩溃: ${e.message}`);
    } finally {
        isProcessing = false;
    }
};

setInterval(runTradingLoop, 5000);

app.get('/api/status', (req, res) => {
    res.json({ isRunning, config: { ...config, okxSecretKey: '***', okxPassphrase: '***', deepseekApiKey: '***' }, marketData, accountData, latestDecisions, logs });
});

app.get('/api/history', (req, res) => {
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
    addLog('INFO', '交易策略配置已更新');
    res.json({ success: true });
});

app.post('/api/toggle', (req, res) => {
    const { running } = req.body;
    isRunning = running;
    addLog('INFO', isRunning ? '>>> 核心引擎开启：实时监控行情与自动风控已激活 <<<' : '>>> 核心引擎休眠：所有自动交易逻辑已暂停 <<<');
    res.json({ success: true, isRunning });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Trading Server running on port ${PORT}`);
    addLog('INFO', 'EMA 3in1 Pro 系统初始化完毕。等待 API 连接中...');
});
