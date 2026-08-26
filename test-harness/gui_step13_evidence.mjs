/**
 * GUI 实测: 版权证据包导出 (第十三步)
 * ============================================
 *  1. 水印面板出现「版权证据包导出」区块 (PDF / Markdown / JSON 三个按钮)
 *  2. 点击 PDF -> 后端返回合法 PDF (%PDF 头), 浏览器触发下载 (文件名 evidence-*.pdf)
 *  3. 点击 Markdown -> 内容包含「版权证据包 / package_hash / 溯源链」
 *  4. 点击 JSON -> 结构完整 (document/watermark_params/provenance/live_detect/package_hash)
 *  5. console 0 错误
 *  不创建任何文档 (证据包导出为只读操作, 不污染数据库)
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const SHOTS = 'E:/大创/test-harness/screenshots';

const results = [];
const check = (name, cond, detail = '') => {
  results.push([name, !!cond]);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail}`);
};

const main = async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(BASE);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });

    // 记录当前文档 (默认文档, 只读导出)
    await page.waitForFunction(() => {
      const sel = document.querySelector('select');
      return sel && sel.selectedIndex >= 0;
    }, { timeout: 15000 });
    const docId = await page.evaluate(
      () => document.querySelector('select').options[document.querySelector('select').selectedIndex].value
    );
    console.log(`当前文档: ${docId}`);

    // 切到「水印检测」面板
    await page.locator('aside button').filter({ hasText: '水印检测' }).click();
    const panel = page.locator('aside').last();
    check('证据包导出区块存在', (await panel.locator('text=版权证据包导出').count()) > 0);

    // 依次导出三种格式: 每个按钮点击后捕获 /evidence 响应 + 下载事件
    const captureAndCheck = async (fmt, label) => {
      const dlPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const respPromise = page.waitForResponse(
        (r) => r.url().includes(`/evidence?format=${fmt}`),
        { timeout: 30000 }
      );
      await panel.locator('button').filter({ hasText: label }).click();
      const resp = await respPromise;
      const bytes = await resp.body();
      const download = await dlPromise;
      return { resp, bytes, download };
    };

    // PDF
    const pdf = await captureAndCheck('pdf', 'PDF');
    check(
      'PDF 证据包返回合法 PDF',
      pdf.resp.status() === 200 &&
        (pdf.resp.headers()['content-type'] || '').includes('application/pdf') &&
        bytesToStr(pdf.bytes.slice(0, 4)) === '%PDF' &&
        pdf.bytes.length > 5000,
      `${pdf.bytes.length} bytes`
    );
    check(
      'PDF 触发浏览器下载 (evidence-*.pdf)',
      !!pdf.download && /evidence-.*\.pdf$/.test(pdf.download.suggestedFilename()),
      pdf.download ? pdf.download.suggestedFilename() : '(未捕获下载事件)'
    );

    // Markdown
    const md = await captureAndCheck('md', 'Markdown');
    const mdText = bytesToStr(md.bytes);
    check(
      'Markdown 证据包包含关键章节',
      md.resp.status() === 200 &&
        mdText.includes('版权证据包') &&
        mdText.includes('溯源链') &&
        mdText.includes('package_hash'),
      `${md.bytes.length} bytes`
    );
    check(
      'Markdown 触发浏览器下载',
      !!md.download && /evidence-.*\.md$/.test(md.download.suggestedFilename()),
      md.download ? md.download.suggestedFilename() : '(未捕获下载事件)'
    );

    // JSON
    const js = await captureAndCheck('json', 'JSON');
    let jsonOk = false;
    let jsonDetail = `${js.bytes.length} bytes`;
    if (js.resp.status() === 200) {
      try {
        const data = JSON.parse(bytesToStr(js.bytes));
        jsonOk =
          data.document &&
          data.watermark_params?.key_fingerprint &&
          data.provenance?.chain_valid &&
          data.live_detect &&
          /^[0-9a-f]{64}$/.test(data.package_hash || '');
        jsonDetail = `package_hash=${(data.package_hash || '').slice(0, 12)}... 链校验=${data.provenance?.chain_valid?.valid}`;
      } catch (e) {
        jsonDetail = `JSON 解析失败: ${e.message}`;
      }
    }
    check('JSON 证据包结构完整 (含 package_hash)', jsonOk, jsonDetail);
    check(
      'JSON 触发浏览器下载',
      !!js.download && /evidence-.*\.json$/.test(js.download.suggestedFilename()),
      js.download ? js.download.suggestedFilename() : '(未捕获下载事件)'
    );

    await page.screenshot({ path: `${SHOTS}/s13-证据包导出.png`, fullPage: false });
    check('console 0 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n=== GUI_STEP13_EVIDENCE 汇总: ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed === 0 ? 0 : 1);
};

const bytesToStr = (b) => Buffer.from(b).toString('utf8');

main().catch((e) => { console.error('GUI_STEP13 FAIL:', e); process.exit(1); });
