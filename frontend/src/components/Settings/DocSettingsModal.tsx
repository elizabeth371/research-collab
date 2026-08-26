import { useEffect, useState } from 'react';
import type {
  CollabMode,
  DocumentPermissions,
  DocumentVersionItem,
  ExportPolicy,
  WatermarkPolicy,
} from '@shared/types';
import {
  getDocumentPermissions,
  getDocumentVersion,
  getDocumentVersions,
  restoreDocumentVersion,
  updateDocumentPermissions,
} from '../../lib/api';

/**
 * 文档设置弹窗 (步骤 15)
 * ======================
 * 两个页签:
 *  1. 版本回溯: 列出全部版本快照 (时间/操作者/字数/预览), 可预览与一键恢复;
 *     恢复动作写溯源链 (version_restore), 内容回退由后端完成。
 *  2. 权限管理: 协作模式 / 水印策略 / 导出策略 + 协作者集合管理 (owner 恒保留);
 *     导出策略 deny 会同时禁用 Markdown 导出与证据包导出 (后端 403 兜底)。
 */
interface DocSettingsModalProps {
  docId: string;
  open: boolean;
  onClose: () => void;
  /** 版本恢复成功后回调 (父组件刷新文档数据) */
  onRestored: () => void;
  /** 权限保存成功后回调 (父组件同步导出按钮状态) */
  onPermissionsChanged: (perms: DocumentPermissions) => void;
}

