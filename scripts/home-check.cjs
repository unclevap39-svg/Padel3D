// Dev helper: captures every home tab at real phone sizes (with notch and home-indicator insets)
// and reports anything that overlaps, is clipped, needs scrolling or sits under a hosting badge.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const sizes = [
    // name, width, height, device scale, safe-area insets: left, right, bottom
    ['iphone', 844, 390, 2, 47, 47, 21],
    ['iphone-se', 667, 375, 1, 0, 0, 0],
    ['android-small', 640, 360, 1, 0, 0, 0],
    ['iphone-max', 932, 430, 1, 59, 59, 21],
    ['iphone-safari', 844, 340, 1, 47, 47, 21],
  ];
  let problems = 0;
  for (const [name, w, h, dsf, sl, sr, sb] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto('http://localhost:5173/?q=low&noinstall', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
    await page.addStyleTag({ content: `:root{--safe-l:${sl}px;--safe-r:${sr}px;--safe-b:${sb}px}` });
    await page.waitForTimeout(1500);
    const views = [['play', null], ['play-tournament', '.mode-card[data-mode=tournament]'], ['play-daily', '.mode-card[data-mode=daily]'], ['online', null], ['shop', '[data-item="racket.aurum"]'], ['locker', null], ['profile', null], ['settings', null]];
    for (const [view, click] of views) {
      const tab = view.split('-')[0];
      await page.evaluate((tab) => document.querySelector(`.home-nav [data-tab=${tab}]`).click(), tab);
      if (click) await page.evaluate((sel) => document.querySelector(sel).click(), click);
      await page.waitForTimeout(700);
      const issues = await page.evaluate(() => {
        const out = [];
        const vw = innerWidth, vh = innerHeight;
        const rect = (el) => el.getBoundingClientRect();
        const pane = document.querySelector('.pane');
        const kids = [...pane.children].filter((c) => rect(c).height > 0).sort((a, b) => rect(a).top - rect(b).top);
        for (let i = 0; i + 1 < kids.length; i++) {
          if (rect(kids[i]).bottom > rect(kids[i + 1]).top + 1) out.push(`${kids[i].className.split(' ')[0]} overlaps ${kids[i + 1].className.split(' ')[0]} by ${Math.round(rect(kids[i]).bottom - rect(kids[i + 1]).top)}px`);
        }
        if (pane.scrollHeight > pane.clientHeight + 1) out.push(`pane needs scrolling: ${pane.scrollHeight} > ${pane.clientHeight}`);
        const nav = document.querySelector('.home-nav');
        if (rect(pane).bottom > rect(nav).top + 1) out.push('pane overlaps the navigation');
        const lastTab = nav.lastElementChild;
        if (rect(lastTab).right > vw - 205) out.push(`navigation reaches the badge corner (${Math.round(rect(lastTab).right)} > ${vw - 205})`);
        for (const el of document.querySelectorAll('.home-top > *, .pane > *, .home-nav > *, .mode-card, .play-btn, .seg button, .item-action, .stat, .invite button, .invite input')) {
          const r = rect(el);
          if (r.width === 0) continue;
          if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) out.push(`${el.className || el.tagName} off screen`);
        }
        for (const el of document.querySelectorAll('.mc-name, .seg button, .invite button, .act-btn, .ic-name')) {
          if (el.scrollWidth > el.clientWidth + 1) out.push(`text cut: "${el.textContent.trim()}"`);
        }
        // Buttons of one row must not overlap each other.
        for (const row of document.querySelectorAll('.detail-row, .play-row, .settings-actions, .chips, .mode-grid')) {
          const items = [...row.children].filter((c) => rect(c).width > 0);
          for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
            const a = rect(items[i]), b = rect(items[j]);
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${row.className.split(' ')[0]}: items ${i} and ${j} overlap`);
          }
        }
        return out;
      });
      problems += issues.length;
      console.log(name.padEnd(14), view.padEnd(16), issues.length ? JSON.stringify(issues) : 'ok');
      await page.screenshot({ path: `shots/home-${name}-${view}.png` });
    }
    await ctx.close();
  }
  console.log(problems ? `${problems} problem(s)` : 'all layouts fit');
  await browser.close();
})();
