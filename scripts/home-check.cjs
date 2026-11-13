// Dev helper: captures every screen of the home at real phone sizes (with notch and
// home-indicator insets) and reports anything that overlaps, is cut, is too small to press,
// leaves the screen or sits under the hosting badge (bottom right, 205 x 50).
const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://localhost:5173';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const sizes = [
    // name, width, height, device scale, safe-area insets: left, right, bottom
    ['iphone', 844, 390, 2, 47, 47, 21],
    ['iphone-se', 667, 375, 1, 0, 0, 0],
    ['android-small', 640, 360, 1, 0, 0, 0],
    ['iphone-max', 932, 430, 1, 59, 59, 21],
    ['iphone-safari', 844, 340, 1, 47, 47, 21],
  ];
  // view name, home tab, optional clicks once there
  const views = [
    ['play', 'play', []],
    ['play-single', 'play', ['@format:single']],
    ['modes', 'modes', []],
    ['modes-tournament', 'modes', ['[data-mode=tournament]']],
    ['modes-daily', 'modes', ['[data-mode=daily]']],
    ['online', 'online', []],
    ['shop', 'shop', ['[data-item="racket.aurum"]']],
    ['shop-outfit', 'shop', ['[data-kind=outfit]']],
    ['locker', 'locker', ['[data-kind=racket]']],
    ['profile', 'profile', []],
    ['settings', 'settings', []],
  ];
  let problems = 0;
  for (const [name, w, h, dsf, sl, sr, sb] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${base}/?q=low&noinstall`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__padel, null, { timeout: 30000 });
    await page.addStyleTag({ content: `:root{--safe-l:${sl}px;--safe-r:${sr}px;--safe-b:${sb}px}` });
    // A long name and big numbers: the worst case for the top bar.
    await page.evaluate(() => { const g = window.__padel; g.profile.name = 'Maximilienne'; g.profile.coins = 128450; g.profile.xp = 96000; g.home.refresh(); });
    for (const [view, tab, clicks] of views) {
      await page.evaluate((tab) => window.__padel.home.open(tab), tab);
      for (const c of clicks) {
        if (c.startsWith('@format:')) await page.evaluate((f) => { const g = window.__padel; g.profile.format = f; g.home.show(true); }, c.slice(8));
        else await page.evaluate((sel) => document.querySelector(`.home ${sel}`).click(), c);
      }
      await page.waitForTimeout(2600);
      const issues = await page.evaluate(([sl, sr, sb]) => {
        const out = [];
        const vw = innerWidth, vh = innerHeight;
        const rect = (el) => el.getBoundingClientRect();
        const shown = (el) => { const r = rect(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 28);
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const home = document.querySelector('.home');
        const press = [...home.querySelectorAll('button, input, select, label.toggle')].filter(shown);
        const badge = { left: vw - 205, right: vw, top: vh - 50, bottom: vh };
        for (const el of press) {
          const r = rect(el);
          if (hit(r, badge)) out.push(`under the hosting badge: "${label(el)}"`);
          if (r.left < sl - 1 || r.right > vw - sr + 1 || r.top < -1 || r.bottom > vh - Math.min(sb, 10) + 1) out.push(`outside the safe area: "${label(el)}" [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
          if (el.matches('button, label.toggle') && (r.height < 40 || r.width < 40) && !el.closest('.portes')) out.push(`too small to press (${Math.round(r.width)}x${Math.round(r.height)}): "${label(el)}"`);
        }
        // Buttons must not cover one another (a card inside a wall is fine: compare siblings).
        for (let i = 0; i < press.length; i++) for (let j = i + 1; j < press.length; j++) {
          const a = press[i], b = press[j];
          if (a.contains(b) || b.contains(a)) continue;
          if (a.closest('.portes') && b.closest('.portes')) continue;
          if (hit(rect(a), rect(b))) out.push(`overlap: "${label(a)}" / "${label(b)}"`);
        }
        // Children of a wall, of the bar and of a card row must not run into each other.
        for (const box of home.querySelectorAll('.mur, .barre, .rayon, .reglages, .fiche, .inviter, .pied-modes, .fiche-joueur')) {
          const kids = [...box.children].filter(shown);
          for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (hit(rect(kids[i]), rect(kids[j]))) out.push(`${box.className.split(' ').slice(0, 2).join('.')}: "${label(kids[i])}" runs into "${label(kids[j])}"`);
        }
        // Name tags of the team must stay clear of the walls and of each other.
        const tags = [...home.querySelectorAll('.repere')].filter(shown);
        for (const t of tags) {
          for (const m of home.querySelectorAll('.mur')) if (hit(rect(t), rect(m))) out.push(`name tag "${label(t)}" over a wall`);
          if (rect(t).top < rect(home.querySelector('.barre')).bottom - 2) out.push(`name tag "${label(t)}" under the tab bar`);
        }
        if (tags.length === 2 && hit(rect(tags[0]), rect(tags[1]))) out.push('name tags overlap');
        // Labels that must be readable in full.
        for (const el of home.querySelectorAll('.onglet, .segments button, .verre-btn, .balle span, .carte-mode .titre, .mode .titre, .casier .sur, .stat .sur')) {
          if (!shown(el)) continue;
          if (el.scrollWidth > el.clientWidth + 1) out.push(`text cut: "${label(el)}"`);
        }
        for (const el of home.querySelectorAll('.vitre, .segments')) {
          if (!shown(el) || el.matches('.board-wrap, .porte')) continue;
          const r = rect(el);
          for (const k of el.children) { if (!shown(k)) continue; const c = rect(k); if (c.right > r.right + 1 || c.bottom > r.bottom + 1) out.push(`"${label(k)}" spills out of its pane`); }
        }
        const smallText = [...home.querySelectorAll('*')].filter((el) => shown(el) && el.childElementCount === 0 && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 10.9);
        if (smallText.length) out.push(`text under 11px: "${label(smallText[0])}"`);
        return [...new Set(out)];
      }, [sl, sr, sb]);
      problems += issues.length;
      console.log(name.padEnd(14), view.padEnd(17), issues.length ? JSON.stringify(issues) : 'ok');
      await page.screenshot({ path: `shots/home-${name}-${view}.png` });
    }
    await ctx.close();
  }
  console.log(problems ? `${problems} problem(s)` : 'all layouts fit');
  await browser.close();
})();
