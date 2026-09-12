const { chromium } = require('playwright');

const FEED_URL = process.env.RASKOLINK_FEED_URL || '';
const CALLBACK_URL = process.env.RASKOLINK_CALLBACK_URL || '';
const KEY = process.env.RASKOLINK_RESOLVER_KEY || '';

if (!FEED_URL || !CALLBACK_URL || !KEY) {
  console.error('Missing RASKOLINK_FEED_URL / RASKOLINK_CALLBACK_URL / RASKOLINK_RESOLVER_KEY');
  process.exit(1);
}

const intermediate = new Set([
  't.ly','bit.ly','tinyurl.com','cutt.ly','rebrand.ly','rb.gy','is.gd','tiny.cc',
  'shorturl.at','shorturl.asia','lnkd.in','ow.ly','buff.ly','soo.gd','s.id',
  'track.cdnue.com','cdnue.com'
]);

const noiseHosts = new Set([
  't.ly','www.t.ly','help.t.ly','chromewebstore.google.com','play.google.com','apps.apple.com',
  'google.com','www.google.com','googleapis.com','gstatic.com','fonts.googleapis.com',
  'fonts.gstatic.com','github.com','www.github.com','facebook.com','www.facebook.com',
  'x.com','twitter.com','linkedin.com','www.linkedin.com','youtube.com','www.youtube.com',
  'cloudflare.com','www.cloudflare.com'
]);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; }
}
function isIntermediate(host, sourceHost='') {
  if (!host) return true;
  if (sourceHost && host === sourceHost) return true;
  for (const h of intermediate) if (host === h || host.endsWith('.' + h)) return true;
  return false;
}
function isNoiseHost(host) {
  if (!host) return true;
  for (const h of noiseHosts) if (host === h || host.endsWith('.' + h)) return true;
  return false;
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function extractUrls(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const rx = /https?:\/\/[^\s"'<>\\)\]]+/gi;
    const matches = value.match(rx) || [];
    for (let u of matches) {
      u = u.replace(/[.,;:!?]+$/,'');
      if (!out.includes(u)) out.push(u);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractUrls(v, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) extractUrls(v, out);
  }
  return out;
}

function pickBestCandidate(urls, sourceUrl) {
  const sourceHost = hostOf(sourceUrl);
  const usable = [];
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { continue; }
    const h = parsed.hostname.toLowerCase().replace(/^www\./,'');
    if (!h || h === sourceHost || isIntermediate(h, sourceHost) || isNoiseHost(h)) continue;
    if (['localhost','127.0.0.1','0.0.0.0','::1'].includes(h)) continue;
    // Ignore obvious static/CDN assets even if they are on a different host.
    if (/\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(?:$|\?)/i.test(parsed.pathname)) continue;
    usable.push(u);
  }
  return usable.length ? usable[usable.length - 1] : '';
}

async function callback(payload) {
  const r = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Rasko-Resolver-Key': KEY},
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Callback HTTP ${r.status}: ${text.slice(0,300)}`);
  try { return JSON.parse(text); } catch { return {ok:false,raw:text}; }
}

async function resolveViaTlyExpander(browser, shortUrl) {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Europe/Istanbul',
    viewport: {width: 1365, height: 900},
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: false
  });

  const page = await context.newPage();
  const apiUrls = [];
  const pageUrls = [];
  let status = 0;
  let error = '';

  page.on('response', async res => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const text = await res.text();
      if (text.length > 1500000) return;
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      extractUrls(data, apiUrls);
    } catch (_) {}
  });

  try {
    const expanderUrl = `https://t.ly/tools/link-expander?url=${encodeURIComponent(shortUrl)}`;
    const first = await page.goto(expanderUrl, {waitUntil:'domcontentloaded', timeout:45000});
    if (first) status = first.status();

    // Try to populate the expander form. The page structure may change, so use several selectors.
    const selectors = [
      'input[type="url"]',
      'input[name*="url" i]',
      'input[placeholder*="url" i]',
      'input[placeholder*="link" i]'
    ];
    let input = null;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) { input = loc; break; }
    }
    if (!input) {
      const fallback = page.locator('input').filter({hasNot: page.locator('[type="hidden"]')}).first();
      if (await fallback.count()) input = fallback;
    }

    if (input) {
      await input.fill(shortUrl).catch(()=>{});
      const buttons = [
        page.getByRole('button', {name:/expand url/i}).first(),
        page.getByRole('button', {name:/expand/i}).first(),
        page.getByRole('button', {name:/unshorten/i}).first(),
        page.getByRole('button', {name:/check/i}).first(),
        page.locator('button[type="submit"]').first()
      ];
      let clicked = false;
      for (const b of buttons) {
        if (await b.count()) {
          const visible = await b.isVisible().catch(()=>false);
          if (visible) {
            await b.click({timeout:5000}).catch(()=>{});
            clicked = true;
            break;
          }
        }
      }
      if (!clicked) await input.press('Enter').catch(()=>{});
    }

    // Give the server-side expander time to finish and render the redirect chain.
    await page.waitForLoadState('domcontentloaded', {timeout:15000}).catch(()=>{});
    await sleep(10000);

    // Prefer URLs returned by the expander's JSON/XHR responses.
    let finalUrl = pickBestCandidate(apiUrls, shortUrl);

    // If the service rendered results into the page, inspect text + anchors as a fallback.
    if (!finalUrl) {
      const bodyText = await page.locator('body').innerText({timeout:5000}).catch(()=> '');
      extractUrls(bodyText, pageUrls);
      const hrefs = await page.locator('a[href^="http"]').evaluateAll(nodes => nodes.map(n => n.href)).catch(()=>[]);
      for (const h of hrefs) if (!pageUrls.includes(h)) pageUrls.push(h);
      finalUrl = pickBestCandidate(pageUrls, shortUrl);
    }

    if (!finalUrl) {
      error = 'T.LY Expander gerçek hedef domaini döndürmedi.';
      return {ok:false, finalUrl:shortUrl, httpCode:status, error, chain:[...apiUrls, ...pageUrls].slice(-30)};
    }

    return {ok:true, finalUrl, httpCode:200, error:'', chain:[shortUrl, ...apiUrls, ...pageUrls, finalUrl].slice(-30)};
  } catch (e) {
    error = `T.LY Expander fallback hatası: ${String(e && e.message ? e.message : e).slice(0,700)}`;
    return {ok:false, finalUrl:shortUrl, httpCode:status, error, chain:[]};
  } finally {
    await context.close().catch(()=>{});
  }
}

