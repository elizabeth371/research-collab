import { useCallback, useEffect, useState } from 'react';
import { getProvenance, verifyProvenance, type ProvenanceEntry } from '../../lib/api';

/**
 * 版权溯源面板
 * ------------------------------------------------------------------
 * 展示文档操作日志哈希链 (OpLog Chain):
 *  1. 按时间正序列出全部操作 (类型 / 摘要 / 哈希缩略)
 *  2. 一键校验链条完整性 (防篡改验证)
 */

const OP_TYPE_META: Record<string, { label: string; cls: string }> = {
  insert: { label: '插入', cls: 'bg-slate-100 text-slate-600' },
  delete: { label: '删除', cls: 'bg-amber-50 text-amber-600' },
  replace: { label: '替换', cls: 'bg-purple-50 text-purple-600' },
  ai_generate: { label: 'AI 生成', cls: 'bg-blue-50 text-blue-600' },
  watermark_checked: { label: '水印检测', cls: 'bg-cyan-50 text-cyan-600' },
  // 步骤 12: 文档水印参数/密钥变更留痕
  watermark_params: { label: '水印参数', cls: 'bg-indigo-50 text-indigo-600' },
};

interface ProvenancePanelProps {
  docId: string;
}

export function ProvenancePanel({ docId }: ProvenancePanelProps) {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [verify, setVerify] = useState<{ valid: boolean; checked: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, v] = await Promise.all([
        getProvenance(docId),
        verifyProvenance(docId),
      ]);
      setEntries(list);
      setVerify(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载溯源链失败');
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="panel-title text-sm">版权溯源链</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            操作日志哈希链 · 防篡改审计
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 transition-colors"
        >
          {loading ? '...' : '刷新'}
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      {/* 完整性校验徽标 */}
      {verify && (
        <div
          className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs ${
            verify.valid
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          <span className="font-medium">
            {verify.valid ? '✓ 链条完整 · 未被篡改' : '✗ 检测到篡改！'}
          </span>
          <span className="text-[11px] opacity-70">{verify.checked} 条记录</span>
        </div>
      )}

      {/* 链条目列表 */}
      {entries.length === 0 && !loading && !error && (
        <div className="text-[11px] text-slate-400 text-center py-6 border border-dashed border-slate-200 rounded-lg">
          暂无操作记录
          <br />
          <span className="text-slate-300">
            编辑文档或触发 Agent 后产生审计日志
          </span>
        </div>
      )}

      <div className="space-y-2">
        {entries.map((e, i) => {
          const meta = OP_TYPE_META[e.op_type] ?? {
            label: e.op_type,
            cls: 'bg-slate-100 text-slate-600',
          };
          return (
            <div
              key={e.id}
              className="relative bg-white border border-slate-100 rounded-lg p-2.5 hover:border-slate-200 transition-colors"
            >
              {/* 链节点连线 */}
              {i < entries.length - 1 && (
                <span className="absolute left-6 -bottom-2 w-px h-2 bg-slate-200" />
              )}
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${meta.cls}`}>
                  {meta.label}
                </span>
                <span className="ml-auto text-[10px] text-slate-300">
                  {new Date(e.created_at).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-slate-400 break-all">
                hash: {e.current_hash.slice(0, 20)}...
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
