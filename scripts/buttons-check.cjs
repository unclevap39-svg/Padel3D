// Dev helper: checks button-only hitting — serve with FRAPPE, aim with the joystick, no swipe.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5173/?q=low&noinstall', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.evaluate(() => { const g = window.__padel; window.__shots = []; const orig = g.controls.onShot; g.controls.onShot = (i) => { window.__shots.push({ ...i }); orig(i); }; g.startMatch('quick', 0); });
  await page.waitForFunction(() => window.__padel.sim.phase === 'serve_ready', null, { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots/buttons-serve.png' });
  const prompt = await page.evaluate(() => document.querySelector('.prompt').textContent);
  // A swipe on the right of the screen (outside the buttons) must do nothing any more.
  const cdp = await ctx.newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 7, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(640, 120) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(600, 40) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const afterSwipe = await page.evaluate(() => ({ shots: window.__shots.length, phase: window.__padel.sim.phase }));
  await page.tap('.shot-btn.drive');
  await page.waitForTimeout(1500);
  const afterServe = await page.evaluate(() => ({ shots: window.__shots, phase: window.__padel.sim.phase, hits: window.__padel.sim.rallyHits }));
  // Hold the joystick to the left and press LOB: the shot must aim left.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(160, 250) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(100, 250) });
  const lob = await page.locator('.shot-btn.lob').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...pt(100, 250), { x: lob.x + lob.width / 2, y: lob.y + lob.height / 2, id: 8, radiusX: 4, radiusY: 4, force: 1 }] });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'shots/buttons-play.png' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const aimed = await page.evaluate(() => window.__shots[window.__shots.length - 1]);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.shot-btn')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), bottomGap: Math.round(innerHeight - r.bottom) }; }));
  console.log(JSON.stringify({ prompt, afterSwipe, afterServe, aimed, boxes, errors }, null, 1));
  await browser.close();
})();
