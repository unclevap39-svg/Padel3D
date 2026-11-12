// Dev helper: drive the game in a phone-sized viewport and capture frames.
// Usage: node scripts/play.cjs <prefix> <query> <json steps>
// A step is {wait:ms} | {shot:"name"} | {eval:"js"} | {tap:[x,y]} | {swipe:[x0,y0,x1,y1]} | {stick:[x0,y0,x1,y1,holdMs]}
const { chromium } = require('playwright');
(async () => {
  const [prefix = 'shots/p', query = '?q=high&noinstall', stepsJson = '[]', dsf = '1'] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: Number(dsf), isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console error]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5173/' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  for (const s of JSON.parse(stepsJson)) {
    if (s.wait) await page.waitForTimeout(s.wait);
    if (s.shot) { await page.screenshot({ path: `${prefix}-${s.shot}.png` }); console.log('saved', `${prefix}-${s.shot}.png`); }
    if (s.eval) console.log('eval:', JSON.stringify(await page.evaluate(s.eval)));
    if (s.tap) await page.touchscreen.tap(s.tap[0], s.tap[1]);
    if (s.swipe || s.stick) {
      const [x0, y0, x1, y1, hold = 0] = s.swipe || s.stick;
      const cdp = await ctx.newCDPSession(page);
      const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6) });
      if (hold) await page.waitForTimeout(hold);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  }
  await browser.close();
})();
