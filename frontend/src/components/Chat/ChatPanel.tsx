import { useEffect, useRef, useState } from 'react';
import type { ChatMessageItem } from '@shared/types';
import { getChatMessages } from '../../lib/api';

/**
 * 协作聊天面板 (步骤 16)
 * ======================
 * 同一文档房间内的实时讨论 (申报书「即时通讯」承诺项):
 *  - 进入面板即连接 /ws/chat/{doc_id} WebSocket 房间
 *  - 先加载历史消息 (HTTP), 之后实时收发 (自己右侧蓝色气泡, 他人左侧)
 *  - 切换文档自动断开旧房间、连接新房间并加载对应历史
 *  - 发送后靠服务端广播回显 (不本地追加, 避免重复)
 */
interface ChatPanelProps {
  docId: string;
  userId: string;
  username: string;
}

export function ChatPanel({ docId, userId, username }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 连接 WebSocket + 加载历史 (按文档切换)
  useEffect(() => {
    if (!docId) return;
    let disposed = false;

    // 1. 加载历史消息
    getChatMessages(docId)
      .then((msgs) => {
        if (!disposed) {
          setMessages(msgs);
          setHistoryLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) {
          setHistoryLoaded(true);
        }
      });

    // 2. 建立实时房间连接
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/chat/${docId}`);
    wsRef.current = ws;
    ws.onopen = () => !disposed && setConnected(true);
    ws.onclose = () => !disposed && setConnected(false);
    ws.onerror = () => !disposed && setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data?.type === 'chat' && typeof data.content === 'string') {
          setMessages((prev) => [
            ...prev,
            {
              id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              doc_id: docId,
              user_id: data.user_id || null,
              username: data.username || '匿名',
              content: data.content,
              created_at: new Date().toISOString(),
            },
          ]);
        }
      } catch {
        /* 非 JSON 帧忽略 */
      }
    };

    return () => {
      disposed = true;
      ws.close();
      wsRef.current = null;
    };
  }, [docId]);

  // 新消息自动滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const sendMessage = () => {
    const content = input.trim();
    if (!content || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({ type: 'chat', content, user_id: userId, username })
    );
    setInput('');
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div>
        <h3 className="panel-title text-sm">协作聊天</h3>
        <p className="text-[11px] text-slate-400 mt-0.5">
          文档房间实时讨论 · {connected ? '● 已连接' : '○ 未连接'}
        </p>
      </div>

      {/* 消息列表 */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto slim-scroll space-y-2 my-3 pr-1"
      >
        {!historyLoaded && (
          <p className="text-[11px] text-slate-400">历史消息加载中...</p>
        )}
        {historyLoaded && messages.length === 0 && (
          <p className="text-[11px] text-slate-400">
            暂无消息 · 同文档的师生/同伴消息会实时显示在这里
          </p>
        )}
        {messages.map((m) => {
          const mine = m.user_id === userId;
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                  mine
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-slate-100 text-slate-700 rounded-bl-sm'
                }`}
              >
                {!mine && (
                  <div className="text-[9px] text-slate-400 mb-0.5">{m.username}</div>
                )}
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                <div
                  className={`text-[8px] mt-0.5 ${
                    mine ? 'text-blue-200' : 'text-slate-400'
                  }`}
                >
                  {new Date(m.created_at).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 输入区 */}
      <div className="border-t border-slate-200 pt-2 space-y-1.5">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          rows={2}
          placeholder="给同文档的伙伴发消息... (Enter 发送, Shift+Enter 换行)"
          className="w-full text-[11px] p-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
        />
        <button
          onClick={sendMessage}
          disabled={!connected || !input.trim()}
          className="w-full text-[11px] font-medium py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {connected ? '发送' : '连接中...'}
        </button>
      </div>
    </div>
  );
}
