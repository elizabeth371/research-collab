import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getCollabSession } from '../../lib/collab';
import { collectAuthors, getAuthorFromDelta, getPlainText } from '../../lib/yjs';
import { updateDocument } from '../../lib/api';

/**
 * 作者标记 (author mark)
 * ----------------------
 * 将 Yjs 文本属性 `author` 映射为 ProseMirror mark。mark 名即 Yjs 属性名
 * (Tiptap Collaboration 约定), y-prosemirror 在 PM 写回事务内自动完成
 * mark <-> Yjs 属性双向映射。
 *
 * 为什么必须注册: 若 Yjs 存在未注册为 PM mark 的属性, ySyncPlugin 对
 * fragment 外部变更执行 synchronize 全量重建时无法映射该属性, 会导致
 * 文本内容被回写丢弃 (实测: 直接 format/setAttribute 后段落文本清空)。
 */
const AuthorMark = Mark.create({
  name: 'author',
  addAttributes() {
    return { author: { default: 'human' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-author]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes)];
  },
});

/**
 * 协同编辑器组件
 * ------------------------------------------------------------------
 * 功能:
 *  1. 通过 y-websocket 建立与后端 `/ws/{doc_id}` 的 CRDT 实时连接
 *  2. Tiptap + Yjs Collaboration (富文本协同编辑)
 *  3. 多光标/在线状态 (y-awareness + CollaborationCursor)
 *  4. AI/人类作者着色: 监听远程更新, 按文本 `author` 属性渲染
 *     背景色 (AI=蓝色, 人类=白色)
 * ------------------------------------------------------------------
 */

interface CollaborativeEditorProps {
  docId: string;
  username: string;
  /** 由 App 统一持有的 Yjs 文档 (供 Agent 写入 / 水印读取) */
  ydoc: Y.Doc;
  className?: string;
  /** 可选: 人类作者默认标记 (未标注作者的文本视为人类) */
  defaultAuthor?: 'human' | 'ai';
  /** 文档已保存内容 (打开文档时写入 Yjs 作为初始状态) */
  initialContent?: string;
  /** 操作者用户 ID (编辑持久化时写入溯源链日志) */
  operatorId?: string;
}

/** 作者 -> CSS class 映射 (见 index.css) */
const AUTHOR_CLASS: Record<string, string> = {
  ai: 'author-ai', // 蓝色背景
  human: 'author-human', // 白色背景
};

/**
 * 作者高亮扩展
 * -------------
 * 通过 ProseMirror Decoration 将 Yjs 文本中带 `author` 属性的区间
 * 渲染为不同背景色。decorations 不修改文档内容, 是纯粹的视图层。
 *
 * 实现要点:
 *  - 监听 `fragment.on('change')` 与 `docChanged`, 重算 decorations
 *  - 将 Y.XmlText 的 delta 区间 (带 author 属性) 换算为
 *    ProseMirror 绝对 position (基于纯文本字符偏移的近似映射)
 *
 * NOTE: 近似映射在纯段落文本场景下精确; 嵌套复杂块级结构时,
 *       建议用 Y.relativePosition 做精确双向映射 (TODO)。
 */
