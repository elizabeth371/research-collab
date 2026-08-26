/**
 * GUI 实测: 水印对抗鲁棒性实验 (第十一步)
 * ============================================
 *  1. 水印面板「AI 写作 + 水印注入演示」: 真实 DeepSeek 生成带水印文本并自检
 *  2. 「对刚生成的带水印文本运行」攻击矩阵 -> 基线 + 6 类攻击 z 值衰减表
 *  3. 汇总卡片: 检出 X/Y · 平均 z · 最小 z
 *  4. 勾选「机器翻译回译攻击」(真实 DeepSeek) 再次运行 -> 回译行出现
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
    const panel = page.locator('aside').last();
    check('水印面板 AI 写作演示区块存在', (await panel.locator('text=AI 写作 + 水印注入演示').count()) > 0);
    check('鲁棒性实验区块存在', (await panel.locator('text=水印对抗鲁棒性实验').count()) > 0);

    // 3. 生成带水印文本 (真实 DeepSeek, 需 5-20s)
    await panel.locator('button').filter({ hasText: '生成带水印文本并自检' }).click();
    const genOk = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('已注入水印') && /z=\d/.test(t);
    }, 60000);
    check('生成带水印文本并自检通过 (徽章+z值)', genOk);
    check('「对刚生成的带水印文本运行」按钮出现', (await panel.locator('button').filter({ hasText: '对刚生成的带水印文本运行' }).count()) > 0);

    // 4. 对刚生成的带水印文本运行攻击矩阵
    await panel.locator('button').filter({ hasText: '对刚生成的带水印文本运行' }).click();
    const tableOk = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('无攻击（基线）') && t.includes('随机删除 10% 字符') && t.includes('局部窗口乱序') && t.includes('平均 z');
    }, 30000);
    check('攻击矩阵表渲染 (基线+6类攻击+汇总)', tableOk);
    const t1 = await panel.innerText();
    const zBase = t1.match(/无攻击（基线）\s+100%\s+([\d.]+)/);
    check('基线 z 值展示', !!zBase, zBase ? `baseline z=${zBase[1]}` : '');
    const sum = t1.match(/检出 (\d+)\/(\d+)/);
    check('检出率汇总卡片展示', !!sum, sum ? `检出 ${sum[1]}/${sum[2]}` : '');
    const avgZ = t1.match(/平均 z\s+([\d.]+)/);
    const minZ = t1.match(/最小 z\s+([\d.]+)/);
    check('平均 z / 最小 z 汇总卡片展示', !!avgZ && !!minZ, avgZ && minZ ? `avg=${avgZ[1]} min=${minZ[1]}` : '');
    await page.screenshot({ path: `${SHOTS}/s11-攻击矩阵.png`, fullPage: false });

    // 5. 勾选真实机器翻译回译, 再次运行 -> 回译行出现
    await panel.locator('label').filter({ hasText: '机器翻译回译' }).locator('input').check();
    await panel.locator('button').filter({ hasText: '对刚生成的带水印文本运行' }).click();
    const transOk = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('机器翻译回译 zh→en→zh');
    }, 60000);
    check('真实机器翻译回译攻击行出现 (DeepSeek zh→en→zh)', transOk);
    await page.screenshot({ path: `${SHOTS}/s11-含回译攻击矩阵.png`, fullPage: false });

    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${docId}: HTTP ${r.status}`);
    }
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP11_ROBUSTNESS 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP11 FAIL:', e); process.exit(1); });
