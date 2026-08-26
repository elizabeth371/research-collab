/**
 * GUI 实测: 水印可视化闭环 (第十步)
 * ============================================
 *  1. 水印面板「AI 写作 + 水印注入演示」: 真实 DeepSeek 生成带水印文本
 *     并自检 -> 「已注入水印」徽章 + z 值展示
 *  2. 一键插入文档末尾 (AI 蓝色标记)
 *  3. 检测当前文档全文并留痕 -> 判定「AI 生成 (含水印)」+ z/绿名单统计量
 *  4. Agent 群聊: Writer 草稿气泡出现「🔵 已加水印」徽章 (LLM 水印路径)
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

    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });

    // 1. 新建测试文档
    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    docId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);

    // 2. 切到「水印检测」面板
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const genBlock = page.locator('aside').last().locator('text=AI 写作 + 水印注入演示');
    check('水印面板 AI 写作演示区块存在', (await genBlock.count()) > 0);

    // 3. 生成带水印文本 (真实 DeepSeek, 需 5-20s)
    await page.locator('aside').last().locator('button').filter({ hasText: '生成带水印文本并自检' }).click();
    const genOk = await poll(async () => {
      const t = await page.locator('aside').last().innerText().catch(() => '');
      return t.includes('已注入水印') && /z=\d/.test(t);
    }, 60000);
    check('生成带水印文本并自检通过 (徽章+z值)', genOk);
    const genText = await page.locator('aside').last().innerText();
    const zMatch = genText.match(/z=([\d.]+)/);
    check('z 值已展示', !!zMatch, zMatch ? `z=${zMatch[1]}` : '');
    await page.screenshot({ path: `${SHOTS}/s10-生成水印.png`, fullPage: false });

    // 4. 插入文档末尾 (AI 蓝色标记)
    await page.locator('aside').last().locator('button').filter({ hasText: '插入到文档末尾' }).click();
    const inserted = await poll(async () => {
      const t = await page.locator('aside').last().innerText().catch(() => '');
      return t.includes('已插入文档末尾');
    }, 10000);
    check('带水印文本已插入文档', inserted);
    // 等待防抖保存落库
    await page.waitForTimeout(2000);

    // 5. 检测当前文档全文并留痕 -> 判定 AI 生成
    await page.locator('aside').last().locator('button').filter({ hasText: '检测当前文档全文并留痕' }).click();
    const detectOk = await poll(async () => {
      const t = await page.locator('aside').last().innerText().catch(() => '');
      return t.includes('AI 生成 (含水印)') && t.includes('z 统计量');
    }, 30000);
    check('文档全文检测判定 AI 生成 (含 z/绿名单统计量)', detectOk);
    const detText = await page.locator('aside').last().innerText();
    const m = detText.match(/z 统计量\s+([\d.]+)/);
    check('z 统计量卡片展示', !!m, m ? `z=${m[1]}` : '');
    const gf = detText.match(/绿名单命中\s+(\d+)%/);
    check('绿名单命中率卡片展示', !!gf, gf ? `gf=${gf[1]}%` : '');
    await page.screenshot({ path: `${SHOTS}/s10-文档检测.png`, fullPage: false });

    // 6. Agent 群聊: Writer 草稿「🔵 已加水印」徽章 (真实 LLM 水印路径)
    const panel = page.locator('aside').first();
    await panel.locator('textarea').fill('请基于水印技术撰写一段论文引言草稿');
    await panel.locator('button').filter({ hasText: '发送' }).click();
    const badgeShown = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('已加水印');
    }, 90000);
    check('Writer 草稿气泡「🔵 已加水印」徽章', badgeShown);
    await page.screenshot({ path: `${SHOTS}/s10-writer徽章.png`, fullPage: false });

    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${docId}: HTTP ${r.status}`);
    }
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP10_WATERMARK_VISUAL 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP10 FAIL:', e); process.exit(1); });