const AuthorHighlight = Extension.create({
  name: 'authorHighlight',

  addStorage() {
    return {
      fragment: null as Y.XmlFragment | null,
      lastDecorations: DecorationSet.empty,
      version: 0,
    };
  },

  onCreate() {
    const { ydoc } = this.options as unknown as {
      ydoc: Y.Doc;
    };
    if (ydoc) {
      this.storage.fragment = ydoc.getXmlFragment('default');
    }
  },

  addProseMirrorPlugins() {
    const ext = this;
    const pluginKey = new PluginKey('authorHighlight');

    const computeDecorations = (
      doc: any,
      fragment: Y.XmlFragment | null
    ): DecorationSet => {
      if (!fragment) return DecorationSet.empty;

      /** 获取嵌套 XML 结构中的所有 XmlText */
      const texts: Y.XmlText[] = [];
      const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
        if (node instanceof Y.XmlText) {
          texts.push(node);
        } else if (node instanceof Y.XmlElement) {
          node.forEach(walk);
        } else {
          node.forEach(walk);
        }
      };
      walk(fragment);

      const decorations: Decoration[] = [];
      // 从文档起点累计字符偏移
      let globalOffset = 0;
      const trailingOffset = (text: Y.XmlText): number => {
        const len = text.toString().length;
        return len + (len > 0 && text.toString().endsWith('\n') ? 1 : 0);
      };

      for (const text of texts) {
        const delta = text.toDelta() as Array<{
          insert: string;
          attributes?: { author?: unknown };
        }>;

        for (const item of delta) {
          const author = getAuthorFromDelta(item);
          if (!author) {
            continue;
          }
          const cls = AUTHOR_CLASS[author] ?? AUTHOR_CLASS.human;
          if (!cls) continue;

          const length = item.insert.length;
          // 近似 position 映射: 忽略换行符占位偏差 (纯文本段落可接受)
          const from = globalOffset;
          const to = globalOffset + length;

          decorations.push(
            Decoration.inline(from, to, {
              class: cls,
              'data-author': author,
            })
          );
          globalOffset += length;
        }

        globalOffset += trailingOffset(text);
      }

      return DecorationSet.create(doc, decorations);
    };

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_config, state) {
            return computeDecorations(
              state.doc,
              ext.storage.fragment as Y.XmlFragment | null
            );
          },
          apply(tr, oldDecos, _oldState, newState) {
            const synced =
              tr.getMeta('external') === true || tr.docChanged;
            if (synced) {
              // 有外部 CRDT 同步事件或本地文档变化时重算
              const fresh = computeDecorations(
                newState.doc,
                ext.storage.fragment as Y.XmlFragment | null
              );
              ext.storage.lastDecorations = fresh;
              return fresh;
            }
            return oldDecos.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return (ext.storage.lastDecorations ?? DecorationSet.empty) as any;
          },
        },
      }),
    ];
  },
});

/**
 * 主组件
 */
