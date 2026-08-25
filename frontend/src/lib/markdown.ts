import MarkdownIt from 'markdown-it';
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * Markdown <-> 编辑器文档 转换
 * -------------------------------------------------------------
 * - 打开/上传: markdown-it 渲染为 HTML, 经 editor.setContent 进 PM 文档
 *   (与 AI 插入同一 PM 通道, ySyncPlugin 兼容)
 * - 保存: prosemirror-markdown serializer 将 PM 文档序列化为 Markdown
 *   落库, 使标题/列表/引用/代码块等结构随内容持久化 (刷新后不丢失)
 *
 * 命名映射: prosemirror-markdown 默认序列化器按 prosemirror-schema-basic
 * 命名 (strong / em / snake_case 节点), 而 Tiptap StarterKit 扩展名为
 * bold / italic / camelCase 节点。直接使用默认序列化器会在遇到加粗/列表/
 * 代码块时抛出 "Mark type `bold` not supported by Markdown renderer"。
 * 这里复用默认序列化逻辑, 仅按 Tiptap 名称重建节点/标记映射。
 */

const md = new MarkdownIt({
  html: false, // 不渲染原始 HTML (防止注入)
  linkify: true,
  breaks: true, // 单个换行渲染为 <br>, 符合科研写作习惯
});

/** HTML 属性值转义 (LaTeX 原文可能含引号/尖括号) */
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * LaTeX 数学公式 (与 Tiptap MathInline/MathBlock 扩展配套):
 *   $...$   行内公式 -> <math-inline data-latex="...">
 *   $$...$$ 块级公式 (独占段落) -> <math-block data-latex="...">
 * 渲染层由 katex (Tiptap 扩展 renderHTML) 完成, 这里只产出携带
 * LaTeX 原文的占位标签, 保证 setContent 解析后原文无损。
 */
// 行内规则: $x^2$ (前后边界避免误伤价格/美元)
md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== '$') return false;
  // $ 前不能紧邻普通字母/数字/下划线或另一个 $ (避免误伤 $100 / abc$def$),
  // 允许行首/空白/括号/标点 (中文句号「。」后接公式是常见写法);
  // 内容不含 $ 与换行, 且至少 1 个非空白字符
  if (start > 0 && /[\w$]/.test(src[start - 1])) return false;
  const m = /^\$([^$\n]+?)\$/.exec(src.slice(start));
  if (!m || !m[1].trim()) return false;
  if (silent) return true;
  const token = state.push('math_inline', 'math-inline', 0);
  token.content = m[1];
  token.markup = '$';
  state.pos += m[0].length;
  return true;
});

// 块级规则: $$...$$ 独占段落
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.slice(pos, pos + 2) !== '$$') return false;
  if (silent) return true;
  const lines: string[] = [];
  let next = startLine + 1; // 跳过开头 $$ 行
  for (; next < endLine; next++) {
    const bp = state.bMarks[next] + state.tShift[next];
    const text = state.src.slice(bp, state.eMarks[next]);
    if (text.trim() === '$$') break;
    lines.push(text);
  }
  const token = state.push('math_block', 'math-block', 0);
  token.content = lines.join('\n').trim();
  token.map = [startLine, Math.min(next + 1, endLine)];
  state.line = Math.min(next + 1, endLine);
  return true;
});

md.renderer.rules.math_inline = (tokens, idx) =>
  `<math-inline data-latex="${escapeAttr(tokens[idx].content)}"></math-inline>`;
md.renderer.rules.math_block = (tokens, idx) =>
  `<math-block data-latex="${escapeAttr(tokens[idx].content)}"></math-block>\n`;

/** Markdown 文本 -> HTML (供 Tiptap setContent) */
export const markdownToHtml = (text: string): string =>
  md.render(text ?? '');

const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    // Tiptap 节点名 (camelCase) -> 默认序列化实现
    horizontalRule: defaultMarkdownSerializer.nodes.horizontal_rule,
    codeBlock: defaultMarkdownSerializer.nodes.code_block,
    orderedList: defaultMarkdownSerializer.nodes.ordered_list,
    bulletList: defaultMarkdownSerializer.nodes.bullet_list,
    listItem: defaultMarkdownSerializer.nodes.list_item,
    hardBreak: defaultMarkdownSerializer.nodes.hard_break,
    // LaTeX 公式: 还原为 $...$ / $$...$$ (latex 存于节点 attrs, 读取原文)
    mathInline: (state, node) => {
      state.write(`$${node.attrs.latex || ''}$`);
    },
    mathBlock: (state, node) => {
      state.write(`$$\n${node.attrs.latex || ''}\n$$\n\n`);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    // Tiptap mark 名 (bold/italic) -> 默认 strong/em 序列化实现
    bold: defaultMarkdownSerializer.marks.strong,
    italic: defaultMarkdownSerializer.marks.em,
    // author mark (作者溯源标记) 在 Markdown 中序列化为纯文本 (空包围):
    // 作者归属保存在 Yjs 属性与溯源链中, 无需进入 markdown 文本。
    // 若不注册, serialize 遇到该 mark 会抛
    // "Mark type `author` not supported by Markdown renderer",
    // 导致防抖保存 (docToMarkdown) 崩溃, PATCH 永不发出。
    author: { open: '', close: '', mixable: true, escape: false },
  }
);

/** PM 文档 -> Markdown (持久化保存) */
export const docToMarkdown = (doc: PMNode): string =>
  markdownSerializer.serialize(doc);
