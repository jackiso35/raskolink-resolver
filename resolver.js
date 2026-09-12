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

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; }
}
function isIntermediate(host, sourceHost='') {
  if (!host) return true;
  if (sourceHost && host === sourceHost) return true;
  for (const h of intermediate) if (host === h || host.endsWith('.' + h)) return true;
  return false;
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

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

async function resolveOne(browser, item) {
  const started = Date.now();
  const chain = [];
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

    // JS redirects / tracker handoffs may happen after DOMContentLoaded.
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
      // Gerçek hedefte birkaç saniye stabil kaldıysa yeterli.
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
  console.log(`RaskoLink resolver: ${items.length} due brand(s)`);
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
