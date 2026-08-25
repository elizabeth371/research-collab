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
