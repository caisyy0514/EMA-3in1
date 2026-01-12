
import React, { useState } from 'react';
import { AppConfig } from '../types';
import { X, Save, AlertTriangle, Activity, CheckCircle, AlertCircle, Coins } from 'lucide-react';
import { testConnection } from '../services/aiService';
import { COIN_CONFIG } from '../constants';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onSave: (cfg: AppConfig) => void;
}

const SettingsModal: React.FC<Props> = ({ isOpen, onClose, config, onSave }) => {
  const [localConfig, setLocalConfig] = useState<AppConfig>(config);
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    setTestStatus('loading');
    setTestMsg('正在连接 DeepSeek API...');
    try {
      const res = await testConnection(localConfig.deepseekApiKey);
      setTestStatus('success');
      setTestMsg(`连接成功! 响应: ${res.substring(0, 20)}...`);
    } catch (e: any) {
      setTestStatus('error');
      setTestMsg(`连接失败: ${e.message}`);
    }
  };

  const toggleCoin = (coin: string) => {
    const current = localConfig.enabledCoins || [];
    if (current.includes(coin)) {
      setLocalConfig({ ...localConfig, enabledCoins: current.filter(c => c !== coin) });
    } else {
      setLocalConfig({ ...localConfig, enabledCoins: [...current, coin] });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-okx-card border border-okx-border rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center p-6 border-b border-okx-border shrink-0">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            系统设置
          </h2>
          <button onClick={onClose} className="text-okx-subtext hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
          {/* Simulation Toggle */}
          <div className="flex items-center justify-between bg-okx-bg p-4 rounded-lg border border-okx-border">
            <div>
              <div className="text-white font-medium">模拟交易模式 (Simulation)</div>
              <div className="text-sm text-okx-subtext">开启后使用生成数据，不连接真实交易所。</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={localConfig.isSimulation}
                onChange={e => setLocalConfig({...localConfig, isSimulation: e.target.checked})}
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-okx-primary"></div>
            </label>
          </div>

          {/* Coin Admission Selector */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-okx-subtext flex items-center gap-2">
                <Coins size={14} /> 交易币种准入开关 (控制新开仓/滚仓)
            </label>
            <div className="grid grid-cols-2 gap-2">
                {Object.keys(COIN_CONFIG).map(coin => {
                    const isEnabled = (localConfig.enabledCoins || []).includes(coin);
                    return (
                        <button
                            key={coin}
                            onClick={() => toggleCoin(coin)}
                            className={`flex items-center justify-between px-3 py-2 rounded border transition-all ${
                                isEnabled 
                                ? 'bg-okx-primary/10 border-okx-primary text-white' 
                                : 'bg-gray-800/30 border-okx-border text-okx-subtext grayscale'
                            }`}
                        >
                            <span className="text-xs font-bold">{coin}</span>
                            <div className={`w-2 h-2 rounded-full ${isEnabled ? 'bg-okx-up animate-pulse' : 'bg-gray-600'}`}></div>
                        </button>
                    )
                })}
            </div>
            <p className="text-[10px] text-okx-subtext italic">* 禁用币种将停止开新仓，但系统会继续管理已持有的存量仓位直至平仓。</p>
          </div>

          {/* DeepSeek Key */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-okx-subtext">DeepSeek API Key (用于智能决策)</label>
            <div className="flex gap-2">
                <input 
                type="password"
                className="flex-1 bg-okx-bg border border-okx-border rounded px-3 py-2 text-white focus:outline-none focus:border-okx-primary"
                value={localConfig.deepseekApiKey}
                onChange={e => setLocalConfig({...localConfig, deepseekApiKey: e.target.value})}
                placeholder="sk-..."
                />
                <button 
                  onClick={handleTestConnection}
                  disabled={testStatus === 'loading' || !localConfig.deepseekApiKey}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-50"
                  title="测试 API 连接"
                >
                   <Activity size={18} />
                </button>
            </div>
             {/* Test Status Feedback */}
             {testStatus !== 'idle' && (
                <div className={`text-xs flex items-center gap-1 mt-1 ${
                    testStatus === 'success' ? 'text-green-400' : 
                    testStatus === 'error' ? 'text-red-400' : 'text-blue-400'
                }`}>
                    {testStatus === 'success' && <CheckCircle size={12}/>}
                    {testStatus === 'error' && <AlertCircle size={12}/>}
                    {testMsg}
                </div>
            )}
          </div>

          {/* OKX Keys */}
          {!localConfig.isSimulation && (
            <div className="space-y-4 border-t border-okx-border pt-4">
              <div className="flex items-center gap-2 text-yellow-500 bg-yellow-500/10 p-2 rounded text-sm">
                <AlertTriangle size={16} />
                <span>真实交易需配置 OKX V5 API Keys (注意CORS限制)</span>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-okx-subtext">OKX API Key</label>
                <input 
                  type="password"
                  className="w-full bg-okx-bg border border-okx-border rounded px-3 py-2 text-white focus:outline-none focus:border-okx-primary"
                  value={localConfig.okxApiKey}
                  onChange={e => setLocalConfig({...localConfig, okxApiKey: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-okx-subtext">OKX Secret Key</label>
                <input 
                  type="password"
                  className="w-full bg-okx-bg border border-okx-border rounded px-3 py-2 text-white focus:outline-none focus:border-okx-primary"
                  value={localConfig.okxSecretKey}
                  onChange={e => setLocalConfig({...localConfig, okxSecretKey: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-okx-subtext">Passphrase</label>
                <input 
                  type="password"
                  className="w-full bg-okx-bg border border-okx-border rounded px-3 py-2 text-white focus:outline-none focus:border-okx-primary"
                  value={localConfig.okxPassphrase}
                  onChange={e => setLocalConfig({...localConfig, okxPassphrase: e.target.value})}
                />
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-okx-border flex justify-end shrink-0">
          <button 
            onClick={() => onSave(localConfig)}
            className="flex items-center gap-2 bg-okx-primary hover:bg-blue-600 text-white px-6 py-2 rounded font-medium transition-colors"
          >
            <Save size={18} />
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
