// Dev helper: capture the home screen tabs at two phone sizes and report any overflow.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [name, w, h, dsf] of [['large', 844, 390, 2], ['small', 667, 375, 1]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto('http://localhost:5173/?q=high&noinstall', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    for (const tab of ['play', 'shop', 'locker', 'profile', 'settings']) {
      await page.evaluate((tab) => document.querySelector(`.home-nav [data-tab=${tab}]`).click(), tab);
      if (tab === 'shop') await page.evaluate(() => document.querySelector('[data-item="racket.aurum"]').click());
      await page.waitForTimeout(1300);
      const over = await page.evaluate(() => {
        const out = [];
        const vw = innerWidth, vh = innerHeight;
        for (const el of document.querySelectorAll('.home-top > *, .pane > *, .home-nav, .mode-card, .mc-name, .play-btn, .item-action, .stat, .settings-grid > *')) {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) out.push(el.className + ' out of screen');
          if (el.scrollWidth > el.clientWidth + 1 && !el.classList.contains('item-row')) out.push(el.className + ' clipped ' + el.scrollWidth + '>' + el.clientWidth);
        }
        const pane = document.querySelector('.pane').getBoundingClientRect();
        const nav = document.querySelector('.home-nav').getBoundingClientRect();
        if (pane.bottom > nav.top + 1) out.push('pane overlaps nav');
        return out;
      });
      console.log(name, tab, over.length ? JSON.stringify(over) : 'ok');
      await page.screenshot({ path: `shots/home-${name}-${tab}.png` });
    }
    await ctx.close();
  }
  await browser.close();
})();
