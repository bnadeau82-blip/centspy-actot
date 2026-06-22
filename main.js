import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';

chromium.use(StealthPlugin());

// ── Departments to scan ───────────────────────────────────────────────────────
const DEPARTMENTS = [
  { name: 'Appliances',         path: '/b/Appliances/N-5yc1vZc3pl' },
  { name: 'Bath',               path: '/b/Bath/N-5yc1vZbZbv4' },
  { name: 'Building Materials', path: '/b/Building-Materials/N-5yc1vZar5p' },
  { name: 'Electrical',         path: '/b/Electrical/N-5yc1vZbvb3' },
  { name: 'Flooring',           path: '/b/Flooring/N-5yc1vZaq9z' },
  { name: 'Hardware',           path: '/b/Hardware/N-5yc1vZc2l5' },
  { name: 'Heating & Cooling',  path: '/b/Heating-Cooling/N-5yc1vZc4mq' },
  { name: 'Kitchen',            path: '/b/Kitchen/N-5yc1vZbZcp8' },
  { name: 'Lighting',           path: '/b/Lighting-Ceiling-Fans/N-5yc1vZbvn0' },
  { name: 'Outdoor Living',     path: '/b/Outdoor-Living/N-5yc1vZbZ1z8' },
  { name: 'Paint',              path: '/b/Paint/N-5yc1vZaqss' },
  { name: 'Plumbing',           path: '/b/Plumbing/N-5yc1vZc2l9' },
  { name: 'Smart Home',         path: '/b/Smart-Home/N-5yc1vZc1nz' },
  { name: 'Storage',            path: '/b/Storage-Organization/N-5yc1vZc2l7' },
  { name: 'Tools',              path: '/b/Tools/N-5yc1vZc1wz' },
];

