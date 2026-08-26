/**
 * GUI 实测: Agent 群聊左栏 (第六步)
 * ============================================
 *  1. 发送指令 -> 用户气泡 + 三个 Agent 依次发言 (research/writer/supervisor)
 *  2. Writer 产出以 AI 蓝色写入编辑器
 *  3. 再次发送 -> 同一会话线程内多轮累积 (Research 气泡 x2)
 *  4. 开始审稿 -> Supervisor 审稿消息入列 + 红牌横幅 (新文档为空 -> 红牌)
 *  5. console 0 错误 + 清理测试文档
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

const main = async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  let docId = '';
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });
    await page.waitForSelector('text=已连接', { timeout: 20000 }).catch(() => {});

    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    docId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);

    // 面板标题为群聊
    check('面板标题为「Agent 群聊」', (await page.getByText('Agent 群聊').count()) > 0);

    const panel = page.locator('aside').first();
    const input = panel.locator('textarea[placeholder*="群发指令"]');
    const sendBtn = panel.locator('button').filter({ hasText: '发送' });
    const researchBubbles = () => panel.getByText('Research Agent', { exact: true }).count();

    // 1. 第一轮: 发送指令
    await input.fill('帮我检索关于 AI 水印与版权溯源的文献，并撰写一段引言');
    await sendBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('aside .bg-slate-800').length >= 1, { timeout: 8000 });
    check('用户气泡已显示', (await panel.locator('.bg-slate-800').count()) >= 1, '');

    // 三个 Agent 依次发言 (Node 侧轮询, 等待 pipeline 完成)
    const waitLabels = async (label, target, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await panel.getByText(label, { exact: true }).count()) >= target) return true;
        await new Promise((r) => setTimeout(r, 600));
      }
      return false;
    };
    const ok1 = await waitLabels('Research Agent', 1, 30000) &&
      (await waitLabels('Writer Agent', 1, 30000)) &&
      (await waitLabels('Supervisor Agent', 1, 30000));
    const r1 = await researchBubbles();
    check('第一轮三个 Agent 均已发言', ok1 && r1 === 1, `research bubbles=${r1}`);

    // Writer 产出写入编辑器 (AI 蓝色标记)
    await page.waitForSelector('.author-ai, [data-author="ai"]', { timeout: 10000 }).catch(() => {});
    const aiInDoc = await page.evaluate(() => !!document.querySelector('.ProseMirror [data-author="ai"], .ProseMirror .author-ai'));
    check('Writer 产出已以 AI 蓝色写入文档', aiInDoc);
    await page.screenshot({ path: `${SHOTS}/s6-群聊第一轮.png`, fullPage: false });

    // 2. 第二轮: 同一会话多轮追问
    await input.fill('再检索 CRDT 实时协同的文献，补充相关工作');
    await sendBtn.click();
    const ok2 = await waitLabels('Research Agent', 2, 30000);
    const r2 = await researchBubbles();
    check('第二轮多轮追问在同一线程累积 (Research x2)', ok2 && r2 === 2, `research bubbles=${r2}`);
    check('用户气泡累计 2 条', (await panel.locator('.bg-slate-800').count()) === 2, '');
    await page.screenshot({ path: `${SHOTS}/s6-群聊多轮.png`, fullPage: false });

    // 3. 开始审稿: 文档已含 Writer 内容, 结果横幅可能为红/琥珀/绿任一
    await panel.locator('button').filter({ hasText: '开始审稿' }).click();
    await page.waitForSelector('.review-banner', { timeout: 15000 });
    const bannerClass = await page
      .locator('.review-banner')
      .first()
      .getAttribute('class')
      .catch(() => '');
    check('审稿结果横幅出现', true, bannerClass.includes('red') ? '红牌' : bannerClass.includes('amber') ? '黄牌' : '通过');
    check('审稿结果以 Supervisor 消息入列', (await panel.getByText(/审稿完成|审稿通过/).count()) >= 1, '');

    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    if (page) await page.screenshot({ path: `${SHOTS}/s6-最终.png`, fullPage: true }).catch(() => {});
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${docId}: HTTP ${r.status}`);
    }
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP6_GROUPCHAT 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP6_GROUPCHAT FAIL:', e); process.exit(1); });