async function resolveOne(browser, item) {
  const started = Date.now();
  let chain = [];
  const sourceHost = hostOf(item.url);
  let finalUrl = item.url;
  let httpCode = 0;
  let error = '';
  let context;

  try {
    context = await browser.newContext({
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      viewport: {width: 390, height: 844},
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
      ignoreHTTPSErrors: false
    });

    let activePage = await context.newPage();
    context.on('page', p => { activePage = p; });
    activePage.on('request', req => {
      if (req.isNavigationRequest() && req.frame() === activePage.mainFrame()) {
        const u = req.url();
        if (!chain.length || chain[chain.length - 1] !== u) chain.push(u);
      }
    });
    activePage.on('response', res => {
      if (res.request().isNavigationRequest() && res.request().frame() === activePage.mainFrame()) {
        httpCode = res.status();
      }
    });

    await activePage.goto(item.url, {waitUntil:'domcontentloaded', timeout:45000});

    let stableUrl = '';
    let stableCount = 0;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const pages = context.pages();
      if (pages.length) activePage = pages[pages.length - 1];
      const now = activePage.url();
      if (now && now !== 'about:blank') finalUrl = now;
      if (finalUrl === stableUrl) stableCount++; else { stableUrl = finalUrl; stableCount = 0; }
      const h = hostOf(finalUrl);
      if (h && !isIntermediate(h, sourceHost) && stableCount >= 2) break;
    }

    const finalHost = hostOf(finalUrl);
    if (!finalHost || isIntermediate(finalHost, sourceHost)) {
      error = `Browser gerçek hedef domaine ulaşamadı. Son host: ${finalHost || 'yok'}`;
    }
  } catch (e) {
    error = String(e && e.message ? e.message : e).slice(0,900);
  } finally {
    if (context) await context.close().catch(()=>{});
  }

  // v20: T.LY-specific fallback. This does NOT replace normal resolving;
  // it only runs when direct browser resolution fails on a t.ly short link.
  if (error && sourceHost === 't.ly') {
    console.log(`[${item.brand_id}] ${item.name}: direct T.LY resolution failed (HTTP ${httpCode || 0}), trying T.LY Expander fallback...`);
    const fallback = await resolveViaTlyExpander(browser, item.url);
    if (fallback.ok) {
      finalUrl = fallback.finalUrl;
      httpCode = fallback.httpCode || httpCode;
      chain = [...chain, ...fallback.chain].slice(-30);
      error = '';
      console.log(`[${item.brand_id}] ${item.name}: T.LY Expander fallback OK -> ${hostOf(finalUrl)}`);
    } else {
      chain = [...chain, ...fallback.chain].slice(-30);
      error = `${error} | ${fallback.error}`.slice(0,900);
      console.log(`[${item.brand_id}] ${item.name}: T.LY Expander fallback FAIL`);
    }
  }

  const payload = {
    brand_id: Number(item.brand_id),
    ok: !error,
    final_url: finalUrl,
    http_code: httpCode,
    duration_ms: Date.now() - started,
    error,
    chain: chain.slice(-30)
  };

  const result = await callback(payload);
  console.log(`[${item.brand_id}] ${item.name}: ${error ? 'FAIL' : 'OK'} -> ${hostOf(finalUrl)} | callback=${JSON.stringify(result).slice(0,350)}`);
}

async function main() {
  const feedRes = await fetch(FEED_URL, {headers:{'X-Rasko-Resolver-Key': KEY}});
  if (!feedRes.ok) throw new Error(`Feed HTTP ${feedRes.status}: ${(await feedRes.text()).slice(0,400)}`);
  const feed = await feedRes.json();
  const items = Array.isArray(feed.items) ? feed.items : [];
  console.log(`RaskoLink resolver v20: ${items.length} due brand(s)`);
  if (!items.length) return;

  const browser = await chromium.launch({headless:true, args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const concurrency = Math.min(3, items.length);
    let cursor = 0;
    const workers = Array.from({length: concurrency}, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try { await resolveOne(browser, items[i]); }
        catch (e) { console.error(`[${items[i].brand_id}] worker error:`, e.message || e); }
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
