#!/usr/bin/env node
// UX walkthrough runner: plays use-case scenarios in a real browser (local Chrome via
// playwright-core), mixes in CLI steps (e.g. an AI agent acting through a CLI), and writes a
// Markdown report with screenshots, step results, clicks used and on-screen text density.
//
//   node .agents/skills/ux-walkthrough/scripts/walkthrough.mjs <scenarios.mjs> [--out dir] [--only UC-3,UC-5] [--headed]
//
// The scenarios module exports default { setup?, baseUrl, viewport?, env?, scenarios: [...] }.
// See ../references/scenario-format.md for the step types.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const file = args.find((a) => !a.startsWith('--') && /\.m?js$/.test(a));
if (!file) {
  console.error('usage: walkthrough.mjs <scenarios.mjs> [--out dir] [--only UC-1,UC-2] [--headed]');
  process.exit(2);
}
const spec = (await import(pathToFileURL(path.resolve(file)).href)).default;
const outDir = path.resolve(flag('out', spec.outDir ?? 'ux-report'));
const only = flag('only', '') ? String(flag('only')).split(',') : null;
const cwd = spec.cwd ? path.resolve(spec.cwd) : process.cwd();
const env = { ...process.env, ...(spec.env ?? {}) };

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed in this project: npm i -D playwright-core');
  process.exit(2);
}

