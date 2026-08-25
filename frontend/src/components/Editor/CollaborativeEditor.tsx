import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { BubbleMenu, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getCollabSession } from '../../lib/collab';
import { collectAuthors, getAuthorFromDelta } from '../../lib/yjs';
import { markdownToHtml, docToMarkdown } from '../../lib/markdown';
import { updateDocument, getComments, addComment, deleteComment } from '../../lib/api';
import type { CommentItem } from '../../lib/api';

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
 * 工具栏按钮 (学术风: 文字符号 + 标题提示)
 * onMouseDown preventDefault: 避免按钮抢焦点导致编辑器失焦
 */
function ToolbarBtn({
  label,
  title,
  active,
  onClick,
  disabled,
}: {
  label: ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onClick();
      }}
      className={`w-7 h-7 rounded flex items-center justify-center text-[13px] leading-none transition-colors ${
        active
          ? 'bg-ink/10 text-ink font-semibold'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
      } ${disabled ? 'opacity-30 pointer-events-none' : ''}`}
    >
      {label}
    </button>
  );
}

/** 工具栏分隔线 */
function ToolbarDivider() {
  return <span className="w-px h-4 bg-slate-200 mx-0.5" />;
}

/** 浮动菜单按钮 (深色底, 用于选中文字的 BubbleMenu) */
function BubbleBtn({
  label,
  title,
  active,
  onClick,
}: {
  label: ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`w-7 h-7 rounded flex items-center justify-center text-[13px] leading-none transition-colors ${
        active
          ? 'bg-white/25 text-white font-semibold'
          : 'text-slate-300 hover:bg-white/15 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

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
 * 段落批注标记扩展
 * ----------------
 * 对"有批注的段落"在段尾渲染计数徽章 (Decoration widget), 点击打开批注面板。
 *
 * Tiptap extension options 在 configure 后不可变, 而批注数据会随
 * 新增/删除变化: 组件内将最新 comments 与点击回调写入 extension storage,
 * 并通过带 commentRefresh meta 的空事务触发 decorations 重算。
 */
const CommentHighlight = Extension.create({
  name: 'commentHighlight',

  addStorage() {
    return {
      comments: [] as CommentItem[],
      onOpen: null as ((paraIndex: number, snapshot: string) => void) | null,
      lastDecorations: DecorationSet.empty as DecorationSet,
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    const pluginKey = new PluginKey('commentHighlight');

    const computeDecorations = (doc: any): DecorationSet => {
      const comments = ext.storage.comments as CommentItem[];
      if (comments.length === 0) return DecorationSet.empty;

      // para_index -> { snapshot, count }
      const byIndex = new Map<number, { snapshot: string; count: number }>();
      for (const c of comments) {
        const cur = byIndex.get(c.para_index) ?? { snapshot: '', count: 0 };
        cur.snapshot = c.para_snapshot;
        cur.count += 1;
        byIndex.set(c.para_index, cur);
      }

      const decorations: Decoration[] = [];
      let paraIndex = 0;
      doc.forEach((node: any, offset: number) => {
        paraIndex += 1;
        const target = byIndex.get(paraIndex);
        if (!target) return;
        const { snapshot, count } = target;
        // 段内文字末尾 (node.nodeSize - 1), 徽章内联渲染在段尾
        const pos = offset + node.nodeSize - 1;
        // paraIndex 是 forEach 外的共享变量, 而 widget DOM 惰性创建:
        // 渲染时 paraIndex 已累加到末值, 必须在此处固化到迭代局部变量
        const badgeParaIndex = paraIndex;
        const badgeSnapshot = snapshot;
        decorations.push(
          Decoration.widget(
            pos,
            () => {
              const badge = document.createElement('button');
              badge.type = 'button';
              badge.className = 'comment-badge';
              badge.textContent = `批注 ${count}`;
              badge.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                ext.storage.onOpen?.(badgeParaIndex, badgeSnapshot);
              });
              return badge;
            },
            { side: 1, ignoreSelection: true }
          )
        );
      });
      return DecorationSet.create(doc, decorations);
    };

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_config, state) {
            return computeDecorations(state.doc);
          },
          apply(tr, oldDecos, _oldState, newState) {
            // 文档变化 (段落重排) 或批注数据刷新时重算
            if (tr.docChanged || tr.getMeta('commentRefresh')) {
              const fresh = computeDecorations(newState.doc);
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

  // ---- 段落批注状态 ----
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentPanel, setCommentPanel] = useState<{
    paraIndex: number;
    snapshot: string;
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  /** 取文档第 paraIndex 个顶层块的当前文本 (1 起) */
  const getParaText = useCallback((doc: any, paraIndex: number): string => {
    let i = 1;
    let text = '';
    doc.forEach((node: any) => {
      if (i === paraIndex) text = node.textContent || '';
      i += 1;
    });
    return text;
  }, []);

  /** 打开批注面板 (徽章点击 / 浮动菜单入口共用) */
  const openCommentPanel = useCallback((paraIndex: number, snapshot: string) => {
    setCommentPanel({ paraIndex, snapshot });
    setCommentDraft('');
  }, []);

  // ---- 加载批注列表 (切文档时刷新) ----
  useEffect(() => {
    let cancelled = false;
    getComments(docId)
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {
        /* 拉取失败静默, 批注功能仍可用 */
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const handleAddComment = async () => {
    if (!commentPanel || !commentDraft.trim()) return;
    try {
      await addComment(docId, {
        paraIndex: commentPanel.paraIndex,
        paraSnapshot: commentPanel.snapshot,
        author: username,
        content: commentDraft.trim(),
      });
      setCommentDraft('');
      setComments(await getComments(docId));
    } catch (e) {
      console.warn('[comment] 添加批注失败:', e);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await deleteComment(docId, commentId);
      setComments(await getComments(docId));
    } catch (e) {
      console.warn('[comment] 删除批注失败:', e);
    }
  };

  const formatTime = (iso: string): string =>
    new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

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
      // 段落批注徽章 (数据经 storage 注入)
      CommentHighlight.configure({}),
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

  /** 从当前选区/光标所在段落发起批注 */
  const openCommentForSelection = useCallback(() => {
    if (!editor) return;
    const { doc, selection } = editor.state;
    let paraIndex = 0;
    let found = false;
    doc.forEach((node: any, offset: number) => {
      if (found) return;
      paraIndex += 1;
      // 光标在节点范围内 (含起点; 与下一节点起点重合时归属下一段)
      if (offset + node.nodeSize > selection.from) {
        found = true;
      }
    });
    if (found) {
      openCommentPanel(paraIndex, getParaText(doc, paraIndex));
    }
  }, [editor, getParaText, openCommentPanel]);

  // ---- 批注数据注入 CommentHighlight storage + 触发重算 ----
  const commentExt = editor?.extensionManager.extensions.find(
    (e) => e.name === 'commentHighlight'
  );
  useEffect(() => {
    if (!editor || !commentExt) return;
    commentExt.storage.comments = comments;
    commentExt.storage.onOpen = openCommentPanel;
    editor.view.dispatch(editor.view.state.tr.setMeta('commentRefresh', true));
  }, [comments, openCommentPanel, editor, commentExt]);

  // ---- 初始内容加载: 将后端已保存内容写入 Yjs (打开文档即显示) ----
  // 条件:
  //  - editor 就绪且后端有内容;
  //  - fragment 仍为空 (Tiptap 初始化的空段落不算) 或未加载过,
  //    避免覆盖远端协同内容与 StrictMode 重复加载。
  // NOTE: 不依赖 session.loaded 标志 —— 该标志在会话生命周期内不会复位,
  //       同一页面内"切走再切回"会跳过加载导致编辑器空白。
  //       fragment 是否为空本身即可防重: setContent 会把内容写入 CRDT,
  //       StrictMode 二次挂载 / 切回时 fragment 已有内容, 直接以 CRDT 为准。
  useEffect(() => {
    if (!editor || !initialContent) return;
    const fragment = ydoc.getXmlFragment('default');
    const isEmpty =
      fragment.length === 0 ||
      (fragment.length === 1 &&
        fragment.get(0) instanceof Y.XmlElement &&
        (fragment.get(0) as Y.XmlElement).length === 0);
    if (!isEmpty) return;

    // 后端内容为 Markdown 文本: 经 markdown-it 渲染为 HTML 后写入 PM,
    // 与 AI 插入同一路径 (ySyncPlugin 兼容)。emitUpdate=false 使打开文档
    // 不触发保存 (内容即后端原文, 无需回写, 避免每次打开多一条溯源日志)。
    editor.commands.setContent(markdownToHtml(initialContent), false);
  }, [editor, initialContent, ydoc]);

  // ---- 编辑持久化: 内容变化防抖 1.5s 后以 Markdown 保存到后端 (写入溯源链) ----
  // 保存走 prosemirror-markdown 序列化, 标题/列表/引用等结构随内容持久化;
  // 水印检测仍在 App.tsx 走纯文本 (getPlainText), 二者互不影响。
  useEffect(() => {
    if (!editor || !operatorId) return;
    let timer: number | undefined;
    const persist = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const text = docToMarkdown(editor.state.doc).trim();
        if (!text) return; // 空文档不落库
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

  // ---- 批注面板渲染数据 ----
  const paraNow =
    editor && commentPanel
      ? getParaText(editor.state.doc, commentPanel.paraIndex)
      : '';
  const drifted =
    !!commentPanel && paraNow.trim() !== commentPanel.snapshot.trim();
  const panelComments = commentPanel
    ? comments.filter((c) => c.para_index === commentPanel.paraIndex)
    : [];

  return (
    <div
      className={`relative flex flex-col bg-white rounded-lg shadow-sm overflow-hidden ${className}`}
    >
      {/* 格式化工具栏 (StarterKit 命令, 无新增扩展) */}
      {editor && (
        <div className="flex items-center flex-wrap gap-0.5 px-3 py-1.5 border-b border-slate-200 bg-slate-50">
          <ToolbarBtn
            label="H1"
            title="一级标题"
            active={editor.isActive('heading', { level: 1 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          />
          <ToolbarBtn
            label="H2"
            title="二级标题"
            active={editor.isActive('heading', { level: 2 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          />
          <ToolbarBtn
            label="H3"
            title="三级标题"
            active={editor.isActive('heading', { level: 3 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 3 }).run()
            }
          />
          <ToolbarDivider />
          <ToolbarBtn
            label={<span className="font-bold">B</span>}
            title="加粗"
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolbarBtn
            label={<span className="italic">I</span>}
            title="斜体"
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolbarBtn
            label={<span className="line-through">S</span>}
            title="删除线"
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolbarDivider />
          <ToolbarBtn
            label="&lt;/&gt;"
            title="行内代码"
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <ToolbarBtn
            label="{}"
            title="代码块"
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />
          <ToolbarDivider />
          <ToolbarBtn
            label="❝"
            title="引用"
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <ToolbarBtn
            label="•"
            title="无序列表"
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <ToolbarBtn
            label="1."
            title="有序列表"
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <ToolbarDivider />
          <ToolbarBtn
            label="—"
            title="分隔线"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />
        </div>
      )}

      {/* 状态栏: 连接状态 / 在线人数 / AI·人类内容标识 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-slate-50 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${
            isConnected
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-amber-100 text-amber-700'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
            }`}
          />
          {isConnected ? '已连接' : '连接中...'}
        </span>

        <span className="text-slate-400">·</span>
        <span className="text-slate-500">{onlineCount} 人在线</span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {/* AI / 人类内容标识 */}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent">
            <span className="w-2 h-2 rounded-sm bg-accent inline-block" />
            AI 生成 {authors.has('ai') ? '✓' : ''}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600">
            <span className="w-2 h-2 rounded-sm bg-white border border-slate-300 inline-block" />
            人类输入 {authors.has('human') ? '✓' : ''}
          </span>
        </span>
      </div>

      {/* 编辑器主体 */}
      <div className="flex-1 overflow-y-auto">
        {/* 选中文字浮动菜单 */}
        {editor && (
          <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 100, placement: 'top' }}
          >
            <div className="flex items-center gap-0.5 bg-slate-900 rounded-lg shadow-xl px-1.5 py-1">
              <BubbleBtn
                label={<span className="font-bold">B</span>}
                title="加粗"
                active={editor.isActive('bold')}
                onClick={() => editor.chain().focus().toggleBold().run()}
              />
              <BubbleBtn
                label={<span className="italic">I</span>}
                title="斜体"
                active={editor.isActive('italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              />
              <BubbleBtn
                label={<span className="line-through">S</span>}
                title="删除线"
                active={editor.isActive('strike')}
                onClick={() => editor.chain().focus().toggleStrike().run()}
              />
              <BubbleBtn
                label="&lt;/&gt;"
                title="行内代码"
                active={editor.isActive('code')}
                onClick={() => editor.chain().focus().toggleCode().run()}
              />
              <span className="w-px h-4 bg-white/15 mx-0.5" />
              <BubbleBtn
                label="批注"
                title="添加段落批注"
                onClick={openCommentForSelection}
              />
            </div>
          </BubbleMenu>
        )}
        <EditorContent editor={editor} />
      </div>

      {/* 段落批注面板 */}
      {commentPanel && (
        <div className="absolute top-14 right-3 z-20 w-80 bg-white rounded-lg border border-slate-200 shadow-xl flex flex-col max-h-[70%]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
            <span className="panel-title text-xs">
              批注 · 第 {commentPanel.paraIndex} 段
            </span>
            <button
              type="button"
              title="关闭批注面板"
              onClick={() => setCommentPanel(null)}
              className="w-6 h-6 rounded flex items-center justify-center text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              ×
            </button>
          </div>

          <div className="px-3 py-2 border-b border-slate-200 bg-slate-50/50">
            <p className="text-[10px] text-slate-400 mb-1">锚定段落</p>
            <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">
              {commentPanel.snapshot || '（空段落）'}
            </p>
            {drifted && (
              <p className="text-[10px] text-amber-600 mt-1">
                段落内容已修改, 批注仍保留
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto slim-scroll px-3 py-2 space-y-2 min-h-0">
            {panelComments.length === 0 ? (
              <p className="text-xs text-slate-400 py-1">暂无批注, 在下方添加</p>
            ) : (
              panelComments.map((c) => (
                <div
                  key={c.id}
                  className="border border-slate-100 rounded-md p-2 bg-slate-50/60"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium text-ink">
                      {c.author}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {formatTime(c.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {c.content}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleDeleteComment(c.id)}
                    className="text-[10px] text-slate-400 hover:text-red-500 mt-1"
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="px-3 py-2 border-t border-slate-200">
            <textarea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="写下批注, 与同门交流..."
              className="w-full text-xs border border-slate-200 rounded-md p-2 h-16 resize-none focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <button
              type="button"
              disabled={!commentDraft.trim()}
              onClick={() => void handleAddComment()}
              className="mt-1.5 w-full text-xs px-3 py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 transition-colors"
            >
              添加批注
            </button>
          </div>
        </div>
      )}
    </div>
  );
}