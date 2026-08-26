/**
 * GUI 实测: 文档设置——版本回溯 + 权限管理 (步骤 15)
 * ============================================
 *  1. 新建测试文档 -> 输入内容 -> 自动生成版本快照 (轮询 /versions)
 *  2. 继续编辑 -> 版本数增加
 *  3. 打开「⚙️ 文档设置」-> 版本回溯 tab -> 版本列表/预览
 *  4. 恢复到第 1 版 -> 编辑器内容回退 (协同会话重建)
 *  5. 权限管理: 导出策略 deny -> 导出 Markdown 按钮禁用 + 证据包禁用
 *  6. 权限改回 allow -> 导出恢复
 *  7. 受邀协作模式 + 勾选协作者 -> 保存成功
 *  8. console 0 错误 + 清理测试文档
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const API = 'http://localhost:8000';
const SHOTS = 'E:/大创/test-harness/screenshots';

const results = [];
const check = (name, cond, detail = '') => {
  results.push([name, !!cond]);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail}`);
};

const poll = async (fn, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const main = async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  let docId = '';
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept()); // 恢复版本 confirm 一律接受

    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });

    // 1. 新建测试文档 + 输入第一段
    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    docId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('版本回溯测试第一段内容。');
    check('第一段已输入', (await page.locator('.ProseMirror > p').count()) >= 1);

    // 等第一个版本快照落库
    const v1 = await poll(async () => {
      const r = await fetch(`${API}/api/documents/${docId}/versions`).then((x) => x.json());
      return r.total >= 1;
    }, 20000);
    check('内容保存后自动生成版本快照', v1);

    // 2. 追加第二段 -> 版本数 >= 2
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二段补充内容。');
    const v2 = await poll(async () => {
      const r = await fetch(`${API}/api/documents/${docId}/versions`).then((x) => x.json());
      return r.total >= 2;
    }, 20000);
    check('继续编辑后版本数增加 (>=2)', v2);
    await page.waitForTimeout(1500); // 防抖保存

    // 3. 打开文档设置 -> 版本回溯
    await page.locator('header button').filter({ hasText: '文档设置' }).click();
    const modal = page.locator('.fixed.inset-0');
    await modal.waitFor({ timeout: 5000 });
    check('设置弹窗打开 (版本回溯 tab 默认)', (await modal.locator('text=版本回溯').count()) > 0);
    const verCards = modal.locator('li').filter({ hasText: /第 \d+ 版/ });
    const listOk = await poll(
      async () => (await verCards.count()) >= 2,
      10000
    );
    check('版本列表展示', listOk, `卡片数=${await verCards.count().catch(() => 0)}`);

    // 预览第 1 版
    const v1Card = modal.locator('li').filter({ hasText: '第 1 版' }).first();
    await v1Card.locator('button').filter({ hasText: '预览' }).click();
    const previewOk = await poll(async () => {
      const t = await modal.innerText().catch(() => '');
      return t.includes('内容预览') && t.includes('版本回溯测试第一段内容');
    }, 10000);
    check('版本预览显示第 1 版内容', previewOk);
    await page.screenshot({ path: `${SHOTS}/s15-版本列表.png`, fullPage: false });

    // 4. 恢复第 1 版 (confirm 已自动接受) -> 编辑器内容回退
    await v1Card.locator('button').filter({ hasText: '恢复此版本' }).click();
    const restored = await poll(async () => {
      // 恢复会重挂载编辑器 (key 变化), 等新 ProseMirror 文本为第 1 版内容
      const txt = await page.locator('.ProseMirror').innerText().catch(() => '');
      return txt.includes('版本回溯测试第一段内容') && !txt.includes('第二段补充内容');
    }, 20000);
    check('恢复到第 1 版: 编辑器内容回退', restored, (await page.locator('.ProseMirror').innerText().catch(() => '')).slice(0, 30));

    // 恢复留痕: 溯源链出现 version_restore
    const restoreLogged = await poll(async () => {
      const prov = await fetch(`${API}/api/watermark/documents/${docId}/provenance`).then((x) => x.json());
      return prov.some((l) => l.operation?.action === 'version_restore');
    }, 15000);
    check('恢复动作写入溯源链 (version_restore)', restoreLogged);

    // 5. 权限管理: 导出策略 deny
    await modal.locator('button').filter({ hasText: '权限管理' }).click();
    await modal.locator('button').filter({ hasText: '禁止导出' }).click();
    await modal.locator('button').filter({ hasText: '保存权限配置' }).click();
    const savedDeny = await poll(async () => {
      const t = await modal.innerText().catch(() => '');
      return t.includes('权限配置已保存');
    }, 15000);
    check('导出策略改为禁止并保存', savedDeny);
    await page.screenshot({ path: `${SHOTS}/s15-权限管理.png`, fullPage: false });

    // 关闭弹窗 -> 导出按钮禁用
    await modal.locator('button[title="关闭"]').click();
    await page.waitForTimeout(800);
    const exportBtn = page.locator('header button').filter({ hasText: '已禁止导出' });
    check('「导出 Markdown」变为已禁止且禁用', (await exportBtn.count()) > 0);

    // 水印面板证据包按钮禁用
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const wmPanel = page.locator('aside').last();
    const evidenceDisabled = await wmPanel
      .locator('button', { hasText: 'PDF' })
      .first()
      .isDisabled()
      .catch(() => false);
    check('证据包导出按钮已禁用 (PDF)', evidenceDisabled);
    check('证据包区块显示禁止提示', (await wmPanel.locator('text=已设置禁止导出').count()) > 0);

    // 6. 权限改回 allow -> 导出恢复
    await page.locator('header button').filter({ hasText: '文档设置' }).click();
    await modal.waitFor({ timeout: 5000 });
    await modal.locator('button').filter({ hasText: '权限管理' }).click();
    // 等待权限表单加载完成 (协作者列表渲染) 后再操作, 避免异步加载覆盖选择
    await modal.locator('label').filter({ hasText: '李静雯' }).waitFor({ timeout: 10000 });
    await modal.locator('button').filter({ hasText: '允许导出' }).click();
    // 协作模式受邀 + 勾选协作者
    await modal.locator('button').filter({ hasText: '受邀协作' }).click();
    const liLabel = modal.locator('label').filter({ hasText: '李静雯' });
    if ((await liLabel.count()) > 0) {
      const cb = liLabel.locator('input[type=checkbox]');
      if (!(await cb.isChecked())) await cb.check();
    }
    await modal.locator('button').filter({ hasText: '保存权限配置' }).click();
    await poll(async () => (await modal.innerText().catch(() => '')).includes('权限配置已保存'), 15000);
    await modal.locator('button[title="关闭"]').click();
    await page.waitForTimeout(800);
    const exportRestored = await poll(async () => {
      const r = await fetch(`${API}/api/documents/${docId}/permissions`).then((x) => x.json());
      return r.export_policy === 'allow';
    }, 10000);
    check('导出策略恢复 allow (API 确认)', exportRestored);
    check('导出按钮恢复可用', (await page.locator('header button').filter({ hasText: '导出 Markdown' }).count()) > 0);

    const permSaved = await fetch(`${API}/api/documents/${docId}/permissions`).then((x) => x.json());
    check('受邀协作 + 协作者已保存', permSaved.collab_mode === 'invited' && permSaved.collaborators.length >= 2,
      `mode=${permSaved.collab_mode} collaborators=${permSaved.collaborators.length}`);

    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${docId}: HTTP ${r.status}`);
    }
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP14_SETTINGS 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP14 FAIL:', e); process.exit(1); });
