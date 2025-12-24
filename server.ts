
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
const CLEANUP_INTERVAL = 15 * 1000; 

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
        // 每 5 秒更新一次基础行情，确保 UI 实时性
        try {
            marketData = await okxService.fetchMarketData(config);
            accountData = await okxService.fetchAccountData(config);
        } catch (e: any) {
            if (isRunning) addLog('ERROR', `数据获取异常: ${e.message}`);
            return;
        }

        // --- 幽灵单审计逻辑 ---
        if (accountData && !config.isSimulation) {
            const currentActiveInstIds = new Set(
                accountData.positions
                .filter(p => parseFloat(p.pos) > 0)
                .map(p => p.instId)
            );

            if (Date.now() - lastCleanupTime > CLEANUP_INTERVAL) {
                lastCleanupTime = Date.now();
                const allPossibleInstIds = Object.values(COIN_CONFIG).map(c => c.instId);
                let totalFound = 0;
                let auditedCoins: string[] = [];

                for (const instId of allPossibleInstIds) {
                    const coinName = Object.keys(COIN_CONFIG).find(k => COIN_CONFIG[k].instId === instId) || instId;
                    auditedCoins.push(coinName);
                    if (!currentActiveInstIds.has(instId)) {
                        const purgedAlgos = await okxService.checkAndCancelOrphanedAlgos(instId, config);
                        if (purgedAlgos.length > 0) {
                            totalFound += purgedAlgos.length;
                            addLog('WARNING', `[审计] ${coinName} 发现残留订单！正在执行紧急清理...`);
                            purgedAlgos.forEach(o => {
                                addLog('INFO', `[清理] ${coinName} 订单ID: ${o.id} | 类型: ${o.type} | 触发价: ${o.triggerPx}`);
                            });
                        }
                    }
                }
                if (totalFound === 0 && auditedCoins.length > 0) {
                    console.log(`[静默审计] 账户环境洁净: ${auditedCoins.join(', ')}`);
                }
            }
        }

        if (!isRunning) return;
        const now = Date.now();
        
        /**
         * 核心优化：高频扫描频率设定
         * 空仓时：15秒扫描一次（原 180s），捕捉转瞬即逝的交叉信号
         * 持仓时：10秒扫描一次（原 60s），确保移动止损和趋势反转监控毫秒级响应
         */
        let intervalMs = 15000; 
        if (accountData && accountData.positions.length > 0) {
            const hasActivePos = accountData.positions.some(p => parseFloat(p.pos) > 0);
            if (hasActivePos) intervalMs = 10000; 
        }
        
        // 判定是否到达分析周期
        if (now - lastAnalysisTime < intervalMs) return;
        lastAnalysisTime = now;
        
        if (!marketData || !accountData) return;

        addLog('INFO', `>>> 引擎启动策略扫描 (本地算力, 周期: ${intervalMs/1000}s) <<<`);
        const decisions = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData, logs);
        
        for (const decision of decisions) {
            decision.timestamp = Date.now();
            latestDecisions[decision.coin] = decision;
            decisionHistory.unshift(decision);
            if (decisionHistory.length > 1000) decisionHistory = decisionHistory.slice(0, 1000);
            
            const position = accountData.positions.find(p => p.instId === decision.instId);
            
            // 构建详细版扫描日志
            const trendTag = decision.market_assessment.split('\n')[0].replace('【1H趋势】：', '') || '未知';
            const entryTag = decision.market_assessment.split('\n')[1]?.replace('【3m入场】：', '') || '未就绪';
            
            if (decision.action === 'HOLD') {
                // HOLD 状态静默记录到控制台，减少 UI 日志冗余，仅保留关键变动
                console.log(`[分析中][${decision.coin}] 趋势:${trendTag} | 状态:${entryTag}`);
            } else if (decision.action === 'UPDATE_TPSL') {
                addLog('TRADE', `[${decision.coin}] 策略调整: 净ROI达标，准备将止损移动至成本价 (${decision.trading_decision.stop_loss})`);
            } else {
                addLog('TRADE', `[${decision.coin}] 信号触发: ${decision.action} | 理由: ${decision.reasoning}`);
            }

            // 执行逻辑
            if (decision.action === 'UPDATE_TPSL') {
                if (position) {
                    const newSL = decision.trading_decision.stop_loss;
                    const isValid = (p: string) => p && !isNaN(parseFloat(p)) && parseFloat(p) > 0;
                    if (isValid(newSL)) {
                        try {
                            const oldSL = position.slTriggerPx || "未设置";
                            addLog('INFO', `[${decision.coin}] 同步指令: 止损由 ${oldSL} 调整为 ${newSL}`);
                            const res = await okxService.updatePositionTPSL(decision.instId, position.posSide as 'long' | 'short', position.pos, newSL, undefined, config);
                            addLog('SUCCESS', `[${decision.coin}] 交易所委托更新成功: ${res.msg}`);
                        } catch(err: any) {
                            addLog('ERROR', `[${decision.coin}] 止损更新失败: ${err.message}`);
                        }
                    }
                }
            } else if (decision.action !== 'HOLD') {
                try {
                    addLog('INFO', `[${decision.coin}] 正在向交易所发送 ${decision.action} 指令 (数量: ${decision.size})...`);
                    const res = await okxService.executeOrder(decision, config);
                    addLog('SUCCESS', `[${decision.coin}] 指令执行完毕: ${res.msg}`);
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

// 保持 5 秒一次的主循环心跳，分析周期在内部由 intervalMs 控制
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
    addLog('INFO', isRunning ? '>>> 核心引擎开启：实时监控与自动风控已激活 <<<' : '>>> 核心引擎休眠：所有自动交易逻辑已暂停 <<<');
    res.json({ success: true, isRunning });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Trading Server running on port ${PORT}`);
    addLog('INFO', 'EMA Hunter 3in1 Pro 系统初始化完毕。');
});
