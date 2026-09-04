import * as Y from 'yjs';
import type { Editor } from '@tiptap/react';
import type { Document } from '@shared/types';
import { markdownToHtml } from './markdown';

/**
 * Yjs 协同工具库
 * -----------------
 * 提供 Y.Doc 创建、文档管理与作者元数据辅助函数。
 *
 * 作者标记约定:
 *   文本属性 `author` = 'ai'    -> 蓝色背景 (AI 生成)
 *   文本属性 `author` = 'human' -> 白色背景 (人类输入)
 */

export const AUTHOR_AI = 'ai';
export const AUTHOR_HUMAN = 'human';

/** 默认 Yjs 根片段名称 (Tiptap Collaboration 扩展默认值) */
export const DEFAULT_Y_FRAGMENT = 'default';

/** 共享文档的 state 字段: 标题 */
export const META_TITLE = 'title';
/** 共享文档的 state 字段: 创建者 */
export const META_CREATOR = 'creator';

/**
 * 创建 (或复用) 一个 Y.Doc 实例。
 *
 * @param docId 文档 ID (后端房间 ID)
 * @returns     Y.Doc 实例
 */
export function createYDoc(docId: string): Y.Doc {
  const doc = new Y.Doc();
  // 文档元数据 (存储在共享 state 中, 所有协作者可见)
  doc.getMap('meta').set(META_TITLE, `科研文档 - ${docId}`);
  doc.getMap('meta').set(META_CREATOR, 'unknown');
  return doc;
}

/**
 * 将后端返回的 Document 模型转换为 Yjs update format。
 *
 * NOTE: 这是 Stub 函数。
 * 真实场景中, 后端在打开文档时应返回完整 Yjs update (由 Ypy 生成),
 * 客户端通过 `Y.applyUpdate(doc, uint8array)` 恢复 CRDT 状态。
 *
 * TODO: 接入真实后端 Ypy 序列化状态。
 */
export function hydrateFromBackend(
  doc: Y.Doc,
  documentModel: Document | null
): void {
  if (!documentModel?.yjsState) {
    return;
  }
  // TODO: 解析 documentModel.yjsState (base64 编码的 Yjs Update)
  // const binary = atob(documentModel.yjsState);
  // const update = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Y.applyUpdate(doc, update);
}

/**
 * 读取共享文档中所有已标注的作者类型集合。
 * 用于 UI 右上角展示"当前文档包含 AI/人类内容比例"。
 *
 * @param ydoc Yjs 文档
 * @returns    作者类型集合
 */
export function collectAuthors(ydoc: Y.Doc): Set<string> {
  const authors = new Set<string>();
  const fragment = ydoc.getXmlFragment(DEFAULT_Y_FRAGMENT);

  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
    if (node instanceof Y.XmlText) {
      // 读取文本 delta 中携带的 author 属性
      const delta = node.toDelta() as Array<{
        insert: string;
        attributes?: { author?: unknown };
      }>;
      for (const item of delta) {
        const author = getAuthorFromDelta(item);
        if (author) {
          authors.add(author);
        }
      }
    } else if (node instanceof Y.XmlElement) {
      node.forEach(walk);
    } else if (node instanceof Y.XmlFragment) {
      node.forEach(walk);
    }
  };

  walk(fragment);
  return authors;
}

/**
 * 获取当前 Yjs update (用于定期持久化/审计)。
 *
 * @returns Uint8Array Yjs 更新包
 */
export function exportSnapshot(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc);
}

/**
 * 读取 Yjs 文本 delta 项中的作者标记, 兼容两种存储格式:
 *   - 旧格式: 扁平字符串 { author: 'ai' }
 *   - mark 格式: 属性对象 { author: { author: 'ai' } } (Tiptap mark 映射)
 */
export function getAuthorFromDelta(
  item: { attributes?: { author?: unknown } }
): string | undefined {
  const raw = item.attributes?.author;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const v = (raw as { author?: unknown }).author;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * 以 AI 作者身份向文档末尾插入一段文本 (蓝色高亮演示)。
 * 通过 Y.XmlText 的 author 属性标记, 与 AuthorHighlight 扩展联动。
 *
 * NOTE: 仅适用于无 Tiptap 环境 (Node 单测)。浏览器中直接操作 fragment
 * 会被 ySyncPlugin 的 synchronize 回写规范化 (插入的 XmlText 内容被丢弃),
 * 请改用 appendAiText。
 */
export function insertAiText(ydoc: Y.Doc, text: string): void {
  if (!text.trim()) return;
  const fragment = ydoc.getXmlFragment(DEFAULT_Y_FRAGMENT);
  ydoc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const ytext = new Y.XmlText();
    // mark 属性对象格式: y-prosemirror 读到的 mark attrs 是 { author: 'ai' }
    ytext.insert(0, text, { author: { author: AUTHOR_AI } });
    paragraph.insert(0, [ytext]);
    fragment.insert(fragment.length, [paragraph]);
  });
}

/**
 * 以指定作者身份向文档末尾追加一段文本 (浏览器主路径)。
 *
 * 为什么走编辑器通道:
 *  ySyncPlugin 会对 fragment 的外部变更执行 synchronize (从 fragment 全量
 *  重建 PM 文档并回写); 直接操作 fragment 插入的 XmlText 内容会被该回写
 *  丢弃, 而未经 PM mark 注册的 Yjs 属性操作 (setAttribute/format) 也会
 *  因属性映射失败触发同样问题。因此:
 *   1. 用 editor.commands.insertContentAt 经 PM transaction 插入段落,
 *      文本携带 author mark (mark 名即 Yjs 属性名, y-prosemirror 在
 *      PM 写回事务内自动映射为 Yjs 属性, 不会触发外部 synchronize);
 *   2. 不单独调用 Yjs format/setAttribute (见上述丢失机理)。
 *
 * @returns 是否已插入
 */
