/**
 * GUI 实测: 每文档独立水印密钥 + 参数面板 (第十二步)
 * ============================================
 *  1. 新建测试文档 -> 水印面板出现「文档水印参数」区块 (γ/δ 滑块 + 密钥指纹)
 *  2. 新文档密钥为独立随机密钥 (与全局密钥 hex 不同)
 *  3. 调整 γ/δ -> 保存参数并留痕 -> 成功提示
 *  4. 显示密钥 (64 hex) -> 重新生成密钥 -> 指纹变更
 *  5. 溯源面板出现「水印参数」留痕条目
 *  6. 每文档密钥闭环: 生成带水印文本(文档密钥) -> 插入 -> 全文检测仍检出
 *  7. console 0 错误 + 清理测试文档
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

    // 1. 新建测试文档 (自动生成独立密钥)
    await page.locator('header button').filter({ hasText: '新建文档' }).click();
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0 && (sel.options[sel.selectedIndex]?.textContent || '').startsWith('新建科研文档');
    }, { timeout: 15000 });
    docId = await page.evaluate(() => document.querySelector('select').options[document.querySelector('select').selectedIndex].value);

    // 2. 切到「水印检测」面板
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const panel = page.locator('aside').last();
    check('文档水印参数区块存在', (await panel.locator('text=文档水印参数').count()) > 0);

    // 新文档应为独立随机密钥: 轮询等待面板指纹等于该文档在 API 中的指纹
    // (避免跨文档竞态读到演示文档/全局密钥指纹 933ceb2d7e396144)
    const apiParams = await fetch(`${API}/api/watermark/documents/${docId}/params`).then((r) => r.json());
    const fp0 = `指纹 ${apiParams.key_fingerprint}`;
    const panelBound = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes(fp0);
    }, 15000);
    check('新文档密钥为独立随机密钥 (面板指纹与文档一致)', panelBound, fp0);

    // 3. 调整 γ/δ 并保存
    const gammaSlider = panel.locator('input[type=range]').nth(0);
    const deltaSlider = panel.locator('input[type=range]').nth(1);
    await gammaSlider.evaluate((el) => {
      el.value = '0.35';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await deltaSlider.evaluate((el) => {
      el.value = '4';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await panel.locator('button').filter({ hasText: '保存参数并留痕' }).click();
    const savedOk = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('已保存') && t.includes('溯源链');
    }, 15000);
    check('保存 γ/δ 参数成功 (含留痕提示)', savedOk);
    await page.screenshot({ path: `${SHOTS}/s12-参数面板.png`, fullPage: false });

    // 4. 显示密钥 -> 重新生成密钥 -> 指纹变更
    await panel.locator('button').filter({ hasText: '显示密钥' }).click();
    const keyHex = await panel.locator('text=/[0-9a-f]{64}/').first().innerText().catch(() => '');
    check('密钥 hex 展示 (64 字符)', /^[0-9a-f]{64}$/.test(keyHex.trim()));
    await panel.locator('button').filter({ hasText: '重新生成密钥' }).click();
    const regenOk = await poll(async () => {
      const t = await panel.innerText().catch(() => '');
      return t.includes('已生成新独立密钥');
    }, 15000);
    check('重新生成密钥成功', regenOk);
    const fp1 = await panel.locator('text=/指纹 [0-9a-f]{16}/').innerText().catch(() => '');
    check('密钥指纹已变更', fp0 !== fp1, `${fp0} -> ${fp1}`);

    // 5. 溯源面板出现「水印参数」留痕
    await page.locator('aside button').filter({ hasText: '溯源链' }).click();
    const provPanel = page.locator('aside').last();
    const provOk = await poll(async () => {
      const t = await provPanel.innerText().catch(() => '');
      return t.includes('水印参数');
    }, 15000);
    check('溯源链出现「水印参数」留痕条目', provOk);
    await page.screenshot({ path: `${SHOTS}/s12-溯源留痕.png`, fullPage: false });

    // 6. 每文档密钥闭环: 生成(文档密钥) -> 插入 -> 全文检测检出
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const panel2 = page.locator('aside').last();
    await panel2.locator('button').filter({ hasText: '生成带水印文本并自检' }).click();
    const genOk = await poll(async () => {
      const t = await panel2.innerText().catch(() => '');
      return t.includes('已注入水印') && /z=\d/.test(t);
    }, 60000);
    check('文档密钥下生成带水印文本并自检', genOk);
    await panel2.locator('button').filter({ hasText: '插入到文档末尾' }).click();
    await poll(async () => (await panel2.innerText()).includes('已插入文档末尾'), 10000);
    await page.waitForTimeout(2000); // 防抖保存
    await panel2.locator('button').filter({ hasText: '检测当前文档全文并留痕' }).click();
    const detectOk = await poll(async () => {
      const t = await panel2.innerText().catch(() => '');
      return t.includes('AI 生成 (含水印)');
    }, 30000);
    check('每文档密钥闭环: 全文检测仍检出 (生成/插入/检测口径一致)', detectOk);
    await page.screenshot({ path: `${SHOTS}/s12-密钥闭环.png`, fullPage: false });

    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (docId) {
      const r = await fetch(`${API}/api/documents/${docId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${docId}: HTTP ${r.status}`);
    }
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP12_PARAMS 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => { console.error('GUI_STEP12 FAIL:', e); process.exit(1); });