// ---------- setup: background processes + readiness ----------
const procs = [];
async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function setup() {
  for (const c of spec.setup?.before ?? []) execSync(c, { cwd, env, stdio: 'inherit', shell: '/bin/sh' });
  for (const s of spec.setup?.start ?? []) {
    const p = spawn('/bin/sh', ['-c', s.cmd], { cwd, env: { ...env, ...(s.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => process.env.WALK_DEBUG && process.stderr.write(d));
    procs.push(p);
    if (s.ready) await waitFor(s.ready);
  }
}
function teardown() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {}
  }
  for (const c of spec.setup?.after ?? []) {
    try {
      execSync(c, { cwd, env, stdio: 'ignore', shell: '/bin/sh' });
    } catch {}
  }
}
process.on('SIGINT', () => (teardown(), process.exit(130)));

// ---------- steps ----------
function locate(page, s) {
  let loc = page.locator(s.sel ?? 'body');
  if (s.text) loc = loc.filter({ hasText: s.text });
  return s.nth !== undefined ? loc.nth(s.nth) : loc.first();
}

async function density(page, s) {
  return page.evaluate(
    ({ sel }) =>
      [...document.querySelectorAll(sel)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && Number(st.opacity) > 0.3;
        })
        .map((el) => {
          const text = el.innerText.replace(/\s+/g, ' ').trim();
          // Legibility: on-screen size of the card's main text (the element with the longest own text),
          // including any zoom/transform applied by the canvas.
          const scale = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
          let main = el;
          let longest = 0;
          for (const d of el.querySelectorAll('*')) {
            const own = [...d.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
            if (own.length > longest && d.getBoundingClientRect().height > 0) {
              longest = own.length;
              main = d;
            }
          }
          const px = parseFloat(getComputedStyle(main).fontSize) * scale;
          return { text, words: text ? text.split(' ').length : 0, px: Math.round(px * 10) / 10 };
        }),
    { sel: s.sel ?? '.react-flow__node' },
  );
}

async function runStep(page, s, ctx) {
  const t = s.timeout ?? 5000;
  switch (s.do) {
    case 'goto':
      await page.goto(new URL(s.path ?? '/', spec.baseUrl).href);
      if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 });
      return 'ok';
    case 'reload':
      await page.reload();
      if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 });
      return 'ok';
    case 'click':
      ctx.clicks++;
      await locate(page, s).click({ timeout: t, force: s.force });
      await page.waitForTimeout(s.settle ?? 600);
      return 'ok';
    case 'dblclick':
      ctx.clicks++;
      await locate(page, s).dblclick({ timeout: t });
      await page.waitForTimeout(s.settle ?? 600);
      return 'ok';
    case 'hover':
      await locate(page, s).hover({ timeout: t });
      await page.waitForTimeout(s.settle ?? 300);
      return 'ok';
    case 'fill':
      await locate(page, s).fill(s.value, { timeout: t });
      return 'ok';
    case 'press':
      await page.keyboard.press(s.key);
      await page.waitForTimeout(s.settle ?? 500);
      return 'ok';
    case 'wait':
      await page.waitForTimeout(s.ms ?? 500);
      return 'ok';
    case 'expect': {
      const loc = s.text ? page.locator(s.sel ?? 'body').filter({ hasText: s.text }) : page.locator(s.sel);
      if (s.count !== undefined) {
        const deadline = Date.now() + t;
        let n = await loc.count();
        while (n !== s.count && Date.now() < deadline) {
          await page.waitForTimeout(150);
          n = await loc.count();
        }
        if (n !== s.count) throw new Error(`expected ${s.count} × ${s.sel}${s.text ? ` "${s.text}"` : ''}, found ${n}`);
        return `${n} found`;
      }
      if (s.visible === false) {
        await loc.first().waitFor({ state: 'hidden', timeout: t });
        return 'hidden';
      }
      await loc.first().waitFor({ state: 'visible', timeout: t });
      return 'visible';
    }
    case 'expectUrl': {
      const deadline = Date.now() + t;
      while (!new RegExp(s.match).test(page.url()) && Date.now() < deadline) await page.waitForTimeout(100);
      if (!new RegExp(s.match).test(page.url())) throw new Error(`url ${page.url()} does not match ${s.match}`);
      return page.url().replace(spec.baseUrl, '');
    }
    case 'cli': {
      const out = execSync(s.cmd, { cwd, env, encoding: 'utf8', shell: '/bin/sh', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      ctx.cli.push({ cmd: s.cmd, out });
      if (s.expect && !new RegExp(s.expect, 'm').test(out)) throw new Error(`output does not match /${s.expect}/:\n${out.slice(0, 800)}`);
      if (s.reject && new RegExp(s.reject, 'm').test(out)) throw new Error(`output matches forbidden /${s.reject}/`);
      await page.waitForTimeout(s.settle ?? 400);
      return out.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 160);
    }
    case 'cliFails': {
      try {
        execSync(s.cmd, { cwd, env, encoding: 'utf8', shell: '/bin/sh', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const err = String(e.stderr ?? e.message);
        if (s.expect && !new RegExp(s.expect).test(err)) throw new Error(`failed, but not with /${s.expect}/: ${err.slice(0, 300)}`);
        return `refused: ${err.trim().slice(0, 140)}`;
      }
      throw new Error('command was expected to fail but succeeded');
    }
    case 'density': {
      const cards = await density(page, s);
      const max = s.maxWords ?? 16;
      const over = cards.filter((c) => c.words > max);
      const avg = cards.length ? cards.reduce((a, c) => a + c.words, 0) / cards.length : 0;
      const minPx = cards.length ? Math.min(...cards.map((c) => c.px)) : 0;
      const needPx = s.minPx ?? 11;
      ctx.density.push({ at: s.label ?? ctx.lastShot ?? '', cards: cards.length, avg: +avg.toFixed(1), max, over: over.map((c) => c.text.slice(0, 80)), maxCards: s.maxCards, minPx, needPx });
      const problems = [];
      if (over.length) problems.push(`${over.length} card(s) over ${max} words`);
      if (s.maxCards && cards.length > s.maxCards) problems.push(`${cards.length} cards on screen (limit ${s.maxCards})`);
      if (cards.length && minPx < needPx) problems.push(`main text renders at ${minPx}px (needs ${needPx}px)`);
      if (problems.length && s.strict) throw new Error(problems.join('; '));
      return `${cards.length} cards, avg ${avg.toFixed(1)} words, main text ${minPx}px${problems.length ? ` ⚠ ${problems.join('; ')}` : ''}`;
    }
    case 'shot': {
      const name = `${ctx.id}-${String(++ctx.shots).padStart(2, '0')}-${s.name ?? 'shot'}.png`;
      await page.screenshot({ path: path.join(outDir, name), fullPage: false });
      ctx.lastShot = name;
      ctx.images.push({ name, why: s.why ?? '' });
      return name;
    }
    case 'note':
      return s.text;
    default:
      throw new Error(`unknown step type "${s.do}"`);
  }
}

// ---------- run ----------
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const results = [];
try {
  await setup();
  const browser = await chromium.launch({ channel: spec.channel ?? 'chrome', headless: !flag('headed', false) });
  for (const sc of spec.scenarios) {
    if (only && !only.includes(sc.id)) continue;
    const page = await browser.newPage({ viewport: spec.viewport ?? { width: 1600, height: 960 } });
    const ctx = { id: sc.id, clicks: 0, shots: 0, images: [], density: [], cli: [], errors: [], steps: [] };
    page.on('pageerror', (e) => ctx.errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => m.type() === 'error' && ctx.errors.push(m.text().slice(0, 300)));
    let failed = false;
    for (const s of sc.steps) {
      if (failed && s.do !== 'shot') {
        ctx.steps.push({ s, status: 'skip' });
        continue;
      }
      const t0 = Date.now();
      try {
        const info = await runStep(page, s, ctx);
        ctx.steps.push({ s, status: 'ok', info, ms: Date.now() - t0 });
      } catch (e) {
        failed = true;
        ctx.steps.push({ s, status: 'fail', info: String(e.message ?? e).split('\n')[0].slice(0, 300), ms: Date.now() - t0 });
        try {
          const name = `${sc.id}-fail.png`;
          await page.screenshot({ path: path.join(outDir, name) });
          ctx.images.push({ name, why: 'state when the step failed' });
        } catch {}
      }
    }
    const overClicks = sc.maxClicks !== undefined && ctx.clicks > sc.maxClicks;
    results.push({ sc, ctx, pass: !failed && !ctx.errors.length && !overClicks, overClicks });
    console.log(`${!failed && !ctx.errors.length && !overClicks ? 'PASS' : 'FAIL'}  ${sc.id}  ${sc.title}  (${ctx.clicks} clicks${sc.maxClicks !== undefined ? ` / max ${sc.maxClicks}` : ''})`);
    await page.close();
  }
  await browser.close();
} finally {
  teardown();
}

// ---------- report ----------
const L = [];
const passed = results.filter((r) => r.pass).length;
L.push(`# UX walkthrough: ${spec.title ?? path.basename(file)}`, '');
L.push(`${passed}/${results.length} scenarios pass · ${new Date().toISOString()}`, '');
L.push('| Use case | Need | Result | Clicks | Notes |', '|---|---|---|---|---|');
for (const { sc, ctx, pass, overClicks } of results) {
  const notes = [ctx.errors.length ? `${ctx.errors.length} console errors` : '', overClicks ? 'too many clicks' : '', ...ctx.density.filter((d) => d.over.length || (d.maxCards && d.cards > d.maxCards)).map((d) => `dense: ${d.at}`), ...ctx.density.filter((d) => d.cards && d.minPx < d.needPx).map((d) => `small text: ${d.at} (${d.minPx}px)`)]
    .filter(Boolean)
    .join('; ');
  L.push(`| ${sc.id} | ${sc.need ?? sc.title} | ${pass ? '✅' : '❌'} | ${ctx.clicks}${sc.maxClicks !== undefined ? `/${sc.maxClicks}` : ''} | ${notes} |`);
}
for (const { sc, ctx } of results) {
  L.push('', `## ${sc.id} — ${sc.title}`, '');
  if (sc.need) L.push(`**Need:** ${sc.need}`, '');
  if (sc.persona) L.push(`**Who:** ${sc.persona}`, '');
  L.push('| # | Step | Result |', '|---|---|---|');
  ctx.steps.forEach(({ s, status, info }, i) => {
    const what = s.why ?? s.text ?? s.cmd ?? s.sel ?? s.path ?? s.key ?? s.name ?? '';
    const icon = status === 'ok' ? '✓' : status === 'fail' ? '✗' : '–';
    L.push(`| ${i + 1} | \`${s.do}\` ${String(what).replace(/\|/g, '\\|').slice(0, 120)} | ${icon} ${String(info ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  });
  if (ctx.density.length) {
    L.push('', '**On-screen density**', '');
    for (const d of ctx.density) L.push(`- ${d.at}: ${d.cards} cards, avg ${d.avg} words, main text ${d.minPx}px${d.minPx < d.needPx ? ' ⚠ too small' : ''}${d.over.length ? `; over ${d.max}: ${d.over.map((t) => `“${t}”`).join(', ')}` : ''}`);
  }
  if (ctx.errors.length) L.push('', '**Console errors**', '', ...ctx.errors.map((e) => `- ${e}`));
  for (const img of ctx.images) L.push('', `![${img.why || img.name}](${img.name})`, img.why ? `*${img.why}*` : '');
}
writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results.map(({ sc, ctx, pass }) => ({ id: sc.id, pass, clicks: ctx.clicks, steps: ctx.steps.map((x) => ({ do: x.s.do, status: x.status, info: x.info })), density: ctx.density, errors: ctx.errors })), null, 2));
console.log(`\n${passed}/${results.length} pass. Report: ${path.join(outDir, 'report.md')}`);
process.exit(passed === results.length ? 0 : 1);
