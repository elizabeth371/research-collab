import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { searchLiterature, getCitation, type LiteratureItem } from '../../lib/api';
import { appendText } from '../../lib/yjs';
import { getCollabSession } from '../../lib/collab';

/**
 * 文献检索面板
 * ------------------------------------------------------------------
 * 功能:
 *  1. 关键词检索文献语料库 (后端 literature 表)
 *  2. 展示标题 / 作者 / 年份 / 来源 / 摘要
 *  3. 一键将 GB/T 7714 引文插入协作文档末尾 (标记为人类输入)
 */
interface LiteraturePanelProps {
  docId: string;
  ydoc: Y.Doc;
}

export function LiteraturePanel({ docId, ydoc }: LiteraturePanelProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LiteratureItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState<string | null>(null);

  // 初始加载最近文献
  useEffect(() => {
    searchLiterature('')
      .then(setItems)
      .catch(() => setError('文献库加载失败'));
  }, []);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await searchLiterature(query);
      setItems(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  const handleInsert = async (item: LiteratureItem) => {
    setInserting(item.id);
    try {
      const { citation } = await getCitation(item.id);
      const ok = appendText(
        getCollabSession(docId).editor,
        ydoc,
        `【引用】${citation}`,
        'human'
      );
      if (!ok) {
        setError('编辑器未就绪, 插入失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入失败');
    } finally {
      setInserting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="panel-title text-sm">文献检索</h3>
        <p className="text-[11px] text-slate-400 mt-0.5">
          调研语料库 · 支持一键插入引文到文档
        </p>
      </div>

      {/* 检索输入 */}
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="关键词, 如水印 / CRDT / 多Agent..."
          className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 transition-colors whitespace-nowrap"
        >
          {loading ? '检索中...' : '检索'}
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      {/* 检索结果 */}
      <div className="space-y-2.5">
        {items.length === 0 && !loading && (
          <p className="text-[11px] text-slate-400 text-center py-4">
            暂无文献, 输入关键词检索
          </p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-1.5"
          >
            <div className="text-xs font-medium text-slate-800 leading-snug">
              {item.title}
            </div>
            <div className="text-[10px] text-slate-400">
              {item.authors} · {item.year || '未知年份'} · {item.source}
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-3">
              {item.abstract}
            </p>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-300 truncate max-w-[55%]">
                {item.keywords}
              </span>
              <button
                onClick={() => handleInsert(item)}
                disabled={inserting === item.id}
                className="text-[11px] px-2 py-1 rounded bg-white border border-accent/40 text-accent hover:bg-accent/5 disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                {inserting === item.id ? '插入中...' : '插入引用'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
