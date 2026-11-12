// Dev helper: plays a mode from the home screen to its result, then buys an item and reloads.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5173/?q=low&noinstall', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const coins0 = await page.evaluate(() => window.__padel.profile.coins);
  await page.click('.mode-card[data-mode=tiebreak]');
  await page.click('.play-btn');
  await page.waitForTimeout(800);
  const started = await page.evaluate(() => { const g = window.__padel; return { phase: g.sim.phase, tiebreak: g.sim.match.scoring.tiebreak, homeHidden: document.querySelector('.home').classList.contains('hidden') }; });
  // Fast-forward: the "human" only serves, so the opponents win the tie-break.
  await page.evaluate(() => { const g = window.__padel; let n = 0; while (g.sim.phase !== 'match_over' && n < 2e6) { if (g.sim.phase === 'serve_ready' && g.sim.server.id === 0) g.sim.humanShot({ type: 'drive', power: 0.5, aim: 0 }); g.sim.tick(); n++; if (n % 500 === 0) g.handleEvents(g.sim.drainEvents()); } });
  await page.waitForTimeout(1500);
  const end = await page.evaluate(() => ({ screen: window.__padel.menu.current, text: document.querySelector('.menu .panel').innerText.replace(/\s+/g, ' '), coins: window.__padel.profile.coins, stats: window.__padel.profile.stats.matches }));
  await page.screenshot({ path: 'shots/flow-end.png' });
  await page.click('.menu [data-act=quit]');
  await page.waitForTimeout(1200);
  const home = await page.evaluate(() => ({ visible: !document.querySelector('.home').classList.contains('hidden'), wallet: document.querySelector('.wallet b').textContent }));
  // Shop: give enough coins, buy a court, check it is applied and persisted.
  await page.evaluate(() => { window.__padel.profile.coins = 5000; });
  await page.click('.home-nav [data-tab=shop]');
  await page.click('.chips [data-kind=court]');
  await page.click('[data-item="court.violet"]');
  await page.click('.act-btn[data-act=buy]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/flow-court.png' });
  const bought = await page.evaluate(() => { const g = window.__padel; return { coins: g.profile.coins, equipped: g.profile.equipped.court, turf: g.stage.court.turfMaterial.color.getHexString() }; });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => { const g = window.__padel; return { coins: g.profile.coins, equipped: g.profile.equipped.court, turf: g.stage.court.turfMaterial.color.getHexString(), matches: g.profile.stats.matches }; });
  console.log(JSON.stringify({ coins0, started, end, home, bought, afterReload: after, errors }, null, 1));
  await browser.close();
})();
