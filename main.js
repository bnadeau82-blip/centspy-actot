import { Actor } from 'apify';
import { request as pwRequest } from 'playwright-extra';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { gotScraping } from 'got-scraping';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
chromium.use(StealthPlugin());

const GQL_URL   = 'https://www.homedepot.com/federation-gateway/graphql?opname=mediaPriceInventory';
const GQL_QUERY = `query mediaPriceInventory($excludeInventory: Boolean = false, $isBrandPricingPolicyCompliant: Boolean!, $itemIds: [String!]!, $storeId: String!) {
  mediaPriceInventory(
    itemIds: $itemIds
    storeId: $storeId
    isBrandPricingPolicyCompliant: $isBrandPricingPolicyCompliant
  ) {
    productDetailsList {
      itemId
      imageLocation
      onlineInventory @skip(if: $excludeInventory) {
        enableItem
        totalQuantity
        __typename
      }
      pricing(isBrandPricingPolicyCompliant: $isBrandPricingPolicyCompliant) {
        alternate {
          unit {
            value
            caseUnitOfMeasure
            __typename
          }
          __typename
        }
        value
        unitOfMeasure
        original
        message
        mapAboveOriginalPrice
        mapDetail {
          percentageOff
          dollarOff
          mapPolicy
          mapOriginalPriceViolation
          mapSpecialPriceViolation
          __typename
        }
        __typename
      }
      storeInventory @skip(if: $excludeInventory) {
        enableItem
        totalQuantity
        __typename
      }
      __typename
    }
    __typename
  }
}`;

Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const {
    akamaiCookies = [],
    storeId       = '3917',
    supabaseUrl,
    supabaseKey,
    batchSize     = 25,   // items per GraphQL request
  } = input;

  const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } })
    : null;

  // ── Pull known item IDs from Supabase ──────────────────────────────────────
  let itemIds = [];
  if (supabase) {
    const { data, error } = await supabase
      .from('clearance_items')
      .select('product_id')
      .eq('store_id', storeId)
      .limit(10000);
    if (error) {
      console.log('[SUPABASE ERR]', error.message);
    } else {
      itemIds = data.map((r) => r.product_id);
      console.log(`[SUPABASE] ${itemIds.length} item IDs loaded`);
    }
  }

  // TEST: override with known-good IDs from Reqable capture
  itemIds = ["309495334"];
  console.log('[TEST] Using hardcoded known-good IDs:', itemIds.length);

  if (itemIds.length === 0) {
    console.log('[DONE] No item IDs to check — add supabaseUrl/supabaseKey to input');
    return;
  }

  // ── Launch browser ─────────────────────────────────────────────────────────
  const proxy = await Actor.createProxyConfiguration({
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  });
  const proxyUrl = await proxy.newUrl('CENTSPY');

  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxyUrl },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    viewport:   { width: 1440, height: 900 },
    locale:     'en-US',
    timezoneId: 'America/Chicago',
  });

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
    console.log(`[COOKIES] Injected ${akamaiCookies.length} cookies`);
  }

  const page    = await context.newPage();
  const hits    = [];

  // Expose Node.js HTTP function to browser — bypasses proxy auth issue in page.evaluate
  await page.exposeFunction('__hdFetch', async (ids, store) => {
    const liveCookies = await context.cookies(['https://www.homedepot.com']);
    const cookieStr = liveCookies.map(c => `${c.name}=${c.value}`).join('; ');
    try {
      const res = await gotScraping({
        url: GQL_URL,
        method: 'POST',
        proxyUrl,
        headers: {
          'content-type':          'application/json',
          'accept':               '*/*',
          'x-hd-dc':             'origin',
          'x-experience-name':   'fusion-gm-pip-desktop',
          'x-debug':             'false',
          'x-thd-customer-token': '',
          'x-api-cookies':       '{"tt_search":"pc3","x-user-id":"e0870b1b-dd5d-a000-1b37-845197849209"}',
          'origin':              'https://www.homedepot.com',
          'referer':             'https://www.homedepot.com/',
          'cookie':              cookieStr,
        },
        body: JSON.stringify({
          operationName: 'mediaPriceInventory',
          variables: {
            excludeInventory: false,
            isBrandPricingPolicyCompliant: false,
            itemIds: ids,
            storeId: store,
          },
          query: GQL_QUERY,
        }),
        responseType: 'text',
        throwHttpErrors: false,
      });
      return { status: res.statusCode, text: res.body };
    } catch(e) {
      return { status: 0, text: e.message };
    }
  });

  try {
    // ── Establish session on homepage ────────────────────────────────────────
    // Intercept BEFORE homepage loads — homepage fires mediaPriceInventory naturally
    let captured = null;
    await page.route('**/federation-gateway/graphql?opname=mediaPriceInventory', async (route) => {
      if (captured) { await route.continue(); return; }
      try {
        const body = JSON.parse(route.request().postData() || '{}');
        console.log('[INTERCEPT] Caught mediaPriceInventory — swapping IDs');
        body.variables = {
          ...body.variables,
          itemIds: itemIds,
          storeId: storeId,
          excludeInventory: false,
          isBrandPricingPolicyCompliant: false,
        };
        const response = await route.fetch({ postData: JSON.stringify(body) });
        const text = await response.text();
        captured = { status: response.status(), text };
        console.log('[INTERCEPT] Status:', response.status(), 'body:', text.slice(0, 400));
        await route.fulfill({ response, body: text });
      } catch(e) {
        console.log('[INTERCEPT ERR]', e.message);
        await route.continue();
      }
    });

    console.log('[NAV] Loading homepage...');
    await page.goto('https://www.homedepot.com', {
      waitUntil: 'networkidle',
      timeout:   120_000,
    }).catch(() => null);
    await page.waitForTimeout(5_000);
    await page.unrouteAll();
    console.log('[NAV] Homepage done. Captured:', !!captured);
    if (captured) console.log('[RESULT]', captured.text.slice(0, 600));

    // ── Batch price-check via in-page fetch ───────────────────────────────────
    // Runs inside the browser so all Akamai/PX cookies are sent automatically.
    const batches = [];
    for (let i = 0; i < itemIds.length; i += batchSize) {
      batches.push(itemIds.slice(i, i + batchSize));
    }
    // Diagnose page state before fetching
    const pageState = await page.evaluate(async () => {
      try {
        const r = await fetch('/');
        return { url: window.location.href, fetchOk: true, fetchStatus: r.status };
      } catch(e) {
        return { url: window.location.href, fetchOk: false, fetchError: e.message };
      }
    });
    console.log('[PAGE STATE]', JSON.stringify(pageState));

    console.log(`[CHECK] ${itemIds.length} items across ${batches.length} batches`);

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      try {
        // Call Node.js via exposeFunction — proxy auth handled in Node, not browser JS
        const result = await page.evaluate(
          async ({ ids, store }) => await window.__hdFetch(ids, store),
          { ids: batch, store: storeId }
        );

        if (![200, 206].includes(result.status)) {
          console.log(`[BATCH ${b + 1}] HTTP ${result.status} — skipping`);
          continue;
        }

        console.log('[DEBUG] batch:', JSON.stringify(batch), 'status:', result.status);
        console.log('[DEBUG] full response:', result.text);
        const body     = JSON.parse(result.text);
        const products = body?.data?.mediaPriceInventory?.productDetailsList ?? [];

        for (const p of products) {
          const price    = p.pricing?.value    ?? null;
          const wasPrice = p.pricing?.original ?? null;
          if (price === null) continue;

          const isPenny     = price <= 0.01;
          const isClearance = wasPrice !== null && wasPrice > 0 && price < wasPrice * 0.6;

          if (isPenny || isClearance) {
            hits.push({
              store_id:        storeId,
              product_id:      String(p.itemId),
              clearance_price: price,
              retail_price:    wasPrice,
              report_date:     new Date().toISOString(),
            });
            console.log(`[HIT] ${isPenny ? 'PENNY' : 'CLEARANCE'} item ${p.itemId} @ $${price}`);
          }
        }

        if ((b + 1) % 20 === 0) {
          console.log(`[PROGRESS] ${b + 1}/${batches.length} batches — ${hits.length} hits`);
        }

        // Polite delay
        await page.waitForTimeout(300);

      } catch (e) {
        console.log(`[BATCH ${b + 1} ERR] ${e.message}`);
      }
    }

  } finally {
    await browser.close();
  }

  // ── Write results to Supabase ─────────────────────────────────────────────
  const penny     = hits.filter((h) => h.clearance_price <= 0.01).length;
  const clearance = hits.filter((h) => h.clearance_price > 0.01).length;
  console.log(`[DONE] ${penny} penny | ${clearance} clearance | ${hits.length} total`);

  if (supabase && hits.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < hits.length; i += BATCH) {
      const { error } = await supabase
        .from('products')
        .upsert(hits.slice(i, i + BATCH), { onConflict: 'store_id,product_id' });
      if (error) console.log('[SUPABASE ERR]', error.message);
    }
    console.log(`[SUPABASE] Upserted ${hits.length} items`);
  }

  await Actor.setValue('SUMMARY', {
    storeId,
    penny,
    clearance,
    total: hits.length,
    timestamp: new Date().toISOString(),
  });
});