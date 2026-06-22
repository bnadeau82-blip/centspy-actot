const { Actor } = require('apify');
const { PlaywrightCrawler, RequestList } = require('crawlee');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Patch chromium with stealth — defeats Akamai's headless Chrome detection
// Fixes: navigator.webdriver, CDP signatures, WebGL/canvas fingerprint, plugin arrays
chromium.use(StealthPlugin());

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const input = await Actor.getInput() || {};
    const storeId    = input.storeId    || '3917';
    const storeZip   = input.storeZip   || '73160';
    const storeName  = input.storeName  || 'Moore';
    const storeState = input.storeState || 'OK';
    const maxResults  = input.maxResults  || 2000;
    const minDiscount = input.minDiscount || 0;
    const maxPrice    = input.maxPrice    || 999999;
    const debugMode   = input.debugMode   || false;

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    const allItems   = [];
    const seenIds    = new Set();

    // Department pages to cycle through. N-codes are stable but verify any
    // that return 0 results by visiting homedepot.com and copying the URL.
    const DEPARTMENTS = [
      { name: 'Appliances',          url: 'https://www.homedepot.com/b/Appliances/N-5yc1vZc3pl' },
      { name: 'Tools',               url: 'https://www.homedepot.com/b/Tools/N-5yc1vZc1d2' },
      { name: 'Lighting',            url: 'https://www.homedepot.com/b/Lighting-Ceiling-Fans/N-5yc1vZbvbx' },
      { name: 'Flooring',            url: 'https://www.homedepot.com/b/Flooring/N-5yc1vZc6qm' },
      { name: 'Outdoors',            url: 'https://www.homedepot.com/b/Outdoors-Garden/N-5yc1vZbq9g' },
      { name: 'Paint',               url: 'https://www.homedepot.com/b/Paint/N-5yc1vZc8qk' },
      { name: 'Hardware',            url: 'https://www.homedepot.com/b/Hardware/N-5yc1vZc1qu' },
      { name: 'Electrical',          url: 'https://www.homedepot.com/b/Electrical/N-5yc1vZcvf2' },
      { name: 'Plumbing',            url: 'https://www.homedepot.com/b/Plumbing/N-5yc1vZcvk2' },
      { name: 'Building Materials',  url: 'https://www.homedepot.com/b/Building-Materials/N-5yc1vZb8h0' },
    ];

    // Skip known analytics/noise domains — saves time reading bodies we don't need
    const SKIP_DOMAINS = [
      'quantummetric', 'px-cloud', 'collector', 'sprinklr',
      'clickstream', 'getamigo', 'forter', 'qualtrics',
      'paypal', 'microsoft', 'nr-data', 'tiktok', 'snapchat',
      'amobee', 'nextdoor', 'redditads', 'claude.ai', 'anthropic',
    ];

    console.log(`Starting CentSpy — Store #${storeId} ${storeName}, ${storeState} ${storeZip}`);

    const crawler = new PlaywrightCrawler({
      proxyConfiguration,
      requestHandlerTimeoutSecs: 900,
      // Use playwright-extra stealth launcher instead of default Chromium
      // This patches the signals Akamai uses to detect headless browsers
      launchContext: {
        launcher: chromium,
        launchOptions: {
          headless: true,
        },
      },
      // Single entry point: homepage. We navigate to each department inside the handler.
      requestList: await RequestList.open(null, ['https://www.homedepot.com/']),

      // Inject real Akamai session cookies BEFORE the first navigation.
      // These cookies were captured from a real browser session via Reqable.
      // Akamai sees valid bot-management cookies and skips the JS challenge,
      // allowing product GraphQL calls to fire normally.
      // NOTE: Rotate these periodically — _abck and bm_sz expire over time.
      preNavigationHooks: [
        async ({ page }) => {
          const AKAMAI_COOKIES = [
            { name: '_abck',    value: '30B8719CCFDF9D38F8F207E318C12533~-1~YAAQmA7GFzyQEt2eAQAAKoVM8BBoymrlC9Fddz6XDKI/p/1WHhRUHWHsSG5Z6P71kJftTgNDvh2ZwYG+NYekj+j/MPzCW+MZjrH+fsGv67iwucoZN3QMHt0Dz7kof7DM7Mt8rTakaORLywh6F5QWtV6WFb4QMBLHBo34sqtUbzZf9pC1ltEyxB/XI+PfftwUlXYMCAb+J3j6s+AG9W315L3TrN8jr/3P9yuFY/SvBtrDs1kIuIfX6yP/P74Ol9jDt/c3xFilvvQDO5kUVzYy1u5qjoAV5aW2XHn8CAJW7bMHUyYrYG/lCCGq0pNxA4Rq7uYvhv4JEx8Z1f0gBGOXlFN75Kpm8cZsIh7vlfYoVaf3quklzed7tTTXHy9VMG+0+ZISI39P9EGIY8yy1mBaE5b/60zh4PN6hT7CGrCi48YOiwwJ7bT8byVT1P7VtPe/d5yp9JvBWK3PsLm/mto3tEf/PlHsaiLJhRs5cJbDZKoJsL7RrDxwj303u83iGCIFC8JKQPueqqHD9uCyOJy/eGo3kBKU01X6c7mI0hLDyJAKiHlnhu4heurW9Yt0t9K2KO8+W1r2Ag295ve8ex3/PxBlhM+5nlkDJ88PQ1UxrkE=~-1~-1~-1~AAQAAAAF%2f%2f%2f%2f%2fwtSNj71VBeXttI9WsVwhoRo9Hi96ImGaC2RANpOg1lj5q42bmaZt29U3mmljwgY9QQDLIPkcBrlwat+ChczxFt8AIWEq90Xar9J~-1' },
            { name: 'bm_sz',   value: '6FAB93C5BE82BF90796B87E506F474DE~YAAQmA7GFz2QEt2eAQAAKoVM8ACre8k2/Mv7TNSIgBikJFAjz/AMyztEOdNAGiuAQDQyzCRNiVuIGjmJ0xKYG2FCCaW1w1nYKpbYRzYxeIdL5jEfdosf0Jx2qQmSX8NiG5fwVjE8fDePsTOjwmw+UEb5HuNPyd/myVSJPPyfgMdQm/WPJv7giWxxLNNw7paXJ3BoNkmEGBk2zPh98hG2xenzSjOeAOSHEQm9Z0rzrea6DMOgL+jhxOeDzcoh835Z3vMeaFnZJvSq/LVdMz+n1KqxMNP94bmMJODsCNJc03k4h9WST1yvW6KmosOwZPB3JQFyx8MzjO+zHzb4qfcIqJZhTZ5tPUK7LVUvscHpKdnSCw0k75iUeLHWKtSjn1MgHv+qhg+mHDYaAmgBI6kVhip68sjl6xHYl4oNsp0/jvHW~3749189~4340022' },
            { name: 'ak_bmsc', value: '05820277C07010E0E6E5786BB834C422~000000000000000000000000000000~YAAQaHQ2F/R50dKeAQAA4IlJ8ABBJBf/J9G7juHewmw8w2KKB5sQDN2M+EvIq+FtBku80mJvN1S+d+t36+qygo41zQFTTOoP9FWwkZpt/C/mCOpQCPV9BcwuemRY1MaMc2fv5ya6J3AGHJScAVwUAxMdFayMseE/UQoRCAeYbXR/xa2ftazJ0bFt4aLtW/rpAbGqLiRpux5hHtQyg54PVMEJ/CioBDaoHzLwo/0FQ3hooCm6fSO0ypdUjhjNq+ocMYEb/I0oeO5MWkystkNDtRfm2CPiAygDdW53Q5pSNyCczs0TlWEZT+wchYSJ5da+A+Z2lY6Hai6+QnAq/qeicFdbmDTynUOaAA9qv83KqKPVi7DoBvd8AvP+7ad4gYVwJCU7eQsMWfwHXSJ6+aQJL4D19qZxQB0Z9cLVnM5r5zcjpGYC6ooJT/UgDt/a1ExfqgYcMIKpDjcHeNG9h0b94z899SQ4TRcRGkfN9RreYzdnC2YqRQ==' },
            { name: 'bm_sv',   value: 'ECDF2F0B76778E2654FCC3599D1EC07D~YAAQkw7GFw3bl9CeAQAAOJdM8ACWHHZNhT5kbnUx0TK805dnMvwoctTlcbdtfoAoQ6dEvwejCuGhraCeEIQQZ/G51d77c0K4/S2JVc+1cZWGgnmMGMI5UYFd7fA/M+4scJXzO0P3vd4aa1OEzBg0CEEjGdHxdKIDhwgHfWfAl6SsV0mb8+FotFnH3hDE0m3rqJg90uuvi+YZ6djL4aDuzxxKMhdX3SZEmuDLUcAxlDFy1st3ZKT513bdwoIWaAVauUKH~1' },
            { name: 'bm_mi',   value: 'C6C13412C2BBA82D0F405EF105898065~YAAQaHQ2Fyhe0dKeAQAA+FdJ8AD2GO0z1/Kxz7nNaaz3xXDUbP5tr/DRPYrYfTUZrVeKOnXNh5rWj4sjLgRtZN3WcijCx3eyWjz5Fhoc+GjndY7F4HkF0Wcda8w5UR+g/SSqDKk4GNTbvt1rKUn0ZbYjJDGorbzcXthenpQbcQSYjza7bpmpJK/DzN1wSsf9hRwV0jUyPc0aas/QGPbqFt8G1Olo0EJgxxCETrHdfJip12u0K2JOYDvMwQeyrISSbhbEorJ9EJENbaHVWZwVLscetQ2tp92nA2VxHG603VSuT+JTwyEEyRbE2mbp1pzo~1' },
          ];

          await page.context().addCookies(
            AKAMAI_COOKIES.map(c => ({
              ...c,
              domain: '.homedepot.com',
              path: '/',
              secure: true,
            }))
          );
        },
      ],

      async requestHandler({ page, log }) {
        log.info('Homepage loaded. Attaching response interceptor...');

        // ─────────────────────────────────────────────────────────────
        // KEY FIX: match responses by BODY SHAPE, not URL.
        // Akamai obfuscates the GraphQL endpoint URL every session
        // (e.g. /sAij2QKKOUMV3x-2ow/...) so URL-pattern matching
        // always breaks. The response shape (data.searchModel.products)
        // is stable regardless of what URL Akamai assigns.
        // ─────────────────────────────────────────────────────────────
        page.on('response', async (response) => {
          const url = response.url();

          // Fast-path: skip known noise
          if (SKIP_DOMAINS.some(d => url.includes(d))) return;
          if (url.match(/\.(jpg|jpeg|png|gif|svg|css|woff2?|ico)(\?|$)/i)) return;

          // Debug mode: log every HD URL so you can spot new endpoints
          if (debugMode) {
            if (url.includes('homedepot.com')) {
              log.info('[DEBUG] ' + url.substring(0, 200));
            }
            return;
          }

          // Diagnostic: log every HD API attempt so we can see what's being parsed
          if (url.includes('homedepot.com') && !url.includes('.html')) {
            log.info(`[TRY] ${url.substring(0, 120)}`);
          }

          try {
            const body = await response.json();
            const products = body?.data?.searchModel?.products;
            if (!products?.length) return;

            log.info(`[HIT] ${products.length} products — ${url.substring(0, 80)}`);

            for (const item of products) {
              if (allItems.length >= maxResults) return;

              const itemId = item.itemId ?? '';
              if (!itemId || seenIds.has(itemId)) continue;
              seenIds.add(itemId);

              const clearancePrice  = item.pricing?.clearance?.value ?? null;
              const regularPrice    = item.pricing?.value ?? 0;
              const originalPrice   = item.pricing?.original ?? regularPrice;
              const price = clearancePrice !== null ? clearancePrice : regularPrice;
              const pct   = item.pricing?.clearance?.percentageOff ??
                (originalPrice > 0 && price > 0
                  ? Math.round(((originalPrice - price) / originalPrice) * 100)
                  : 0);
              const isPenny = price > 0 && price <= 0.03;

              if (price > maxPrice)    continue;
              if (pct < minDiscount)   continue;

              let stock = 0;
              try {
                const bopis = item.fulfillment?.fulfillmentOptions
                  ?.find(o => o.type === 'pickup')
                  ?.services?.find(s => s.type === 'bopis')
                  ?.locations?.find(l => l.locationId === storeId);
                stock = bopis?.inventory?.quantity ?? 0;
              } catch (e) {}

              allItems.push({
                name:            item.identifiers?.productLabel ?? 'Unknown',
                brand:           item.identifiers?.brandName ?? '',
                price,
                retail:          originalPrice,
                pct,
                dollarOff:       Math.round((originalPrice - price) * 100) / 100,
                isPenny,
                isClearanceItem: clearancePrice !== null,
                stock,
                inStock:         stock > 0,
                aisle:           null,
                bay:             null,
                sku:             item.identifiers?.storeSkuNumber ?? '',
                upc:             item.identifiers?.upc ?? '',
                itemId,
                image:           item.media?.images?.[0]?.url ?? '',
                url:             'https://www.homedepot.com' + (item.identifiers?.canonicalUrl ?? ''),
                store:           'Store #' + storeId,
                scrapedAt:       new Date().toISOString(),
              });
            }

            log.info(`Total captured: ${allItems.length}`);
          } catch (e) {
            if (url.includes('homedepot.com')) {
              log.info(`[FAIL] ${url.substring(0, 100)} — ${e.message.substring(0, 60)}`);
            }
          }
        });

        // Wait for homepage — give Akamai sensor script time to complete
        await page.waitForLoadState('load');

        // Simulate realistic human behaviour: random mouse movements across the page
        // Akamai's behavioural scoring watches for interaction patterns
        log.info('Simulating user behaviour on homepage...');
        const viewportSize = page.viewportSize() || { width: 1280, height: 800 };
        for (let i = 0; i < 8; i++) {
          const x = 100 + Math.random() * (viewportSize.width - 200);
          const y = 100 + Math.random() * (viewportSize.height - 200);
          await page.mouse.move(x, y, { steps: 10 });
          await page.waitForTimeout(500 + Math.random() * 800);
        }

        // Scroll down and back up slowly, like a real user
        await page.evaluate(() => window.scrollBy(0, 300));
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollBy(0, 200));
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollBy(0, -100));
        await page.waitForTimeout(600);

        // Let Akamai sensor fully complete before we navigate away
        log.info('Waiting for Akamai sensor to complete...');
        await page.waitForTimeout(15000);

        await page.evaluate(({ sid, zip, name, state }) => {
          const loc = JSON.stringify({
            WORKFLOW: 'LOC_HISTORY_BY_IP',
            THD_FORCE_LOC: '1',
            THD_LOCSTORE: `${sid}+${name}+-+${name},+${state}+`,
            THD_STRFINDERZIP: zip,
          });
          document.cookie = `THD_LOCALIZER=${encodeURIComponent(loc)}; domain=.homedepot.com; path=/`;
          document.cookie = `DELIVERY_ZIP=${zip}; domain=.homedepot.com; path=/`;
          document.cookie = `HD_DC=origin; domain=.homedepot.com; path=/`;
        }, { sid: storeId, zip: storeZip, name: storeName, state: storeState });

        log.info('Store cookies set. Cycling through departments...');

        // Scrape each department sequentially on the same page
        for (const dept of DEPARTMENTS) {
          if (allItems.length >= maxResults) {
            log.info('Max results reached — stopping early.');
            break;
          }

          log.info(`--- ${dept.name} ---`);
          try {
            await page.goto(dept.url, { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(6000);

            // Scroll to trigger lazy product loads
            for (let i = 0; i < 6; i++) {
              await page.evaluate(() => window.scrollBy(0, window.innerHeight));
              await page.waitForTimeout(1200);
            }

            // Click "Show More" / "Load More" if present
            try {
              const btn = await page.$(
                '[data-testid="load-more-btn"], ' +
                'button:has-text("Show More Results"), ' +
                'button:has-text("Load More")'
              );
              if (btn) {
                log.info('Clicking Load More...');
                await btn.click();
                await page.waitForTimeout(3000);
                for (let i = 0; i < 4; i++) {
                  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                  await page.waitForTimeout(1000);
                }
              }
            } catch (e) {}

            log.info(`After ${dept.name}: ${allItems.length} total`);
          } catch (e) {
            log.warning(`${dept.name} failed: ${e.message}`);
          }
        }

        log.info('All departments done. Final total: ' + allItems.length);
      },
    });

    await crawler.run();

    console.log(`Complete — ${allItems.length} items captured.`);
    await Actor.pushData(allItems);
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    await Actor.exit({ exitCode: 1 });
  }
})();