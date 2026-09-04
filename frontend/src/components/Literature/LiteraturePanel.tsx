import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import {
  searchLiterature,
  type LiteratureSearchResponse,
  type SearchPaper,
} from '../../lib/api';
import { appendText } from '../../lib/yjs';
import { getCollabSession } from '../../lib/collab';

/**
 * 文献检索面板 (联网搜索)
 * ------------------------------------------------------------------
 * 功能:
 *  1. 关键词联网检索文献 (后端 arXiv 优先, 失败自动降级本地文献库,
 *     统一返回标准化信封 {status, message, data[]})
 *  2. 点击「搜索」后按钮立即禁用并显示 "搜索中..." (含加载动画)
 *  3. status=success -> 渲染文献卡片; status=error -> 红色字体显示 message
 *  4. 每条文献带复选框; 列表底部「确认选中的文献」按钮初始禁用,
 *     至少勾选一篇后才可点击; 点击后按所选顺序批量插入引文到文档末尾
 */

interface LiteraturePanelProps {
  docId: string;
  ydoc: Y.Doc;
}

/** 引用块格式: 作者. 标题. 来源. 链接 */
function buildCitationBlock(item: SearchPaper): string {
  const authors = (item.authors ?? []).join(', ');
  const title = item.title || '(无标题)';
  const source = item.source || '';
  const url = item.url || '';
  const parts = [authors && `${authors}.`, title, source && `${source}.`, url]
    .filter(Boolean)
    .join(' ');
  return `【引用】${parts}`;
}

export function LiteraturePanel({ docId, ydoc }: LiteraturePanelProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchPaper[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [confirmed, setConfirmed] = useState<string[]>([]);

  // 初始加载最近文献 (空关键词 -> 后端返回本地库最近入库)
  useEffect(() => {
    searchLiterature('')
      .then((res) => {
        if (res.status === 'success' && res.data) {
          setItems(res.data);
        }
      })
      .catch(() => setError('文献库加载失败'));
  }, []);

  const handleSearch = async () => {
    const keyword = query.trim();
    if (!keyword) return;
    setLoading(true); // 禁用按钮并显示 "搜索中..."
    setError(null);
    setNotice(null);
    setConfirmed([]);
    try {
      const res: LiteratureSearchResponse = await searchLiterature(keyword);
      if (res.status === 'success') {
        const data = res.data ?? [];
        setItems(data);
        setNotice(data.length > 0 ? res.message || null : null);
        if (data.length === 0) {
          setNotice('未找到相关文献，请更换关键词');
        }
      } else {
        setError(res.message || '检索失败');
        setItems([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '检索失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleCheck = (id: string) => {
    setConfirmed((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleConfirm = async () => {
    const selected = items.filter((item) => confirmed.includes(item.id));
    if (selected.length === 0) return;
    setInserting(true);
    setError(null);
    try {
      const editor = getCollabSession(docId).editor;
      const blocks = selected.map((item) => buildCitationBlock(item));
      let allOk = true;
      for (const block of blocks) {
        const ok = appendText(editor, ydoc, block, 'human');
        if (!ok) allOk = false;
      }
      if (!allOk) {
        setError('编辑器未就绪, 部分引文插入失败');
      } else {
        setConfirmed([]);
        setNotice(`已确认 ${selected.length} 篇文献并插入到文档末尾`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入失败');
    } finally {
      setInserting(false);
    }
  };

  const isSelected = (id: string) => confirmed.includes(id);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="panel-title text-sm">文献检索</h3>
        <p className="text-[11px] text-slate-400 mt-0.5">
          联网检索 arXiv · 失败自动降级本地文献库
        </p>
      </div>

      {/* 检索输入 */}
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !loading && handleSearch()}
          placeholder="关键词, 如水印 / CRDT / 多Agent..."
          className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-50 transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
        >
          {loading && (
            <span className="inline-block w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          )}
          {loading ? '搜索中...' : '搜索'}
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      {notice && !error && (
        <div className="text-[11px] text-slate-500 bg-slate-50 rounded px-2 py-1.5">
          {notice}
        </div>
      )}

      {/* 检索结果 */}
      <div className="space-y-2.5">
        {items.length === 0 && !loading && (
          <p className="text-[11px] text-slate-400 text-center py-4">
            暂无文献, 输入关键词联网检索
          </p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className={`rounded-lg border p-3 space-y-1.5 transition-colors ${
              isSelected(item.id)
                ? 'border-accent bg-accent/5'
                : 'border-slate-200 bg-slate-50/60'
            }`}
          >
            <div className="flex items-start gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer pt-0.5">
                <input
                  type="checkbox"
                  checked={isSelected(item.id)}
                  onChange={() => toggleCheck(item.id)}
                  className="w-3.5 h-3.5 accent-accent"
                />
              </label>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-slate-800 leading-snug">
                  {item.title}
                </div>
                <div className="text-[10px] text-slate-400">
                  {(item.authors ?? []).join('、') || '佚名'}
                  {item.published_date ? ` · ${item.published_date}` : ''} ·{' '}
                  {item.source}
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-3">
                  {item.abstract}
                </p>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-accent hover:underline block truncate"
                  >
                    {item.url}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 确认选中的文献 */}
      {items.length > 0 && (
        <div className="flex items-center justify-between pt-1 border-t border-slate-200">
          <span className="text-[11px] text-slate-500">
            已选 {confirmed.length} 篇
          </span>
          <button
            onClick={handleConfirm}
            disabled={confirmed.length === 0 || inserting}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity whitespace-nowrap"
          >
            {inserting ? '插入中...' : '确认选中的文献'}
          </button>
        </div>
      )}
    </div>
  );
}
