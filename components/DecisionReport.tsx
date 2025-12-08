
import React from 'react';
import { AIDecision } from '../types';
import { Activity, Flame, TrendingUp, Zap, Target, AlertCircle } from 'lucide-react';

interface Props {
  decision: AIDecision;
}

const DecisionReport: React.FC<Props> = ({ decision }) => {
  return (
    <div className="p-6 overflow-y-auto space-y-6 font-mono text-sm leading-relaxed text-gray-300 h-full custom-scrollbar">
        <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-purple-400 font-bold uppercase tracking-wider text-xs">
                <Activity size={14}/> 01. 资金阶段分析
            </h4>
            <div className="p-4 bg-gray-900/50 border border-purple-500/20 rounded-lg shadow-inner">
                {decision.stage_analysis}
            </div>
        </div>

        <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-orange-400 font-bold uppercase tracking-wider text-xs">
                <Flame size={14}/> 02. 实时热点情报
            </h4>
            <div className="p-4 bg-gray-900/50 border border-orange-500/20 rounded-lg text-orange-50">
                {decision.hot_events_overview}
            </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
                    <h4 className="flex items-center gap-2 text-blue-400 font-bold uppercase tracking-wider text-xs">
                    <TrendingUp size={14}/> 03. 市场整体评估
                    </h4>
                    {/* Added whitespace-pre-wrap to respect newlines in market_assessment */}
                    <div className="p-4 bg-gray-900/50 border border-blue-500/20 rounded-lg h-full whitespace-pre-wrap">
                    {decision.market_assessment}
                    </div>
            </div>
            <div className="space-y-2">
                    <h4 className="flex items-center gap-2 text-indigo-400 font-bold uppercase tracking-wider text-xs">
                    <Zap size={14}/> 04. ETH 专项分析
                    </h4>
                    <div className="p-4 bg-gray-900/50 border border-indigo-500/20 rounded-lg h-full">
                    {decision.eth_analysis}
                    </div>
            </div>
        </div>

        <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-yellow-400 font-bold uppercase tracking-wider text-xs">
                <Target size={14}/> 05. 最终决策推理
            </h4>
            <div className="p-4 bg-gray-900/50 border border-yellow-500/20 rounded-lg border-l-4 border-l-yellow-500">
                {decision.reasoning}
            </div>
        </div>

        <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-red-400 font-bold uppercase tracking-wider text-xs">
                <AlertCircle size={14}/> 06. 策略失效条件
            </h4>
            <div className="p-3 bg-red-900/10 border border-red-500/20 rounded text-red-300">
                {decision.trading_decision?.invalidation_condition}
            </div>
        </div>
    </div>
  );
};

export default DecisionReport;
