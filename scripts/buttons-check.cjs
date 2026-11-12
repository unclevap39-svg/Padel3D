// Dev helper: checks the shot buttons — hold to charge the gauge, release to hit, joystick to
// aim, pause button reachable — on a phone-sized touch screen.
const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://localhost:5173';
  const proxy = base.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ proxy, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: !!proxy });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?q=low&noinstall`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 90000 });
  await page.evaluate(() => window.__padel.startMatch('quick', 0));
  await page.waitForFunction(() => window.__padel.sim.phase === 'serve_ready', null, { timeout: 20000 });
  await page.waitForTimeout(400);
  const prompt = await page.evaluate(() => document.querySelector('.prompt').textContent);
  const cdp = await ctx.newCDPSession(page);
  const pt = (x, y, id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
  const centre = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const state = () =>
    page.evaluate(() => {
      const g = window.__padel;
      const c = g.sim.humanCharge();
      const aim = g.markers.aim;
      return {
        phase: g.sim.phase,
        charge: c && { type: c.type, gauge: +c.gauge.toFixed(2), held: c.held },
        aimShown: aim.visible,
        aimAt: [+aim.position.x.toFixed(2), +aim.position.z.toFixed(2)],
        gaugeShown: document.querySelector('.gauge').classList.contains('show'),
        ring: getComputedStyle(document.querySelector('.shot-btn.drive')).getPropertyValue('--g'),
      };
    });

  // A swipe on the right of the screen (outside the buttons) does nothing.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(640, 120, 7)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(600, 40, 7)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  const afterSwipe = await state();

  // Serve: hold FRAPPE (the gauge fills, the aim marker sits in the service box), push the
  // joystick to move the marker, release to serve.
  const drive = await centre('.shot-btn.drive');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(drive.x, drive.y, 8)] });
  await page.waitForTimeout(450);
  const holding = await state();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(drive.x, drive.y, 8), pt(160, 250, 9)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(drive.x, drive.y, 8), pt(215, 250, 9)] });
  await page.waitForTimeout(200);
  const aimedRight = await state();
  await page.screenshot({ path: 'shots/buttons-serve.png' });
  // Lift the thumb off FRAPPE only (the joystick stays down): the serve must leave.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pt(drive.x, drive.y, 8)] });
  await page.waitForTimeout(1300);
  const afterServe = await page.evaluate(() => ({ phase: window.__padel.sim.phase, hits: window.__padel.sim.rallyHits, charge: window.__padel.sim.humanCharge() }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // Rally: wait for the opponents' ball, hold FRAPPE and take a picture of the markers.
  let rally = null;
  for (let i = 0; i < 400 && !rally; i++) {
    const s = await page.evaluate(() => {
      const g = window.__padel;
      return { phase: g.sim.phase, team: g.view.lastHitTeam, landing: g.markers.landing.visible };
    });
    if (s.phase === 'rally' && s.team === 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(drive.x, drive.y, 8)] });
      await page.waitForTimeout(300);
      rally = { ...(await state()), landing: s.landing };
      await page.screenshot({ path: 'shots/buttons-play.png' });
      await page.waitForTimeout(1500);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.waitForTimeout(50);
  }
  const afterRally = await page.evaluate(() => ({ phase: window.__padel.sim.phase, hits: window.__padel.sim.rallyHits }));

  // The pause button must be reachable through the touch layer.
  const pause = await centre('.pause-btn');
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [pause.x, pause.y]);
  await page.tap('.pause-btn');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => window.__padel.menu.current);
  await page.screenshot({ path: 'shots/buttons-pause.png' });
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.shot-btn')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), bottomGap: Math.round(innerHeight - r.bottom) }; }));
  console.log(JSON.stringify({ prompt, afterSwipe, holding, aimedRight, afterServe, rally, afterRally, pauseTop: top, paused, boxes, errors }, null, 1));
  await browser.close();
})();
