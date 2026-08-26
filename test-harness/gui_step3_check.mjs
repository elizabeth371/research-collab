/**
 * GUI 实测: 写稿人润色 + 审稿人红牌 (第三步)
 * ============================================
 * 覆盖:
 *  1. 新建文档 + 输入 2 段 (第 1 段口语化, 第 2 段含无引用断言)
 *  2. 选中第 1 段 -> BubbleMenu -> 「润色」 -> 学术化替换 (AI 蓝色标记 + 提示 toast)
 *  3. Node 侧等待防抖保存落库 (waitForFunction async predicate 有 false-positive bug)
 *  4. 审稿人「开始审稿」-> 红牌横幅 (篇幅过短) + 黄牌卡片 (断言无引用, 第 2 段)
 *  5. 黄牌卡片「润色该段」-> 第 2 段被 AI 蓝色替换
 *  6. API 核查内容已落库 + console 0 错误 + 清理
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

    // 输入 2 段: 第 1 段口语化可润色, 第 2 段含断言 (无引用 -> 黄牌)
    await page.keyboard.type('我们做了很多实验，这个方法非常不错。');
    await page.keyboard.press('Enter');
    await page.keyboard.type('实验表明我们做了很多实验，效果非常不错。');
    check('已输入 2 个段落', (await page.locator('.ProseMirror > p').count()) === 2);

    // ---------- 3. 选中第 1 段 -> 润色 ----------
    await page.locator('.ProseMirror > p').nth(0).click();
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForSelector('.tippy-box:visible', { timeout: 5000 });
    const polishBtn = page.locator('.tippy-box:visible button[title^="写稿人润色"]');
    check('选中文字弹出浮动菜单(含润色按钮)', (await polishBtn.count()) > 0);

    await polishBtn.click();
    await page.waitForSelector('.polish-toast', { timeout: 8000 });
    const toastText = (await page.locator('.polish-toast').textContent()) || '';
    check('润色完成提示 toast', toastText.includes('已润色'), toastText);
    const p1After = (await page.locator('.ProseMirror > p').nth(0).textContent()) || '';
    check('第 1 段已替换为学术表达', p1After.includes('大量实验'), p1After);
    check('AI 蓝色标记已渲染', (await page.locator('.ProseMirror .author-ai').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/s3-润色后.png`, fullPage: false });

    // ---------- 4. 等待保存落库 (Node 侧轮询) ----------
    const deadline = Date.now() + 10000;
    let saved = false;
    while (Date.now() < deadline) {
      const docRes = await apiGet(`/api/documents/${newDocId}`);
      const content = docRes.json?.content || '';
      if (content.includes('大量实验')) {
        saved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    check('润色内容已落库', saved);

    // ---------- 5. 审稿人开始审稿 ----------
    await page.locator('button', { hasText: '开始审稿' }).click();
    await page.waitForSelector('.review-banner', { timeout: 10000 });
    const bannerText = (await page.locator('.review-banner-red').textContent()) || '';
    check('红牌警告横幅显示', bannerText.includes('红牌警告'), bannerText.trim().slice(0, 40));
    await page.waitForSelector('.review-card-warning', { timeout: 8000 });
    const assertionCard = page.locator('.review-card-warning', { hasText: '断言' });
    check('黄牌断言卡片存在', (await assertionCard.count()) > 0);
    check('问题卡片标注第 2 段', (await page.getByText('第 2 段', { exact: true }).count()) > 0);
    await page.screenshot({ path: `${SHOTS}/s3-审稿红牌.png`, fullPage: false });

    // ---------- 6. 黄牌卡片「润色该段」 ----------
    // 注意: 第 1 段润色后仍含断言词 ("结果表明"), 会与第 2 段同时产生黄牌断言
    // 卡片, 必须按段落号精确选择第 2 段的卡片
    const para2Card = page.locator('.review-card-warning').filter({ hasText: '第 2 段' }).first();
    await para2Card.locator('button', { hasText: '润色该段' }).click();
    await page.waitForSelector('.review-card-warning button:has-text("润色中")', { timeout: 5000 }).catch(() => {});
    const deadline2 = Date.now() + 10000;
    let para2Polished = false;
    while (Date.now() < deadline2) {
      const p2 = (await page.locator('.ProseMirror > p').nth(1).textContent()) || '';
      if (p2.includes('本研究开展了')) {
        para2Polished = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    check('润色该段后第 2 段已替换', para2Polished);
    await page.screenshot({ path: `${SHOTS}/s3-润色该段.png`, fullPage: false });

    // ---------- 7. API 终检 + console ----------
    const deadline3 = Date.now() + 10000;
    let apiOk = false;
    while (Date.now() < deadline3) {
      const docRes = await apiGet(`/api/documents/${newDocId}`);
      const content = docRes.json?.content || '';
      if (content.includes('本研究开展了')) {
        apiOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    check('API 内容已落库(含润色结果)', apiOk);
    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    if (page) await page.screenshot({ path: `${SHOTS}/s3-最终状态.png`, fullPage: true }).catch(() => {});
    await browser.close();
    if (newDocId) {
      const r = await fetch(`${API}/api/documents/${newDocId}`, { method: 'DELETE' });
      console.log(`清理测试文档 ${newDocId}: HTTP ${r.status}`);
    }
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP3_CHECK 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('GUI_STEP3_CHECK FAIL:', e);
  process.exit(1);
});
