// Dev helper: checks the production build — service worker, manifest, and an offline reload.
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2] || 'http://localhost:4173/';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  let bytes = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', async (r) => { try { bytes += (await r.body()).length; } catch {} });
  await page.goto(url + '?noinstall', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active }; });
  await page.waitForTimeout(3000); // let the precache finish
  const manifest = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const m = await (await fetch(l.href)).json(); return { href: l.getAttribute('href'), name: m.name, display: m.display, orientation: m.orientation, icons: m.icons.length }; });
  const cached = await page.evaluate(async () => { let n = 0; for (const k of await caches.keys()) n += (await (await caches.open(k)).keys()).length; return n; });
  console.log(JSON.stringify({ sw, manifest, cachedEntries: cached, firstLoadBytesUncompressed: bytes }));
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
  const offline = await page.evaluate(() => { const g = window.__padel; g.startMatch('quick', 0); return { body: g.characters[0].body.constructor.name }; });
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => ({ phase: window.__padel.sim.phase }));
  await page.screenshot({ path: 'shots/offline.png' });
  console.log(JSON.stringify({ offlineReloadWorks: true, ...offline, ...state, errors }));
  await browser.close();
})();
