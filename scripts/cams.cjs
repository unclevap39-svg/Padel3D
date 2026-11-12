const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const cams = JSON.parse(process.argv[2]);
  let i = 0;
  for (const c of cams) {
    await page.evaluate((c) => { const cam = window.__dbg.stage.camera; cam.position.set(...c.p); cam.fov = c.fov; cam.updateProjectionMatrix(); cam.lookAt(...c.t); }, c);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `shots/cam${i++}.png` });
  }
  await browser.close();
})();
