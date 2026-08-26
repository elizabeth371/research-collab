/**
 * GUI 实测: 段落级批注/评论 (师门共研 - 第二步)
 * ============================================
 * 覆盖:
 *  1. 新建文档 + 输入 3 个段落
 *  2. 选中段落文字 -> BubbleMenu -> 点击"批注"打开批注面板 ("批注 · 第 N 段")
 *  3. 输入批注内容 -> "添加批注" -> 段尾徽章 "批注 1" 渲染
 *  4. API 核查: GET /api/documents/{id}/comments 返回批注 (para_index/snapshot/author)
 *  5. 多段批注: 第 2、3 段各加一条, 徽章数量 = 2
 *  6. 漂移检测: 修改锚定段文本后点击徽章, 面板显示"段落内容已修改"
 *  7. 删除批注: 徽章数量随之减少
 *  8. 刷新后徽章从后端重新渲染 (持久化闭环)
 *  9. console 0 错误 + 截图
 * 测试文档最后经 DELETE API 清理 (连带其 comments 由后端级联删除)。
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

const apiGet = async (path) => {
  const r = await fetch(API + path);
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
};

const main = async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  let newDocId = '';
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    // ---------- 1. 页面加载 ----------
    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });
    await page.waitForSelector('text=已连接', { timeout: 20000 }).catch(() => {});
    check('状态栏显示已连接', (await page.getByText('已连接').count()) > 0);

    // ---------- 2. 新建文档 ----------
    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    newDocId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);
    check('新建文档已创建并切换', !!newDocId, newDocId);

    const editor = page.locator('.ProseMirror');
    await editor.click();

    // 输入 3 个段落
    await page.keyboard.type('第一段：研究背景与意义综述。');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二段：核心算法设计与实现思路。');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第三段：实验验证与结果分析总结。');
    check('已输入 3 个段落', (await page.locator('.ProseMirror > p').count()) === 3);

    // ---------- 3. 第 2 段批注: 选中文字 -> 浮动菜单 -> 批注 ----------
    // 选中整段: 点击段落后 End + Shift+Home (p 元素为整行宽, 双击空白处会选中换行符)
    await page.locator('.ProseMirror > p').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForSelector('.tippy-box:visible', { timeout: 5000 });
    const bubbleOk = (await page.locator('.tippy-box:visible button[title="添加段落批注"]').count()) > 0;
    check('选中文字弹出浮动菜单(含批注按钮)', bubbleOk);

    await page.locator('.tippy-box:visible button[title="添加段落批注"]').click();
    await page.waitForSelector('text=批注 · 第 2 段', { timeout: 5000 });
    check('批注面板打开(第 2 段)', (await page.getByText('批注 · 第 2 段').count()) > 0);
    check('面板显示锚定段落', (await page.getByText('锚定段落').count()) > 0);

    await page.getByPlaceholder('写下批注, 与同门交流...').fill('第二段批注内容-CMT001');
    await page.locator('button', { hasText: '添加批注' }).click();
    await page.waitForSelector('.comment-badge', { timeout: 8000 });
    check('段尾渲染徽章 批注 1', (await page.locator('.comment-badge', { hasText: '批注 1' }).count()) === 1);

    // ---------- 4. 第 3 段批注 ----------
    await page.locator('.ProseMirror > p').nth(2).click();
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForSelector('.tippy-box:visible', { timeout: 5000 });
    await page.locator('.tippy-box:visible button[title="添加段落批注"]').click();
    await page.waitForSelector('text=批注 · 第 3 段', { timeout: 5000 });
    await page.getByPlaceholder('写下批注, 与同门交流...').fill('第三段批注内容-CMT002');
    await page.locator('button', { hasText: '添加批注' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.comment-badge').length === 2, { timeout: 8000 });
    check('两段各渲染一枚徽章', (await page.locator('.comment-badge').count()) === 2);

    // ---------- 5. API 核查 ----------
    let list = (await apiGet(`/api/documents/${newDocId}/comments`)).json || [];
    check('API 返回 2 条批注', list.length === 2, JSON.stringify(list.map((c) => c.para_index)));
    const c1 = list.find((c) => c.para_index === 2);
    check('批注1 para_index=2', !!c1 && c1.para_index === 2);
    check('批注1 内容正确', !!c1 && c1.content === '第二段批注内容-CMT001');
    check('批注1 snapshot=锚定文本', !!c1 && c1.para_snapshot === '第二段：核心算法设计与实现思路。');
    check('批注1 author 非空', !!c1 && typeof c1.author === 'string' && c1.author.length > 0, c1?.author);
    const c2 = list.find((c) => c.para_index === 3);
    check('批注2 para_index=3', !!c2 && c2.para_index === 3);
    await page.screenshot({ path: `${SHOTS}/cmt-两段批注.png`, fullPage: false });

    // ---------- 6. 漂移检测: 修改锚定段文本 ----------
    await page.locator('.ProseMirror > p').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type('【已修改】');
    await page.waitForTimeout(300);
    await page.locator('.comment-badge').first().click();
    await page.waitForSelector('text=批注 · 第 2 段', { timeout: 5000 });
    const driftShown = (await page.getByText('段落内容已修改, 批注仍保留').count()) > 0;
    check('修改文本后徽章面板显示漂移提示', driftShown);
    check('面板仍显示原批注内容', (await page.getByText('第二段批注内容-CMT001').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/cmt-漂移提示.png`, fullPage: false });

    // ---------- 7. 删除第 3 段批注 ----------
    // 关闭第 2 段面板, 再打开第 3 段
    await page.locator('button[title="关闭批注面板"]').click();
    await page.locator('.comment-badge').nth(1).click();
    await page.waitForSelector('text=批注 · 第 3 段', { timeout: 5000 });
    await page.locator('button', { hasText: '删除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.comment-badge').length === 1, { timeout: 8000 });
    check('删除批注后徽章减为 1', (await page.locator('.comment-badge').count()) === 1);
    await page.locator('button[title="关闭批注面板"]').click();

    // ---------- 8. 刷新后徽章从后端重渲染 ----------
    // 先等防抖保存落库, 避免刷新与保存竞争 (内容须含【已修改】, 批注剩 1 条)。
    // 注意: 不能用 page.waitForFunction 的 async predicate —— 其内部将
    // Promise 对象视为真值, 首次求值即返回, 不等真实结果 (debug_wff2.mjs 证实)。
    const deadline = Date.now() + 10000;
    let saved = false;
    while (Date.now() < deadline) {
      const docRes = await apiGet(`/api/documents/${newDocId}`);
      const content = docRes.json?.content || '';
      const comments = (await apiGet(`/api/documents/${newDocId}/comments`)).json || [];
      if (content.includes('【已修改】') && comments.length === 1) {
        saved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    check('内容【已修改】与批注已落库(保存完成)', saved);
    await page.reload();
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });
    await page.locator('select').selectOption(newDocId);
    await page.waitForSelector('.comment-badge', { timeout: 8000 });
    check('刷新后徽章重新渲染', (await page.locator('.comment-badge', { hasText: '批注 1' }).count()) === 1);
    list = (await apiGet(`/api/documents/${newDocId}/comments`)).json || [];
    check('刷新后 API 剩 1 条批注', list.length === 1 && list[0].para_index === 2, list[0]?.para_index);

    // 再次点击徽章: 面板显示第 2 段 + 漂移提示 (段落文本已持久化为修改后内容)
    await page.locator('.comment-badge').click();
    await page.waitForSelector('text=批注 · 第 2 段', { timeout: 5000 });
    check('刷新后徽章打开第 2 段面板', (await page.getByText('第二段批注内容-CMT001').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/cmt-刷新后.png`, fullPage: false });

    // ---------- 9. console 错误 ----------
    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    if (page) await page.screenshot({ path: `${SHOTS}/cmt-最终状态.png`, fullPage: true }).catch(() => {});
    await browser.close();
    if (newDocId) {
      const r = await fetch(`${API}/api/documents/${newDocId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${newDocId}: HTTP ${r.status}`);
    }
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_COMMENT_CHECK 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('GUI_COMMENT_CHECK FAIL:', e);
  process.exit(1);
});
