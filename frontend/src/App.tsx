import { useCallback, useEffect, useRef, useState } from 'react';
import { CollaborativeEditor } from './components/Editor/CollaborativeEditor';
import { AgentPanel } from './components/Agent/AgentPanel';
import { WatermarkPanel } from './components/Watermark/WatermarkPanel';
import { ProvenancePanel } from './components/Provenance/ProvenancePanel';
import { LiteraturePanel } from './components/Literature/LiteraturePanel';
import { fetchBootstrap, createDocument, updateDocument, exportDocument, getDocument } from './lib/api';
import { disposeCollabSession, getCollabSession } from './lib/collab';
import { getPlainText } from './lib/yjs';

/**
 * 应用根组件
 * -----------------
 * 布局:
 *  ┌────────────────────────────────────────────────────────────┐
 *  │  顶栏: 品牌 / 文档切换 / 新建文档 / 在线用户                │
 *  ├──────────────┬──────────────────────────┬──────────────────┤
 *  │  AgentPanel  │   CollaborativeEditor    │ 水印检测/溯源链  │
 *  │  (左侧边栏)   │   (Yjs 协同编辑器)        │ (右侧功能面板)   │
 *  └──────────────┴──────────────────────────┴──────────────────┘
 */
interface DocSummary {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

export default function App() {
  const [username] = useState<string>(
    () => `user-${Math.random().toString(36).slice(2, 8)}`
  );
  const [userId, setUserId] = useState<string>('');
  const [docId, setDocId] = useState<string>('');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [rightTab, setRightTab] = useState<'watermark' | 'provenance' | 'literature'>('watermark');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- 初始化: 拉取演示用户与文档列表 ----
  useEffect(() => {
    fetchBootstrap()
      .then((boot) => {
        setUserId(boot.demo_user_id);
        setDocs(
          boot.documents.map((d) => ({
            id: d.id,
            title: d.title,
            content: d.content,
            updatedAt: d.updated_at,
          }))
        );
        setDocId((prev) => prev || boot.demo_doc_id);
        setBackendOk(true);
      })
      .catch(() => setBackendOk(false));
  }, []);

  // ---- 每个文档独立的 Yjs 会话 (单例缓存, 切换文档时重建) ----
  // getCollabSession 返回模块级共享的 { ydoc, provider }, 保证
  // 编辑器 / Agent 面板 / 水印面板操作同一份 CRDT 状态, 且全页面
  // 仅建立一条 WebSocket 连接 (避免 StrictMode 重复连接与 awareness 回环)。
  // 仅当 docId 就绪后才建立会话, 避免加载分支创建 /ws/ 空连接。
  const session = docId ? getCollabSession(docId) : null;
  const ydoc = session ? session.ydoc : null;

  // 切换文档时销毁旧会话 (关闭旧 WebSocket 连接)
  const docIdRef = useRef(docId);
  useEffect(() => {
    if (docIdRef.current !== docId) {
      disposeCollabSession(docIdRef.current);
      docIdRef.current = docId;
    }
  }, [docId]);

  // 切换文档时拉取最新内容并刷新列表条目:
  // 编辑器保存后 docs 状态里的 content 仍是创建时的空快照, 而切走时
  // CRDT 会话被销毁 (yjsState 未持久化), 若不刷新, 切回会拿到空内容。
  // 同时也能同步其他客户端的远端编辑。
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    getDocument(docId)
      .then((doc) => {
        if (cancelled) return;
        setDocs((prev) =>
          prev.map((d) =>
            d.id === docId
              ? { ...d, content: doc.content, updatedAt: doc.updatedAt }
              : d
          )
        );
      })
      .catch(() => {
        /* 拉取失败时保留列表快照, 编辑器仍可用 */
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const getDocText = useCallback(() => (ydoc ? getPlainText(ydoc) : ''), [ydoc]);

  const currentDoc = docs.find((d) => d.id === docId);

  const handleCreateDoc = async () => {
    if (!userId || creating) return;
    setCreating(true);
    try {
      const title = `新建科研文档 ${new Date().toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })}`;
      const doc = await createDocument({ title, ownerId: userId });
      setDocs((prev) => [
        { id: doc.id, title: doc.title, content: '', updatedAt: doc.updatedAt },
        ...prev,
      ]);
      setDocId(doc.id);
    } catch (e) {
      console.error('创建文档失败', e);
    } finally {
      setCreating(false);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!userId || uploading) return;
    if (!/\.(md|txt|markdown)$/i.test(file.name)) {
      alert('仅支持上传 .md / .txt / .markdown 纯文本文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert('文件过大（超过 2MB），请精简后再上传');
      return;
    }
    setUploading(true);
    try {
      const content = await file.text();
      const title = file.name.replace(/\.(md|txt|markdown)$/i, '');
      const doc = await createDocument({ title, ownerId: userId });
      // 内容经 PATCH 写入, 在溯源链记录一条 insert 日志 (上传导入可追溯)
      await updateDocument(doc.id, { content, operatorId: userId });
      setDocs((prev) => [
        { id: doc.id, title: doc.title, content, updatedAt: doc.updatedAt },
        ...prev,
      ]);
      setDocId(doc.id);
    } catch (e) {
      console.error('上传文档失败', e);
      alert('上传失败，请检查后端服务');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExportDoc = async () => {
    if (!currentDoc || exporting) return;
    setExporting(true);
    try {
      const md = await exportDocument(docId);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentDoc.title || 'document'}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('导出失败', e);
      alert('导出失败，请检查后端服务');
    } finally {
      setExporting(false);
    }
  };

  if (!docId || !ydoc) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <svg viewBox="0 0 64 64" className="w-12 h-12 mx-auto rounded-xl shadow-sm animate-pulse" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#1F3A5F" />
            <text x="32" y="42" fontFamily="'Songti SC','SimSun',serif" fontSize="34" fontWeight="600" fill="#FFFFFF" textAnchor="middle">智</text>
            <rect x="16" y="50" width="32" height="3" rx="1.5" fill="#3B82F6" />
          </svg>
          <div className="text-sm text-slate-500">
            {backendOk === false
              ? '后端服务未启动 · 请先运行 uvicorn main:app --port 8000'
              : '正在连接智溯协同系统...'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-50 text-slate-900">
      {/* ======== 顶栏 ======== */}
      <header className="h-14 flex items-center gap-4 px-5 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 64 64" className="w-8 h-8 rounded-lg shadow-sm" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#1F3A5F" />
            <text x="32" y="42" fontFamily="'Songti SC','SimSun',serif" fontSize="34" fontWeight="600" fill="#FFFFFF" textAnchor="middle">智</text>
            <rect x="16" y="50" width="32" height="3" rx="1.5" fill="#3B82F6" />
          </svg>
          <div className="leading-tight">
            <h1 className="font-serif text-sm font-semibold text-ink tracking-wide">
              智溯 · 多智能体科研协同编辑
            </h1>
            <p className="text-[10px] text-slate-400 tracking-wider">
              Multi-Agent Collaboration &amp; AIGC Provenance
            </p>
          </div>
        </div>

        {/* 文档切换 + 新建 */}
        <div className="flex items-center gap-2 ml-6 min-w-0">
          <select
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            className="text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-white text-slate-700 max-w-56 focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <button
            onClick={handleCreateDoc}
            disabled={creating || !userId}
            title="新建协作文档"
            className="text-xs px-3 py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            + 新建文档
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.markdown"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUploadFile(file);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !userId}
            title="上传本地 .md/.txt 文件为新文档（内容计入溯源链）"
            className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {uploading ? '上传中...' : '上传文档'}
          </button>
          <button
            onClick={handleExportDoc}
            disabled={exporting || !currentDoc}
            title="导出为 Markdown (含溯源元数据)"
            className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {exporting ? '导出中...' : '导出 Markdown'}
          </button>
        </div>

        {/* 状态指示 */}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-slate-400 hidden lg:inline">
            {currentDoc ? `最近更新 ${new Date(currentDoc.updatedAt).toLocaleString('zh-CN')}` : ''}
          </span>
          <span className="text-xs text-slate-600 bg-slate-100 px-3 py-1 rounded-full">
            {username}
          </span>
        </div>
      </header>

      {/* ======== 主体三栏 ======== */}
      <div className="flex-1 flex min-h-0">
        {/* 左: Agent 面板 */}
        <AgentPanel docId={docId} username={username} ydoc={ydoc} />

        {/* 中: 协同编辑器 */}
        <main className="flex-1 flex flex-col min-w-0 p-4">
          <CollaborativeEditor
            key={docId}
            docId={docId}
            username={username}
            ydoc={ydoc}
            initialContent={currentDoc?.content ?? ''}
            operatorId={userId}
            className="flex-1 min-h-0"
          />
        </main>

        {/* 右: 水印检测 / 溯源链 */}
        <aside className="w-80 shrink-0 flex flex-col bg-white border-l border-slate-200">
          <div className="flex border-b border-slate-200">
            {(
              [
                ['watermark', '水印检测'],
                ['provenance', '溯源链'],
                ['literature', '文献检索'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setRightTab(key)}
                className={`flex-1 text-xs py-3 font-medium transition-colors ${
                  rightTab === key
                    ? 'text-accent border-b-2 border-accent bg-accent/5'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {rightTab === 'watermark' && (
              <WatermarkPanel docId={docId} getDocText={getDocText} />
            )}
            {rightTab === 'provenance' && <ProvenancePanel docId={docId} />}
            {rightTab === 'literature' && (
              <LiteraturePanel docId={docId} ydoc={ydoc} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
