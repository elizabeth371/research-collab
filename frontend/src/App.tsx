import { useCallback, useEffect, useRef, useState } from 'react';
import { CollaborativeEditor } from './components/Editor/CollaborativeEditor';
import { AgentPanel } from './components/Agent/AgentPanel';
import { WatermarkPanel } from './components/Watermark/WatermarkPanel';
import { ProvenancePanel } from './components/Provenance/ProvenancePanel';
import { LiteraturePanel } from './components/Literature/LiteraturePanel';
import { fetchBootstrap, createDocument, updateDocument, exportDocument } from './lib/api';
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
      <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-3">
          <div className="text-4xl animate-pulse">📝</div>
          <div className="text-sm text-gray-500">
            {backendOk === false
              ? '后端服务未启动 · 请先运行 uvicorn main:app --port 8000'
              : '正在连接智溯协同系统...'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 text-gray-900">
      {/* ======== 顶栏 ======== */}
      <header className="h-14 flex items-center gap-4 px-5 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center text-white text-sm font-bold shadow-sm">
            智溯
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold text-gray-800">
              智溯 · 多智能体科研协同编辑
            </h1>
            <p className="text-[10px] text-gray-400">
              Multi-Agent Collaboration & AIGC Provenance
            </p>
          </div>
        </div>

        {/* 文档切换 + 新建 */}
        <div className="flex items-center gap-2 ml-6 min-w-0">
          <select
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            className="text-xs border border-gray-300 rounded-md px-2.5 py-1.5 bg-white max-w-56 focus:outline-none focus:ring-2 focus:ring-blue-200"
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
            className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors whitespace-nowrap"
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
            className="text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {uploading ? '上传中...' : '⬆️ 上传文档'}
          </button>
          <button
            onClick={handleExportDoc}
            disabled={exporting || !currentDoc}
            title="导出为 Markdown (含溯源元数据)"
            className="text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {exporting ? '导出中...' : '⬇️ 导出 Markdown'}
          </button>
        </div>

        {/* 状态指示 */}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-gray-400 hidden lg:inline">
            {currentDoc ? `最近更新 ${new Date(currentDoc.updatedAt).toLocaleString('zh-CN')}` : ''}
          </span>
          <span className="text-xs text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
            👤 {username}
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
        <aside className="w-80 shrink-0 flex flex-col bg-white border-l border-gray-200">
          <div className="flex border-b border-gray-200">
            {(
              [
                ['watermark', '🛡️ 水印检测'],
                ['provenance', '🔗 溯源链'],
                ['literature', '📚 文献检索'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setRightTab(key)}
                className={`flex-1 text-xs py-3 font-medium transition-colors ${
                  rightTab === key
                    ? 'text-indigo-600 border-b-2 border-indigo-500 bg-indigo-50/40'
                    : 'text-gray-400 hover:text-gray-600'
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
