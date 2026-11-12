// Dev helper: freeze the game and capture a stroke at several phases, tiled into one sheet.
// Usage: node scripts/poses.cjs <stroke> <ballY> [camDx,camDy,camDz]
const { chromium } = require('playwright');
const sharp = require('sharp');
(async () => {
  const [stroke = 'forehand', ballY = '0.9', cam = '2.2,1.5,-3.0'] = process.argv.slice(2);
  const [cx, cy, cz] = cam.split(',').map(Number);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5173/?q=high&noinstall', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  await page.evaluate(() => { const g = window.__padel; g.startMatch('quick', 2); });
  await page.waitForTimeout(3500);
  await page.evaluate(([cx, cy, cz]) => {
    const g = window.__padel; g.freeze = true; g.hud.show(false); g.controls.setEnabled(false);
    const p = g.sim.players[0]; p.vx = p.vz = 0; p.holdingBall = false;
    g.debugCam = { pos: [p.x + cx, cy, p.z + cz], look: [p.x, 1.05, p.z], fov: 30 };
  }, [cx, cy, cz]);
  const phases = [-0.16, -0.08, -0.03, 0, 0.08, 0.2, 0.34];
  const tiles = [];
  for (const ph of phases) {
    await page.evaluate(([stroke, ballY, ph]) => {
      const g = window.__padel; const p = g.sim.players[0]; const now = g.sim.now;
      const side = stroke === 'backhand' || stroke === 'volley_bh' ? -1 : 1;
      const over = stroke === 'smash' || stroke === 'bandeja';
      const contact = { x: p.x + p.rightX * side * (over ? 0.2 : 0.62), y: Number(ballY), z: p.z + p.dir * 0.3 };
      p.swing = { stroke, intent: { type: 'drive', power: 0.6 }, startT: now - 0.26 - ph, contactT: now - ph, endT: now - ph + 0.42, contact, willHit: true, resolved: true };
      g.sim.world.setBall({ px: contact.x, py: contact.y, pz: contact.z, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 });
    }, [stroke, ballY, ph]);
    await page.waitForTimeout(700);
    tiles.push(await sharp(await page.screenshot()).extract({ left: 272, top: 0, width: 300, height: 390 }).toBuffer());
  }
  await sharp({ create: { width: 300 * tiles.length, height: 390, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: i * 300, top: 0 }))).png().toFile(`shots/pose-${stroke}.png`);
  console.log('saved', `shots/pose-${stroke}.png`);
  await browser.close();
})();