export function appendText(
  editor: Editor | null,
  ydoc: Y.Doc,
  text: string,
  author: string = AUTHOR_HUMAN
): boolean {
  if (!text.trim()) return false;
  if (!editor || !editor.isEditable) {
    // 编辑器未就绪时退化为直接 fragment 操作 (仅保证 Yjs 数据层)
    const fragment = ydoc.getXmlFragment(DEFAULT_Y_FRAGMENT);
    ydoc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const ytext = new Y.XmlText();
      ytext.insert(0, text, { author: { author } });
      paragraph.insert(0, [ytext]);
      fragment.insert(fragment.length, [paragraph]);
    });
    return true;
  }

  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text,
        // mark 类型用 mark 名 'author' (与 CollaborativeEditor 注册的
        // AuthorMark 对应), attrs.author 才是作者值; 误用 'ai' 会导致
        // "There is no mark type ai in this schema" 插入被丢弃。
        marks: [{ type: 'author', attrs: { author } }],
      },
    ],
  });
  return true;
}

/**
 * 以 AI 作者身份向文档末尾追加一段文本 (蓝色高亮)。
 * 供 Agent 面板在 Writer 产出后调用。
 */
export function appendAiText(
  editor: Editor | null,
  ydoc: Y.Doc,
  text: string
): boolean {
  return appendText(editor, ydoc, text, AUTHOR_AI);
}

/**
 * 以 AI 作者身份向文档末尾追加一段 Markdown 正文 (结构化插入)。
 *
 * 与 appendAiText 的区别: 内容经 markdownToHtml -> DOMParser 解析为
 * Tiptap JSON 结构 (标题/段落/列表/引用等), 每个文本节点携带 author mark,
 * 因此 Writer 的结构化输出 (「# 标题 / ## 参考文献 / ## 正文」) 在编辑器
 * 里按真实排版渲染, 且整体保持 AI 蓝色高亮可溯源。
 *
 * 只追加不清空 (保护已有人工内容); 编辑器未就绪时退化为纯文本插入。
 */
export function appendAiMarkdown(
  editor: Editor | null,
  ydoc: Y.Doc,
  markdown: string
): boolean {
  const text = (markdown ?? '').trim();
  if (!text) return false;
  if (!editor || !editor.isEditable) {
    return appendText(editor, ydoc, text, AUTHOR_AI);
  }

  // markdown.ts 只依赖外部库 (无循环引用风险), 静态导入于文件顶部
  const html = markdownToHtml(text);
  const dom = new DOMParser().parseFromString(html, 'text/html');

  const MARKS = [{ type: 'author', attrs: { author: AUTHOR_AI } }];
  const inline = (el: Element): unknown[] => {
    const out: unknown[] = [];
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent ?? '';
        if (t) out.push({ type: 'text', text: t, marks: MARKS });
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        out.push(...inline(n as Element));
      }
    });
    return out;
  };
  const block = (el: Element): unknown | null => {
    const tag = el.tagName.toLowerCase();
    const content = inline(el);
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return {
          type: 'heading',
          attrs: { level: Number(tag[1]) },
          ...(content.length ? { content } : {}),
        };
      case 'ul':
      case 'ol': {
        const items = Array.from(el.children)
          .filter((li) => li.tagName.toLowerCase() === 'li')
          .map((li) => {
            const c = inline(li);
            return {
              type: 'listItem',
              content: [
                { type: 'paragraph', ...(c.length ? { content: c } : {}) },
              ],
            };
          });
        return items.length
          ? { type: tag === 'ol' ? 'orderedList' : 'bulletList', content: items }
          : null;
      }
      case 'blockquote':
        return {
          type: 'blockquote',
          content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }],
        };
      case 'pre': {
        const code = el.textContent ?? '';
        return {
          type: 'codeBlock',
          ...(code ? { content: [{ type: 'text', text: code }] } : {}),
        };
      }
      case 'hr':
        return { type: 'horizontalRule' };
      case 'p':
      case 'div':
        return {
          type: 'paragraph',
          ...(content.length ? { content } : {}),
        };
      default:
        return content.length
          ? { type: 'paragraph', content }
          : null;
    }
  };

  const nodes = Array.from(dom.body.children)
    .map(block)
    .filter((n): n is object => n !== null);
  if (nodes.length === 0) {
    return appendText(editor, ydoc, text, AUTHOR_AI);
  }

  editor.commands.insertContentAt(editor.state.doc.content.size, nodes);
  return true;
}

/**
 * 读取文档纯文本 (供水印检测 / 持久化 / 导出使用)。
 * XmlFragment.toString() 会输出 XML 标记, 这里按 paragraph 分段提取,
 * 段落间以换行分隔, 空段落忽略, 段内换行保留。
 */
export function getPlainText(ydoc: Y.Doc): string {
  const fragment = ydoc.getXmlFragment(DEFAULT_Y_FRAGMENT);
  const paragraphs: string[] = [];
  const current: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
    if (node instanceof Y.XmlText) {
      current.push(node.toString());
    } else if (node instanceof Y.XmlElement) {
      if (node.nodeName === 'paragraph') {
        const text = current.join('');
        if (text.trim()) paragraphs.push(text);
        current.length = 0;
      }
      node.forEach(walk);
    } else {
      node.forEach(walk);
    }
  };
  walk(fragment);
  const tail = current.join('');
  if (tail.trim()) paragraphs.push(tail);
  return paragraphs.join('\n');
}