// ── Main ──────────────────────────────────────────────────────────────────────
Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const {
    akamaiCookies  = [],   // paste fresh cookies from Reqable here
    storeId        = '3917',
    supabaseUrl,
    supabaseKey,
    maxDepartments = DEPARTMENTS.length,
  } = input;

  const supabase =
    supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  // Residential proxy — sticky session per store keeps Akamai happy
  const proxy = await Actor.createProxyConfiguration({
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  });
  const proxyUrl = await proxy.newUrl(`STORE_${storeId}`);

  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxyUrl },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1440, height: 900 },
    locale:     'en-US',
    timezoneId: 'America/Chicago',
  });

  // Inject Akamai cookies into the context BEFORE opening any page.
  // This gives sensor_data the existing cookie state to validate against.
  if (akamaiCookies.length > 0) {
    await context.addCookies(
      akamaiCookies.map((c) => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain   ?? '.homedepot.com',
        path:     c.path     ?? '/',
        httpOnly: c.httpOnly ?? false,
        secure:   c.secure   ?? true,
        sameSite: c.sameSite ?? 'Lax',
      }))
    );
    console.log(`[COOKIES] Injected ${akamaiCookies.length} Akamai cookies`);
  } else {
    console.log('[COOKIES] None provided — running without cookie injection');
  }

  const page      = await context.newPage();
  const collected = [];

  // ── Response interceptor ─────────────────────────────────────────────────
  // Must be registered BEFORE any goto so we don't miss early calls.
  page.on('response', async (res) => {
    try {
      // HD fires GraphQL from both apionline.homedepot.com AND www.homedepot.com/federation-gateway
      const url = res.url();
      const isGraphQL =
        url.includes('apionline.homedepot.com') ||
        url.includes('homedepot.com/federation-gateway/graphql');
      if (!isGraphQL) return;
      if (res.status() !== 200) return;
      if (!(res.headers()['content-type'] ?? '').includes('application/json')) return;

      const body     = await res.json().catch(() => null);
      const products = body?.data?.searchModel?.products;
      if (!Array.isArray(products)) return;

      console.log(`[HIT] ${products.length} products from GraphQL`);
      for (const p of products) {
        const item = parseProduct(p, storeId);
        if (item) collected.push(item);
      }
    } catch { /* silent */ }
  });

  try {
    // ── 1. Load homepage so SPA boots and Akamai JS initialises ──────────
    console.log('[NAV] Loading homepage...');
    await page.goto('https://www.homedepot.com', {
      waitUntil: 'networkidle',
      timeout:   60_000,
    });
    console.log('[NAV] Homepage ready');

    // ── 2. Navigate each department via SPA routing ───────────────────────
    const depts = DEPARTMENTS.slice(0, maxDepartments);

    for (const dept of depts) {
      const before = collected.length;
      console.log(`[DEPT] → ${dept.name}`);

      try {
        const anchor = page.locator(`a[href*="${dept.path}"]`).first();
        const hasAnchor = (await anchor.count()) > 0;

        if (hasAnchor) {
          // Click the live nav link — lets the React router handle the
          // transition the same way a real user would.
          await Promise.all([
            page
              .waitForResponse(
                (r) =>
                  (r.url().includes('apionline.homedepot.com') ||
                   r.url().includes('homedepot.com/federation-gateway/graphql')) &&
                  r.status() === 200,
                { timeout: 20_000 }
              )
              .catch(() => null),
            anchor.click(),
          ]);
        } else {
          // Fallback: pushState + popstate fires the router without a click.
          // Less reliable than a real click but covers nav links not in DOM.
          console.log(`[NAV] No anchor for ${dept.name} — using pushState`);
          await page.evaluate((path) => {
            window.history.pushState({}, '', path);
            window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
          }, dept.path);

          await page
            .waitForResponse(
              (r) =>
                (r.url().includes('apionline.homedepot.com') ||
                 r.url().includes('homedepot.com/federation-gateway/graphql')) &&
                r.status() === 200,
              { timeout: 20_000 }
            )
            .catch(() => null);
        }

        // Scroll to trigger intersection-observer lazy loads on the product grid.
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight / 2)
        );
        await page.waitForTimeout(1_500);
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight)
        );
        await page.waitForTimeout(2_500);

        console.log(
          `[DEPT] ${dept.name}: +${collected.length - before} items (total ${collected.length})`
        );
      } catch (e) {
        console.log(`[ERR] ${dept.name}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[DONE] ${collected.length} items collected`);

  if (supabase && collected.length > 0) {
    await upsertToSupabase(supabase, collected);
  }

  await Actor.setValue('SUMMARY', {
    storeId,
    total:     collected.length,
    timestamp: new Date().toISOString(),
  });
});

// ── Parse one GraphQL product node ────────────────────────────────────────────
function parseProduct(p, storeId) {
  try {
    const pricing = p.pricing     ?? {};
    const ids     = p.identifiers ?? {};

    const price    = pricing.value    ?? pricing.original ?? null;
    const wasPrice = pricing.original ?? null;
    const itemId   = ids.itemId       ?? ids.storeSkuNumber ?? null;

    if (!itemId || price === null) return null;

    const isPenny =
      price <= 0.01;

    const isClearance =
      String(pricing.promotionTag ?? '').toLowerCase().includes('clearance') ||
      (wasPrice !== null && wasPrice > 0 && price < wasPrice * 0.6);

    if (!isPenny && !isClearance) return null;

    return {
      store_id:     String(storeId),
      item_id:      String(itemId),
      model_number: ids.modelNumber  ?? null,
      brand:        ids.brandName    ?? null,
      description:  ids.productLabel ?? null,
      price,
      was_price:    wasPrice,
      is_penny:     isPenny,
      is_clearance: isClearance,
      updated_at:   new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ── Supabase upsert in 500-row batches ────────────────────────────────────────
async function upsertToSupabase(supabase, items) {
  const BATCH = 500;
  for (let i = 0; i < items.length; i += BATCH) {
    const { error } = await supabase
      .from('products')
      .upsert(items.slice(i, i + BATCH), { onConflict: 'store_id,item_id' });

    if (error) {
      console.log(`[SUPABASE ERR] ${error.message}`);
    } else {
      console.log(
        `[SUPABASE] Upserted rows ${i + 1}–${Math.min(i + BATCH, items.length)}`
      );
    }
  }
}