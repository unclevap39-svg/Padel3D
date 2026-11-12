// Dev helper: two browsers play each other through the lobby and a direct WebRTC link.
// Usage: node scripts/online-check.cjs [baseUrl] [invite|ranked]
const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://localhost:5173/';
  const how = process.argv[3] || 'invite';
  const proxy = base.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ proxy, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const open = async (name, query) => {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(base + query, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__padel, null, { timeout: 60000 });
    await page.waitForTimeout(800);
    return page;
  };
  const A = await open('A', '?q=low&noinstall');
  await A.evaluate(() => { window.__padel.profile.name = 'Alice'; });
  await A.click('.home-nav [data-tab=online]');
  let B;
  if (how === 'invite') {
    await A.click('[data-invite="1"]');
    await A.waitForSelector('.room-code', { timeout: 15000 });
    const code = await A.evaluate(() => document.querySelector('.room-code').textContent.trim());
    console.log('room code', code);
    await A.screenshot({ path: 'shots/online-code.png' });
    B = await open('B', `?q=low&noinstall&room=${code}`);
  } else {
    B = await open('B', '?q=low&noinstall');
    await B.evaluate(() => { window.__padel.profile.name = 'Bruno'; });
    await B.click('.home-nav [data-tab=online]');
    await A.screenshot({ path: 'shots/online-lobby.png' });
    await A.click(how === 'classic' ? '[data-queue="c2"]' : '[data-queue="r2"]');
    await A.waitForTimeout(1200);
    await A.screenshot({ path: 'shots/online-search.png' });
    await B.click(how === 'classic' ? '[data-queue="c2"]' : '[data-queue="r2"]');
  }
  const playing = (p) => p.waitForFunction(() => window.__padel.net && window.__padel.playing, null, { timeout: 45000 });
  await Promise.all([playing(A), playing(B)]);
  const roles = await Promise.all([A, B].map((p) => p.evaluate(() => ({ role: window.__padel.net.info.role, mode: window.__padel.net.info.mode, opp: window.__padel.net.info.opponent.name }))));
  console.log('connected', JSON.stringify(roles));
  const host = roles[0].role === 'host' ? A : B;
  const guest = host === A ? B : A;
  // Both sides play by script for a while in real time.
  await host.evaluate(() => { const g = window.__padel; window.__hits = [0, 0, 0, 0]; const orig = g.handleEvents.bind(g); g.handleEvents = (evs) => { for (const e of evs) if (e.kind === 'hit') window.__hits[e.player]++; orig(evs); };
    setInterval(() => { const s = g.sim; if (!s.plans) return; const p = s.players[0]; const plan = s.plans[0];
      if (s.phase === 'serve_ready' && s.server === p) s.humanShot({ type: 'drive', power: 0.5, aim: 0 });
      else if (s.phase === 'rally' && s.hitterId === 0 && plan && plan.t - s.now < 0.3 && !p.swing) s.humanShot({ type: 'drive', power: 0.5, aim: 0 }); }, 30); });
  // The guest plays with the real controls: hold a shot button, aim with the stick, release.
  await guest.evaluate(() => { const g = window.__padel; let pressedAt = -1; window.__guest = { presses: 0, maxGauge: 0, aimSeen: 0, landingSeen: 0 };
    setInterval(() => { const s = g.sim; const c = s.humanCharge(); const w = window.__guest;
      if (c) w.maxGauge = Math.max(w.maxGauge, c.gauge);
      if (g.markers.aim.visible) w.aimSeen++;
      if (g.markers.landing.visible) w.landingSeen++;
      const serving = s.phase === 'serve_ready' && s.match.referee.server === 0;
      const incoming = s.phase === 'rally' && g.view.lastHitTeam === 1;
      if ((serving || incoming) && !c && !s.players[0].swing) { g.controls.onPress('drive'); pressedAt = performance.now(); w.presses++; g.controls.move.x = w.presses % 2 ? 0.7 : -0.7; }
      if (c && c.held && performance.now() - pressedAt > 450) g.controls.onRelease();
      if (!c) g.controls.move.x = 0; }, 30); });
  await host.waitForTimeout(25000);
  await guest.screenshot({ path: 'shots/online-guest.png' });
  await host.screenshot({ path: 'shots/online-host.png' });
  const mid = await Promise.all([host.evaluate(() => ({ hits: window.__hits, points: window.__padel.sim.match.scoring.points, games: window.__padel.sim.match.scoring.games, visible: window.__padel.characters.map((c) => c.group.visible) })),
    guest.evaluate(() => ({ ready: window.__padel.sim.ready, controls: window.__guest, points: window.__padel.sim.match.scoring.points, games: window.__padel.sim.match.scoring.games, hud: document.querySelector('.scoreboard').innerText.replace(/\s+/g, ' ') }))]);
  console.log('after 25 s', JSON.stringify(mid));
  if (how === 'invite') {
    // The guest leaves abruptly: the host must notice and win by forfeit.
    await guest.context().close();
    await host.waitForFunction(() => window.__padel.menu.current === 'end', null, { timeout: 60000 }).catch(() => {});
    const forfeit = await host.evaluate(() => ({ screen: window.__padel.menu.current, text: (document.querySelector('.menu .panel') || { innerText: '' }).innerText.replace(/\s+/g, ' '), won: window.__padel.summary.won }));
    console.log('after guest left', JSON.stringify(forfeit));
    await host.screenshot({ path: 'shots/online-forfeit.png' });
    console.log('errors', JSON.stringify(errors));
    await browser.close();
    return;
  }
  // Finish the match quickly on the host; the guest must end on the same result.
  await host.evaluate(() => { const g = window.__padel; const s = g.sim; let n = 0;
    while (s.phase !== 'match_over' && n < 3e6) { if (s.phase === 'serve_ready') for (const id of [0, 2]) if (s.server === s.players[id]) s.shot(id, { type: 'drive', power: 0.5, aim: 0 }); s.tick(); n++; if (n % 4 === 0) { const ev = s.drainEvents(); g.net.host.afterFrame(ev, 1 / 30); g.handleEvents(ev); } } });
  await host.waitForTimeout(4000);
  const end = await Promise.all([host, guest].map((p) => p.evaluate(() => ({ screen: window.__padel.menu.current, text: (document.querySelector('.menu .panel') || { innerText: '' }).innerText.replace(/\s+/g, ' '), won: window.__padel.summary.won }))));
  console.log('end', JSON.stringify(end));
  if (how === 'ranked') { await host.waitForTimeout(9000); const rated = await Promise.all([host, guest].map((p) => p.evaluate(() => (document.getElementById('rating-gain') || { innerText: 'none' }).innerText))); console.log('ratings', JSON.stringify(rated)); }
  await guest.screenshot({ path: 'shots/online-end.png' });
  console.log('errors', JSON.stringify(errors));
  await browser.close();
})();
