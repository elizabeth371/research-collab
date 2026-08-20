import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Editor } from '@tiptap/react';

/**
 * 协同会话单例缓存
 * ==================
 * Y.Doc 与 WebsocketProvider 按文档 ID 做模块级缓存, 由整个页面共享。
 *
 * 为什么需要单例:
 *  1. React StrictMode 在开发环境会 double-mount 组件 (挂载→卸载→再挂载),
 *     若 provider 在组件内创建/销毁, 会产生重复 WebSocket 连接;
 *  2. 多个组件 (编辑器 / Agent 面板 / 水印面板) 共享同一 Y.Doc 状态,
 *     各自创建 provider 会导致 awareness 回环 (服务端把 A 的广播转发给
 *     B, B 应用后重新广播, 时钟无限递增, 消息风暴).
 *
 * 生命周期:
 *  - getCollabSession(docId): 首次调用创建 Y.Doc + provider, 之后复用;
 *  - disposeCollabSession(docId): 切换文档时显式销毁旧会话 (由 App 调用);
 *  - 页面关闭时浏览器自动释放 (无需手动清理).
 */

export interface CollabSession {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  /** Tiptap 编辑器实例 (由 CollaborativeEditor 注册, Agent 面板经它插入内容) */
  editor: Editor | null;
  /** 文档初始内容是否已加载 (防 StrictMode double-mount 重复 setContent) */
  loaded: boolean;
}

const sessions = new Map<string, CollabSession>();

/** 构建 WebSocket 地址: 开发环境经 Vite 代理转发到 FastAPI /ws */
export function getWsUrl(): string {
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

/** 获取 (或创建) 文档的协同会话: 同一文档全页面共享同一 Y.Doc 与连接 */
export function getCollabSession(docId: string): CollabSession {
  let session = sessions.get(docId);
  if (!session) {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(getWsUrl(), docId, ydoc, {
      connect: true,
      // 二进制协议 (匹配后端 y-websocket 实现)
      protocols: ['yjs'],
    });
    session = { ydoc, provider, editor: null, loaded: false };
    sessions.set(docId, session);
  }
  return session;
}

/** 销毁文档会话 (关闭 WebSocket 连接): 切换文档时调用, 防止连接泄漏 */
export function disposeCollabSession(docId: string): void {
  const session = sessions.get(docId);
  if (session) {
    session.provider.destroy();
    sessions.delete(docId);
  }
}

// 开发环境 HMR: 模块热替换时销毁全部会话, 防止旧连接泄漏与双 provider 回环
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const session of sessions.values()) {
      session.provider.destroy();
    }
    sessions.clear();
  });
}

// 调试钩子: 仅开发环境暴露, 供浏览器控制台/CSP 检查协同会话状态
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__collab = {
    getSession: getCollabSession,
    dispose: disposeCollabSession,
    sessionCount: () => sessions.size,
    /** 列出全部会话及 Yjs fragment 结构 (只读诊断) */
    inspectAll: () =>
      Array.from(sessions.entries()).map(([docId, s]) => {
        const frag = s.ydoc.getXmlFragment('default');
        const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook): string => {
          if (node instanceof Y.XmlText) {
            return `text(${node.length})`;
          }
          if (node instanceof Y.XmlElement) {
            return `el(${node.nodeName})[${node
              .toArray()
              .map((c) => walk(c))
              .join(',')}]`;
          }
          if (node instanceof Y.XmlHook) {
            return 'hook';
          }
          return node.toArray().map((c) => walk(c)).join(',');
        };
        return {
          docId,
          connState: s.provider.ws?.readyState ?? -1,
          fragLen: frag.length,
          structure: walk(frag),
          plainText: frag.toString().slice(0, 120),
        };
      }),
  };
}
