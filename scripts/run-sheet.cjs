// Dev helper: slow the game down and capture a player running, tiled into one sheet.
// Usage: node scripts/run-sheet.cjs <name> <moveX> <moveZ> <camDx,camDy,camDz>
const { chromium } = require('playwright');
const sharp = require('sharp');
(async () => {
  const [name = 'side', mx = '-1', mz = '0', cam = '0,1.3,-5.5'] = process.argv.slice(2);
  const [cx, cy, cz] = cam.split(',').map(Number);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5173/?q=high&noinstall', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.evaluate(() => { const g = window.__padel; g.startMatch(2); g.hud.show(false); });
  await page.waitForTimeout(2500);
  await page.evaluate(([mx, mz]) => {
    const g = window.__padel; g.controls.setEnabled(false); g.debugTimeScale = 0.2;
    const p = g.sim.players[0]; p.place(mx < 0 ? 4 : mx > 0 ? -4 : 2.5, mz < 0 ? 9 : mz > 0 ? 2 : 6);
    setInterval(() => { g.controls.move.x = mx; g.controls.move.z = mz; }, 10);
  }, [Number(mx), Number(mz)]);
  await page.waitForTimeout(1800);
  const tiles = [];
  for (let i = 0; i < 8; i++) {
    await page.evaluate(([cx, cy, cz]) => { const g = window.__padel; const p = g.sim.players[0]; g.debugCam = { pos: [p.x + cx, cy, p.z + cz], look: [p.x, 0.95, p.z], fov: 26 }; }, [cx, cy, cz]);
    await page.waitForTimeout(260);
    tiles.push(await sharp(await page.screenshot()).extract({ left: 297, top: 20, width: 250, height: 350 }).toBuffer());
  }
  await sharp({ create: { width: 250 * tiles.length, height: 350, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: i * 250, top: 0 }))).png().toFile(`shots/run-${name}.png`);
  console.log('saved', `shots/run-${name}.png`);
  await browser.close();
})();
