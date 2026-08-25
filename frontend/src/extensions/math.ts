import { Node } from '@tiptap/core';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * LaTeX 数学公式扩展 (MathInline / MathBlock)
 * -------------------------------------------------------------
 * - 节点以 attrs.latex 存储 LaTeX 原文 (原子节点, 删除/重建式编辑),
 *   不依赖子文本, 协同 (y-prosemirror) 与 Markdown 持久化均无损;
 * - katex 仅在 renderHTML (视图层) 渲染, PM 文档/ Yjs / 存储中
 *   始终只有 LaTeX 原文, 避免 HTML 序列化丢失;
 * - Markdown 闭环: `$x^2$` / `$$...$$` -> <math-inline>/<math-block>
 *   -> 保存时 docToMarkdown 还原为 $...$ (见 lib/markdown.ts)。
 */

/** katex 渲染为 HTML 字符串 (解析失败降级为原文提示) */
function katexHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    });
  } catch {
    return `<span class="math-error">${latex}</span>`;
  }
}

/** 将 katex HTML 解析为 DOM 节点 (renderHTML 子节点) */
function katexDom(latex: string, displayMode: boolean): HTMLElement {
  const host = document.createElement('span');
  host.innerHTML = katexHtml(latex, displayMode);
  return host;
}

/** 行内公式: $...$ */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'math-inline',
        getAttrs: (el) => ({
          latex: (el as HTMLElement).getAttribute('data-latex') || '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const latex = node.attrs.latex || '';
    return [
      'span',
      { class: 'math-inline', 'data-latex': latex },
      katexDom(latex, false),
    ];
  },
});

/** 块级公式: $$...$$ (独立段落) */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'math-block',
        getAttrs: (el) => ({
          latex: (el as HTMLElement).getAttribute('data-latex') || '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const latex = node.attrs.latex || '';
    return [
      'div',
      { class: 'math-block', 'data-latex': latex },
      katexDom(latex, true),
    ];
  },
});
