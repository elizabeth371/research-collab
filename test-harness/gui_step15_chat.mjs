/**
 * GUI 实测: 协作聊天 (步骤 16)
 * ============================================
 *  1. 右侧出现「协作聊天」页签
 *  2. 双标签页打开同一文档 -> 页 A 发送 -> 页 B 实时收到
 *  3. 页 B 回复 -> 页 A 收到 (双向)
 *  4. 刷新页 B -> 历史消息从后端加载 (持久化闭环)
 *  5. 连接状态显示「已连接」
 *  6. console 0 错误 (不创建文档, 无清理需求)
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
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
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const main = async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  let pageA;
  let pageB;
  try {
    pageA = await ctx.newPage();
    pageB = await ctx.newPage();
    const errsA = [];
    pageA.on('console', (m) => m.type() === 'error' && errsA.push(m.text()));
    pageA.on('pageerror', (e) => errsA.push(String(e)));
    const errsB = [];
    pageB.on('console', (m) => m.type() === 'error' && errsB.push(m.text()));
    pageB.on('pageerror', (e) => errsB.push(String(e)));

    await pageA.goto(BASE);
    await pageA.waitForSelector('.ProseMirror', { timeout: 20000 });
    await pageB.goto(BASE);
    await pageB.waitForSelector('.ProseMirror', { timeout: 20000 });

    // 1. 右侧出现「协作聊天」页签并打开
    await pageA.locator('aside button').filter({ hasText: '协作聊天' }).click();
    const chatPanelA = pageA.locator('aside').last();
    check('协作聊天页签存在', (await pageA.locator('aside button').filter({ hasText: '协作聊天' }).count()) > 0);
    await poll(() => (chatPanelA.innerText().then((t) => t.includes('已连接'))), 15000);
    check('页 A 聊天连接已建立', (await chatPanelA.innerText().catch(() => '')).includes('已连接'));

    await pageB.locator('aside button').filter({ hasText: '协作聊天' }).click();
    const chatPanelB = pageB.locator('aside').last();

    // 2. 页 A 发送 -> 页 B 实时收到
    await chatPanelA.locator('textarea').fill('步骤16 协作聊天：第一篇消息');
    await chatPanelA.locator('button').filter({ hasText: '发送' }).click();
    const bGot = await poll(async () => {
      const t = await chatPanelB.innerText().catch(() => '');
      return t.includes('步骤16 协作聊天：第一篇消息');
    }, 20000);
    check('页 A 发送 -> 页 B 实时收到', bGot);
    const aGotSelf = (await chatPanelA.innerText().catch(() => '')).includes('步骤16 协作聊天：第一篇消息');
    check('页 A 自己消息回显 (广播含发送者)', aGotSelf);

    // 3. 页 B 回复 -> 页 A 收到 (双向)
    await chatPanelB.locator('textarea').fill('页 B 收到，回复确认。');
    await chatPanelB.locator('button').filter({ hasText: '发送' }).click();
    const aGotReply = await poll(async () => {
      const t = await chatPanelA.innerText().catch(() => '');
      return t.includes('页 B 收到，回复确认。');
    }, 20000);
    check('页 B 回复 -> 页 A 实时收到', aGotReply);
    await pageA.screenshot({ path: `${SHOTS}/s16-协作聊天.png`, fullPage: false });

    // 4. 刷新页 B -> 历史消息从后端加载 (持久化闭环)
    await pageB.reload();
    await pageB.waitForSelector('.ProseMirror', { timeout: 20000 });
    await pageB.locator('aside button').filter({ hasText: '协作聊天' }).click();
    const panelB2 = pageB.locator('aside').last();
    const histOk = await poll(async () => {
      const t = await panelB2.innerText().catch(() => '');
      return t.includes('步骤16 协作聊天：第一篇消息') && t.includes('页 B 收到，回复确认。');
    }, 20000);
    check('刷新后历史消息从后端加载 (持久化)', histOk);

    check('页 A console 0 错误', errsA.length === 0, errsA.slice(0, 2).join(' | '));
    check('页 B console 0 错误', errsB.length === 0, errsB.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP15_CHAT 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP15 FAIL:', e); process.exit(1); });
