/**
 * 批量截图脚本 (结题材料素材: PPT / 软著 / 研究总结报告)
 * ============================================
 * 自动创建演示文档并逐模块截取高清图:
 *  01 编辑器主界面(三栏)  02 Agent 群聊   03 审稿红牌/黄牌
 *  04 水印生成自检       05 全文检测结果  06 溯源链
 *  07 鲁棒性攻击矩阵     08 证据包导出    09 版本回溯
 *  10 权限管理           11 协作聊天      12 文献检索
 *  13 文档水印参数
 * 结束自动删除临时文档; 截图输出到 screenshots/s16-*.png
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const API = 'http://localhost:8000';
const SHOTS = 'E:/大创/test-harness/screenshots';

// 预设学术演示内容 (多段, 供 Agent/审稿/检测/溯源展示)
const DEMO_TEXT = [
  '近年来，人工智能生成内容（AIGC）在科研写作中的应用日益广泛，随之而来的学术诚信与版权溯源问题成为研究热点。如何在不影响文本流畅度的前提下，实现AI生成内容的可信标记与全流程溯源，是本系统研究的核心问题。',
  '本系统采用基于CRDT无冲突复制数据类型的实时协同编辑引擎，配合WebSocket长连接实现多人毫秒级同步。团队成员可以在同一块画布上并行写作，多光标与在线状态实时可见，显著降低跨时空协作的沟通成本。',
  '在水印溯源方面，系统实现了Kirchenbauer绿名单逻辑水印算法，在文本生成阶段完成隐形水印嵌入，并通过SHA-256哈希链记录每一次编辑、生成与检测操作，实现内容可识别、轨迹可回溯、权属可界定。',
].join('\n');

const results = [];
const shot = (name) => {
  const p = `${SHOTS}/${name}`;
  results.push(p);
  console.log(`  📸 ${name}`);
  return p;
};

const poll = async (fn, timeoutMs = 30000) => {
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

    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });

    // ---- 0. 新建临时文档 + 输入学术内容 ----
    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    docId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type(DEMO_TEXT, { delay: 1 });
    await page.waitForTimeout(3000); // 防抖保存落库

    // 重命名标题 (截图更专业) + 刷新重载
    await fetch(`${API}/api/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'AI 水印与科研协作 · 演示文档' }),
    });
    await page.reload();
    const reloaded = await poll(async () => {
      return (await page.locator('.ProseMirror').count()) > 0;
    }, 30000);
    if (!reloaded) {
      const body = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '(空)');
      throw new Error(`reload 后 ProseMirror 未出现, 页面内容: ${body}`);
    }
    await page.selectOption('header select', docId);

    // ---- 01 编辑器主界面 ----
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: shot('s16-01-编辑器主界面.png'), fullPage: false });

    // ---- 02 Agent 群聊 (真实 LLM 写稿) ----
    const agentPanel = page.locator('aside').first();
    await agentPanel.locator('textarea[placeholder*="群发指令"]').fill('请调研AI文本水印技术，并撰写一段关于水印保障科研诚信的引言');
    await agentPanel.locator('button').filter({ hasText: '发送' }).click();
    await poll(async () => (await agentPanel.getByText('Supervisor Agent', { exact: true }).count()) >= 1, 60000);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot('s16-02-Agent群聊.png'), fullPage: false });

    // ---- 03 审稿红牌/黄牌 ----
    await agentPanel.locator('button').filter({ hasText: '开始审稿' }).click();
    await page.waitForSelector('.review-banner', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('s16-03-审稿红牌黄牌.png'), fullPage: false });

    // ---- 04 水印生成自检 (真实 LLM) ----
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const wmPanel = page.locator('aside').last();
    await wmPanel.locator('button').filter({ hasText: '生成带水印文本并自检' }).click();
    await poll(async () => {
      const t = await wmPanel.innerText().catch(() => '');
      return t.includes('已注入水印') || t.includes('未达检出阈值');
    }, 90000);
    await page.screenshot({ path: shot('s16-04-水印生成自检.png'), fullPage: false });

    // ---- 05 全文检测结果 ----
    await wmPanel.locator('button').filter({ hasText: '检测当前文档全文并留痕' }).click();
    await poll(async () => {
      const t = await wmPanel.innerText().catch(() => '');
      return t.includes('AI 生成 (含水印)') || t.includes('人类创作');
    }, 30000);
    await page.screenshot({ path: shot('s16-05-全文检测结果.png'), fullPage: false });

    // ---- 06 溯源链 ----
    await page.locator('aside button').filter({ hasText: '溯源链' }).click();
    await poll(async () => {
      const t = await page.locator('aside').last().innerText().catch(() => '');
      return t.includes('插入') || t.includes('AI 生成');
    }, 20000);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('s16-06-溯源链.png'), fullPage: false });

    // ---- 07 鲁棒性攻击矩阵 ----
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    await wmPanel.locator('button').filter({ hasText: '对当前文档全文运行攻击矩阵' }).click();
    await poll(async () => {
      const t = await wmPanel.innerText().catch(() => '');
      return t.includes('攻击后统计量衰减') || t.includes('基线未检出');
    }, 60000);
    await page.screenshot({ path: shot('s16-07-鲁棒性攻击矩阵.png'), fullPage: false });

    // ---- 08 证据包导出 ----
    await page.evaluate(() => document.querySelector('aside')?.scrollTo(0, 0));
    await wmPanel.locator('text=版权证据包导出').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('s16-08-证据包导出.png'), fullPage: false });

    // ---- 13 文档水印参数 (显示密钥) ----
    await wmPanel.locator('text=文档水印参数').scrollIntoViewIfNeeded();
    await wmPanel.locator('button').filter({ hasText: '显示密钥' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('s16-13-文档水印参数.png'), fullPage: false });

    // ---- 09/10 文档设置: 版本回溯 + 权限管理 ----
    await page.locator('header button').filter({ hasText: '文档设置' }).click();
    const modal = page.locator('.fixed.inset-0');
    await modal.waitFor({ timeout: 5000 });
    await poll(async () => (await modal.locator('li').filter({ hasText: /第 \d+ 版/ }).count()) >= 1, 15000);
    await page.screenshot({ path: shot('s16-09-版本回溯.png'), fullPage: false });
    await modal.locator('button').filter({ hasText: '权限管理' }).click();
    await modal.locator('label').filter({ hasText: '李静雯' }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: shot('s16-10-权限管理.png'), fullPage: false });
    await modal.locator('button[title="关闭"]').click();

    // ---- 11 协作聊天 ----
    await page.locator('aside button').filter({ hasText: '协作聊天' }).click();
    const chatPanel = page.locator('aside').last();
    await poll(() => chatPanel.innerText().then((t) => t.includes('已连接')), 15000);
    await chatPanel.locator('textarea').fill('各位老师同学：这是同文档房间的实时讨论区，修改意见可以直接发在这里。');
    await chatPanel.locator('button').filter({ hasText: '发送' }).click();
    await chatPanel.locator('textarea').fill('例如：第三段的引用编号需要与参考文献表对应，稍后我来修正。');
    await chatPanel.locator('button').filter({ hasText: '发送' }).click();
    await poll(async () => {
      const t = await chatPanel.innerText().catch(() => '');
      return t.includes('引用编号需要与参考文献表对应');
    }, 15000);
    await page.screenshot({ path: shot('s16-11-协作聊天.png'), fullPage: false });

    // ---- 12 文献检索 ----
    await page.locator('aside button').filter({ hasText: '文献检索' }).click();
    const litPanel = page.locator('aside').last();
    await litPanel.locator('input[placeholder*="关键词"]').fill('水印');
    await litPanel.getByRole('button', { name: '检索', exact: true }).click();
    await poll(async () => {
      const t = await litPanel.innerText().catch(() => '');
      return t.includes('Watermark') || t.includes('水印');
    }, 20000).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('s16-12-文献检索.png'), fullPage: false });

    console.log(`\n共截取 ${results.length} 张图; console 错误 ${errors.length} 条`);
    if (errors.length) console.log('errors:', errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理临时文档 ${docId}: HTTP ${r.status}`);
    }
  }
};
main().catch((e) => { console.error('SCREENSHOTS FAIL:', e); process.exit(1); });
