// Dev helper: first-visit install screen on an iPhone and an Android profile, then the end-of-match screen.
const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [name, dev] of [['iphone', devices['iPhone 13 landscape']], ['android', devices['Pixel 7 landscape']]]) {
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `shots/m-${name}-install.png` });
    console.log(name, await page.evaluate(() => window.__padel.menu.current));
    if (name === 'android') {
      // Fast-forward a whole match with nobody at the controls, then show the result screen.
      const res = await page.evaluate(() => {
        const g = window.__padel; g.menu.show('main'); g.startMatch('quick', 2);
        let n = 0; while (g.sim.phase !== 'match_over' && n < 3e6) { if (g.sim.phase === 'serve_ready' && g.sim.server.id === 0) g.sim.humanShot({ type: 'drive', power: 0.5, angle: 0 }); g.sim.tick(); n++; if (n % 2000 === 0) g.sim.drainEvents(); }
        return { ticks: n, sets: g.sim.match.scoring.completedSets, winner: g.sim.match.scoring.matchWinner };
      });
      console.log('match', JSON.stringify(res));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'shots/m-end.png' });
      console.log('screen', await page.evaluate(() => window.__padel.menu.current));
    }
    await ctx.close();
  }
  // Portrait phone: the rotate hint must cover the game.
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'shots/m-portrait.png' });
  console.log('rotate hint visible', await page.evaluate(() => getComputedStyle(document.querySelector('.rotate-hint')).display));
  await browser.close();
})();