export function CollaborativeEditor({
  docId,
  username,
  ydoc,
  className = '',
  defaultAuthor = 'human',
  initialContent = '',
  operatorId,
}: CollaborativeEditorProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [onlineCount, setOnlineCount] = useState(1);
  const [authors, setAuthors] = useState<Set<string>>(() => new Set());
  const authorsRef = useRef(new Set<string>());

  // ---- 复用模块级协同会话 (Y.Doc + WebSocket provider) ----
  // 单例缓存的必要性:
  //  1. StrictMode 开发环境 double-mount 若重建 provider 会产生重复连接;
  //  2. 多个连接共享同一 Y.Doc 时, awareness 广播会经服务端转发回环
  //     (消息风暴 + 偶发解码错误)。
  // 会话由 App 在切换文档时统一销毁, 组件卸载仅摘除监听器。
  const session = useMemo(() => getCollabSession(docId), [docId]);
  const provider: WebsocketProvider = session.provider;

  // ---- 监听连接状态 / 同步 / 在线人数 (不销毁 provider) ----
  useEffect(() => {
    const statusListener = (event: { status: string }) => {
      setIsConnected(event.status === 'connected');
    };
    const syncListener = (isSynced: boolean) => {
      if (isSynced) {
        // 同步完成, 触发一次作者统计
        const a = collectAuthors(ydoc);
        authorsRef.current = a;
        setAuthors(new Set(a));
      }
    };
    const awarenessListener = () => {
      setOnlineCount(provider.awareness.getStates().size);
    };

    provider.on('status', statusListener);
    provider.on('sync', syncListener);
    provider.awareness.on('change', awarenessListener);

    return () => {
      provider.off('status', statusListener);
      provider.off('sync', syncListener);
      provider.awareness.off('change', awarenessListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // ---- Tiptap 编辑器 ----
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // 协同场景由 Y.UndoManager 管理撤销
      }),
      AuthorMark,
      Collaboration.configure({
        fragment: ydoc.getXmlFragment('default'),
      }),
      CollaborationCursor.configure({
        provider,
        user: {
          name: username,
          color: '#4f46e5',
        },
      }),
      // 自定义扩展: 需要读取 ydoc 实例 (通过 args 传入)
      AuthorHighlight.configure({ ydoc }),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
  });

  // ---- 将 editor 注册到协同会话 (供 Agent 面板以本地事务方式插入内容) ----
  // StrictMode double-mount 会创建/销毁两个 editor, 注册时用最新实例;
  // 清理时仅当当前注册的仍是本实例才置空, 避免误清后续注册的编辑器。
  useEffect(() => {
    if (!editor) return;
    session.editor = editor;
    return () => {
      if (session.editor === editor) {
        session.editor = null;
      }
    };
  }, [editor, session]);

  // ---- 初始内容加载: 将后端已保存内容写入 Yjs (打开文档即显示) ----
  // 条件:
  //  - editor 就绪且后端有内容;
  //  - fragment 仍为空 (Tiptap 初始化的空段落不算) 或未加载过,
  //    避免覆盖远端协同内容与 StrictMode 重复加载。
  useEffect(() => {
    if (!editor || !initialContent || session.loaded) return;
    const fragment = ydoc.getXmlFragment('default');
    const isEmpty =
      fragment.length === 0 ||
      (fragment.length === 1 &&
        fragment.get(0) instanceof Y.XmlElement &&
        (fragment.get(0) as Y.XmlElement).length === 0);
    if (!isEmpty) return;

    session.loaded = true;
    // 经 PM 通道写入, 与 AI 插入同一路径 (ySyncPlugin 兼容)
    editor.commands.setContent(initialContent);
  }, [editor, initialContent, ydoc, session]);

  // ---- 编辑持久化: 内容变化防抖 1.5s 后保存到后端 (并写入溯源链日志) ----
  useEffect(() => {
    if (!editor || !operatorId) return;
    let timer: number | undefined;
    const persist = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const text = getPlainText(ydoc);
        if (!text.trim()) return; // 空文档不落库
        updateDocument(docId, { content: text, operatorId }).catch((e) =>
          console.warn('[collab] 文档保存失败:', e)
        );
      }, 1500);
    };
    editor.on('update', persist);
    return () => {
      window.clearTimeout(timer);
      editor.off('update', persist);
    };
  }, [editor, docId, operatorId, ydoc]);

  // ---- 监听远程更新 -> 刷新作者着色与统计 ----
  useEffect(() => {
    if (!editor) return;

    // 本地输入: 标记为人类作者 (默认)
    const handleDocUpdate = () => {
      const fragment = ydoc.getXmlFragment('default');
      // 将用户本地插入的文本标记为 human
      // NOTE: 真实场景在 beforeinput/transaction 时给文本加 author=human 属性
      // 此处用 Y.XmlText.format 模拟: 对最新段落文本打标
      const texts: Y.XmlText[] = [];
      const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
        if (node instanceof Y.XmlText) texts.push(node);
        else node.forEach(walk);
      };
      walk(fragment);
      for (const t of texts) {
        if (t.length > 0 && !t.getAttribute('author')) {
          // 默认全部标记为人类 (AI 内容由 appendAiText 携带 author mark 写入)
          // 属性值用 mark attrs 对象格式, 与 y-prosemirror 的 mark 映射一致
          t.setAttribute('author', { author: defaultAuthor });
        }
      }
      // 刷新统计
      const a = collectAuthors(ydoc);
      authorsRef.current = a;
      setAuthors(new Set(a));
    };

    // Tiptap transaction 触发 (含本地输入与远程 CRDT 同步)
    editor.on('transaction', handleDocUpdate);

    return () => {
      editor.off('transaction', handleDocUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, ydoc, defaultAuthor]);

  return (
    <div
      className={`flex flex-col bg-white rounded-lg shadow-sm overflow-hidden ${className}`}
    >
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${
            isConnected
              ? 'bg-green-100 text-green-700'
              : 'bg-amber-100 text-amber-700'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-green-500' : 'bg-amber-500 animate-pulse'
            }`}
          />
          {isConnected ? '已连接' : '连接中...'}
        </span>

        <span className="text-gray-400">·</span>
        <span className="text-gray-500">{onlineCount} 人在线</span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {/* AI / 人类内容标识 */}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-600">
            <span className="w-2 h-2 rounded-sm bg-blue-400 inline-block" />
            AI 生成 {authors.has('ai') ? '✓' : ''}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-gray-600">
            <span className="w-2 h-2 rounded-sm bg-white border border-gray-300 inline-block" />
            人类输入 {authors.has('human') ? '✓' : ''}
          </span>
        </span>
      </div>

      {/* 编辑器主体 */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}