export function DocSettingsModal({
  docId,
  open,
  onClose,
  onRestored,
  onPermissionsChanged,
}: DocSettingsModalProps) {
  const [tab, setTab] = useState<'versions' | 'permissions'>('versions');

  // ---- 版本回溯 ----
  const [versions, setVersions] = useState<DocumentVersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [preview, setPreview] = useState<DocumentVersionItem | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [restoring, setRestoring] = useState<number | null>(null);
  const [versionsMsg, setVersionsMsg] = useState<string | null>(null);
  const [versionsErr, setVersionsErr] = useState<string | null>(null);

  // ---- 权限管理 ----
  const [perms, setPerms] = useState<DocumentPermissions | null>(null);
  const [collabMode, setCollabMode] = useState<CollabMode>('open');
  const [watermarkPolicy, setWatermarkPolicy] = useState<WatermarkPolicy>('optional');
  const [exportPolicy, setExportPolicy] = useState<ExportPolicy>('allow');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [permsSaving, setPermsSaving] = useState(false);
  const [permsMsg, setPermsMsg] = useState<string | null>(null);
  const [permsErr, setPermsErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !docId) return;
    setTab('versions');
    setPreview(null);
    setPreviewContent('');
    setVersionsMsg(null);
    setVersionsErr(null);
    setPermsMsg(null);
    setPermsErr(null);
    void loadVersions();
    void loadPerms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docId]);

  const loadVersions = async () => {
    setVersionsLoading(true);
    try {
      const data = await getDocumentVersions(docId);
      setVersions(data.versions);
    } catch (e) {
      setVersionsErr(e instanceof Error ? e.message : '版本列表加载失败');
    } finally {
      setVersionsLoading(false);
    }
  };

  const loadPerms = async () => {
    try {
      const p = await getDocumentPermissions(docId);
      setPerms(p);
      setCollabMode(p.collab_mode);
      setWatermarkPolicy(p.watermark_policy);
      setExportPolicy(p.export_policy);
      setSelectedIds(new Set(p.collaborators.map((c) => c.user_id)));
    } catch (e) {
      setPermsErr(e instanceof Error ? e.message : '权限配置加载失败');
    }
  };

  const previewVersion = async (v: DocumentVersionItem) => {
    setVersionsErr(null);
    try {
      const d = await getDocumentVersion(docId, v.version_no);
      setPreview(v);
      setPreviewContent(d.content);
    } catch (e) {
      setVersionsErr(e instanceof Error ? e.message : '版本内容加载失败');
    }
  };

  const doRestore = async (v: DocumentVersionItem) => {
    if (
      !window.confirm(
        `确定恢复到第 ${v.version_no} 版吗？当前内容将被该版本覆盖，恢复动作会写入溯源链。`
      )
    ) {
      return;
    }
    setRestoring(v.version_no);
    setVersionsErr(null);
    try {
      await restoreDocumentVersion(docId, v.version_no);
      setVersionsMsg(
        `已恢复到第 ${v.version_no} 版 (${new Date(v.created_at).toLocaleString('zh-CN')})`
      );
      setPreview(null);
      setPreviewContent('');
      await loadVersions();
      onRestored();
    } catch (e) {
      setVersionsErr(e instanceof Error ? e.message : '版本恢复失败');
    } finally {
      setRestoring(null);
    }
  };

  const toggleCollaborator = (uid: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const doSavePerms = async () => {
    setPermsSaving(true);
    setPermsErr(null);
    try {
      const p = await updateDocumentPermissions(docId, {
        collab_mode: collabMode,
        watermark_policy: watermarkPolicy,
        export_policy: exportPolicy,
        collaborator_ids: [...selectedIds],
      });
      setPerms(p);
      setPermsMsg('权限配置已保存 (协作模式/水印策略/导出策略/协作者)');
      onPermissionsChanged(p);
    } catch (e) {
      setPermsErr(e instanceof Error ? e.message : '权限保存失败');
    } finally {
      setPermsSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] flex flex-col bg-white rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h3 className="text-sm font-semibold text-slate-800">⚙️ 文档设置</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-lg leading-none"
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* 页签 */}
        <div className="flex border-b border-slate-200">
          {(
            [
              ['versions', '版本回溯'],
              ['permissions', '权限管理'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 text-xs py-2.5 font-medium transition-colors ${
                tab === key
                  ? 'text-accent border-b-2 border-accent bg-accent/5'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-4 slim-scroll">
          {tab === 'versions' && (
            <div className="space-y-2">
              <p className="text-[10px] text-slate-400 leading-relaxed">
                每次内容保存自动快照一版 (每文档最多保留 50 版)。恢复会覆盖当前
                内容并写入溯源链，可作为误删/误改的撤回手段。
              </p>
              {versionsMsg && (
                <div className="text-[10px] text-green-600 bg-green-50 rounded px-2 py-1.5">
                  ✅ {versionsMsg}
                </div>
              )}
              {versionsErr && (
                <div className="text-[10px] text-red-500 bg-red-50 rounded px-2 py-1.5">
                  {versionsErr}
                </div>
              )}
              {versionsLoading && versions.length === 0 ? (
                <p className="text-[11px] text-slate-400">版本列表加载中...</p>
              ) : versions.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  暂无版本快照 · 保存一次文档内容后自动生成
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {versions.map((v) => (
                    <li
                      key={v.version_no}
                      className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-700">
                          第 {v.version_no} 版
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(v.created_at).toLocaleString('zh-CN')} ·{' '}
                          {v.content_length} 字
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">
                        {v.preview || '(空文档)'}
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => void previewVersion(v)}
                          className="text-[10px] font-medium px-2 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        >
                          预览
                        </button>
                        <button
                          onClick={() => void doRestore(v)}
                          disabled={restoring !== null}
                          className="text-[10px] font-medium px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40"
                        >
                          {restoring === v.version_no ? '恢复中...' : '恢复此版本'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {preview && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-blue-800">
                      第 {preview.version_no} 版内容预览
                    </span>
                    <button
                      onClick={() => {
                        setPreview(null);
                        setPreviewContent('');
                      }}
                      className="text-[10px] text-blue-500 hover:text-blue-700"
                    >
                      收起
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600 whitespace-pre-wrap break-words max-h-32 overflow-y-auto slim-scroll bg-white rounded border border-blue-100 p-2">
                    {previewContent || '(空文档)'}
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === 'permissions' && (
            <div className="space-y-3">
              <p className="text-[10px] text-slate-400 leading-relaxed">
                配置文档级访问与合规策略。导出策略「禁止导出」会立即禁用
                「导出 Markdown」与「版权证据包导出」按钮（后端同步拦截）。
              </p>
              {permsMsg && (
                <div className="text-[10px] text-green-600 bg-green-50 rounded px-2 py-1.5">
                  ✅ {permsMsg}
                </div>
              )}
              {permsErr && (
                <div className="text-[10px] text-red-500 bg-red-50 rounded px-2 py-1.5">
                  {permsErr}
                </div>
              )}

              {/* 协作模式 */}
              <div>
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  协作模式
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['open', '公开协作', '所有人可实时协作'],
                      ['invited', '受邀协作', '仅协作者名单可协作'],
                    ] as const
                  ).map(([val, label, desc]) => (
                    <button
                      key={val}
                      onClick={() => setCollabMode(val)}
                      className={`text-left text-[10px] px-2.5 py-2 rounded-lg border transition-colors ${
                        collabMode === val
                          ? 'border-accent bg-accent/5 text-slate-700'
                          : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="block text-[9px] text-slate-400 mt-0.5">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 水印策略 */}
              <div>
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  水印策略
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['enforce', '强制水印', 'AI 内容一律注入水印'],
                      ['optional', '可选水印', '按需选择是否注入'],
                    ] as const
                  ).map(([val, label, desc]) => (
                    <button
                      key={val}
                      onClick={() => setWatermarkPolicy(val)}
                      className={`text-left text-[10px] px-2.5 py-2 rounded-lg border transition-colors ${
                        watermarkPolicy === val
                          ? 'border-accent bg-accent/5 text-slate-700'
                          : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="block text-[9px] text-slate-400 mt-0.5">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 导出策略 */}
              <div>
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  导出策略
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['allow', '允许导出', 'Markdown / 证据包可下载'],
                      ['deny', '禁止导出', '禁用导出与证据包 (后端拦截)'],
                    ] as const
                  ).map(([val, label, desc]) => (
                    <button
                      key={val}
                      onClick={() => setExportPolicy(val)}
                      className={`text-left text-[10px] px-2.5 py-2 rounded-lg border transition-colors ${
                        exportPolicy === val
                          ? 'border-amber-500 bg-amber-50 text-slate-700'
                          : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="block text-[9px] text-slate-400 mt-0.5">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 协作者 */}
              <div>
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  协作者 ({selectedIds.size} 人 · 文档所有者恒在名单中)
                </div>
                <ul className="space-y-1">
                  {(perms?.all_users ?? []).map((u) => {
                    const isOwner = u.user_id === perms?.owner_id;
                    const checked = selectedIds.has(u.user_id) || isOwner;
                    return (
                      <li key={u.user_id}>
                        <label
                          className={`flex items-center gap-2 text-[11px] px-2.5 py-1.5 rounded-lg border ${
                            checked
                              ? 'border-accent/30 bg-accent/5 text-slate-700'
                              : 'border-slate-200 bg-white text-slate-500'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isOwner}
                            onChange={() => toggleCollaborator(u.user_id)}
                            className="accent-slate-700"
                          />
                          <span className="flex-1">
                            {u.display_name}
                            <span className="text-[9px] text-slate-400 ml-1.5">
                              @{u.username}
                            </span>
                          </span>
                          {isOwner && (
                            <span className="text-[9px] text-slate-400">所有者</span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <button
                onClick={() => void doSavePerms()}
                disabled={permsSaving}
                className="w-full text-xs font-medium py-2 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 transition-colors"
              >
                {permsSaving ? '保存中...' : '保存权限配置'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
