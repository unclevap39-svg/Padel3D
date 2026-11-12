// Dev helper: screenshot the running game in a phone-sized landscape viewport.
// Usage: node scripts/shot.cjs <out.png> [url] [waitMs] [deviceScaleFactor] [js to evaluate before the capture]
const { chromium } = require('playwright');
(async () => {
  const [out = 'shots/shot.png', url = 'http://localhost:5173/', wait = '2500', dsf = '1', evalJs = ''] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: Number(dsf), isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(Number(wait));
  if (evalJs) console.log('eval:', JSON.stringify(await page.evaluate(evalJs)));
  await page.screenshot({ path: out });
  await browser.close();
  console.log('saved', out);
})();
