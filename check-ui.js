const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE = `file://${path.resolve(__dirname)}`;
const OUT  = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const issues = [];
const log = (emoji, msg) => { const line = `  ${emoji}  ${msg}`; issues.push(line); console.log(line); };
const ok   = msg => log('✅', msg);
const flag = msg => log('❌', msg);
const warn = msg => log('⚠️ ', msg);
const info = msg => log('ℹ️ ', msg);
const head = msg => { const l = `\n── ${msg} ${'─'.repeat(Math.max(0, 46 - msg.length))}`; issues.push(l); console.log(l); };

async function checkPage(browser, file, viewportName, viewport) {
  head(`${file}  ${viewportName} (${viewport.width}×${viewport.height})`);

  const page = await browser.newPage({ viewport });
  const jsErrors = [];
  page.on('console', m => { if (m.type() === 'error') jsErrors.push(m.text()); });
  page.on('pageerror', e => jsErrors.push(e.message));

  await page.goto(`${BASE}/${file}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const slug = `${file.replace('.html','')}_${viewportName}`;

  // ── 1. JS errors ──────────────────────────────────────────────
  jsErrors.length
    ? flag(`JS errors: ${jsErrors.join(' | ')}`)
    : ok('No JS errors');

  // ── 2. Page transition overlay ────────────────────────────────
  const ptOpacity = await page.evaluate(() => {
    const el = document.getElementById('page-transition');
    return el ? parseFloat(getComputedStyle(el).opacity) : -1;
  });
  if (ptOpacity < 0)        warn('#page-transition element missing');
  else if (ptOpacity > 0.05) flag(`#page-transition opacity=${ptOpacity} — blocking page!`);
  else                       ok(`#page-transition hidden (opacity=${ptOpacity})`);

  // ── 3. Nav: fixed/sticky, no rogue nav elements ───────────────
  const navInfo = await page.evaluate(() => {
    const navEls = [...document.querySelectorAll('nav')];
    return navEls.map(el => ({
      id: el.id, classes: el.className,
      position: getComputedStyle(el).position,
      top: Math.round(el.getBoundingClientRect().top),
      height: Math.round(el.offsetHeight),
    }));
  });
  info(`nav elements found: ${navInfo.length}`);
  navInfo.forEach(n => {
    const label = n.id || n.classes || '(no id/class)';
    if (n.position === 'fixed' && n.top !== 0) {
      flag(`<nav ${label}>: position=fixed but top=${n.top} (not at 0)`);
    } else {
      info(`<nav ${label}>: position=${n.position} top=${n.top} height=${n.height}`);
    }
  });
  if (navInfo.length > 1) flag(`Multiple <nav> elements (${navInfo.length}) — check CSS scope`);
  else                     ok('Only one <nav> element');

  // ── 4. Hero scroll indicator centering (index only) ──────────
  const scrollEl = await page.$('.hero-scroll');
  if (scrollEl) {
    const { offsetPx, transform } = await page.evaluate(() => {
      const el = document.querySelector('.hero-scroll');
      const rect = el.getBoundingClientRect();
      const cx   = rect.left + rect.width / 2;
      return { offsetPx: Math.round(Math.abs(cx - window.innerWidth / 2)), transform: getComputedStyle(el).transform };
    });
    offsetPx > 10
      ? flag(`hero-scroll off-center by ${offsetPx}px  transform: ${transform}`)
      : ok(`hero-scroll centered (offset: ${offsetPx}px)`);
  }

  // ── 5. Anchor scroll — nav overlap ───────────────────────────
  const navH = await page.evaluate(() => (document.querySelector('nav')?.offsetHeight ?? 0));
  const anchors = await page.evaluate(() =>
    [...document.querySelectorAll('section[id], div[id]')]
      .map(el => el.id)
      .filter(Boolean)
  );
  for (const id of anchors.slice(0, 6)) {
    const topAfterScroll = await page.evaluate(id => {
      const el = document.getElementById(id);
      if (!el) return null;
      el.scrollIntoView({ behavior: 'instant' });
      return Math.round(el.getBoundingClientRect().top);
    }, id);
    if (topAfterScroll === null) continue;
    topAfterScroll < -2
      ? flag(`#${id}: scrolled behind nav (top=${topAfterScroll}px, navH=${navH}px)`)
      : ok(`#${id}: clears nav (top=${topAfterScroll}px)`);
  }

  // ── 6. Screenshot: top of page ────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${slug}_top.png` });
  ok(`Screenshot: ${slug}_top.png`);

  // ── 7. Reveal elements all visible after scroll ───────────────
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  const stuck = await page.evaluate(() =>
    document.querySelectorAll('.reveal:not(.visible)').length);
  stuck
    ? flag(`${stuck} .reveal elements never became visible`)
    : ok('All .reveal elements visible after scroll');

  // ── 8. Full-page screenshot ───────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${slug}_full.png`, fullPage: true });
  ok(`Screenshot: ${slug}_full.png`);

  // ── 9. Mobile-specific: hamburger + mobile menu ───────────────
  if (viewport.width <= 768) {
    const hamVisible = await page.evaluate(() => {
      const el = document.querySelector('.hamburger');
      return el ? getComputedStyle(el).display !== 'none' : false;
    });
    hamVisible ? ok('Hamburger visible') : flag('Hamburger NOT visible on mobile');

    const navLinksHidden = await page.evaluate(() => {
      const el = document.querySelector('.nav-links');
      return el ? getComputedStyle(el).display === 'none' : true;
    });
    navLinksHidden ? ok('.nav-links hidden on mobile') : flag('.nav-links still showing on mobile');

    // open menu via JS
    await page.evaluate(() => document.querySelector('.hamburger')?.click());
    await page.waitForTimeout(350);
    const menuOpen = await page.evaluate(() =>
      document.getElementById('mobile-menu')?.classList.contains('open') ?? false);
    menuOpen ? ok('Mobile menu opens') : flag('Mobile menu does NOT open');
    await page.screenshot({ path: `${OUT}/${slug}_menu.png` });
    await page.evaluate(() => document.querySelector('.hamburger')?.click());
    await page.waitForTimeout(250);
  }

  // ── 10. Footer nav: must NOT be a <nav> tag ──────────────────
  const footerNavTag = await page.evaluate(() => {
    const el = document.querySelector('.footer-nav');
    return el ? el.tagName : null;
  });
  if (footerNavTag === 'NAV') flag('.footer-nav is a <nav> tag — will inherit fixed positioning!');
  else if (footerNavTag)      ok(`.footer-nav is <${footerNavTag.toLowerCase()}> (safe)`);
  else                        warn('.footer-nav not found');

  // ── 11. Text overflow / clipping ─────────────────────────────
  const clipped = await page.evaluate(() => {
    return [...document.querySelectorAll('h1, h2, .hero-name, .nav-logo')]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > window.innerWidth + 2;
      })
      .map(el => `${el.tagName}:${el.textContent.trim().slice(0, 30)}`);
  });
  clipped.length
    ? flag(`Overflowing elements: ${clipped.join(', ')}`)
    : ok('No horizontal text overflow');

  await page.close();
}

(async () => {
  const browser = await chromium.launch();

  const pages = [
    { file: 'index.html' },
    { file: 'shop.html'  },
  ];
  const viewports = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'mobile',  viewport: { width: 390,  height: 844 } },
  ];

  for (const { file } of pages) {
    for (const { name, viewport } of viewports) {
      await checkPage(browser, file, name, viewport);
    }
  }

  await browser.close();

  head('SUMMARY');
  const flagged = issues.filter(l => l.includes('❌'));
  const warned  = issues.filter(l => l.includes('⚠️'));
  console.log(`\n  ❌ ${flagged.length} error(s)   ⚠️  ${warned.length} warning(s)\n`);
  if (flagged.length) { console.log('  Errors:'); flagged.forEach(l => console.log(l)); }
  console.log('\n  Screenshots → ./screenshots/\n');
})();
