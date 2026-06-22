const { Actor } = require('apify');
const { PlaywrightCrawler, RequestList } = require('crawlee');

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
      headless: true,
      browserPoolOptions: { useFingerprints: true },
      requestHandlerTimeoutSecs: 900,
      // Single entry point: homepage. We navigate to each department inside the handler.
      requestList: await RequestList.open(null, ['https://www.homedepot.com/']),

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

        // Wait for homepage then set store cookies
        await page.waitForLoadState('load');
        await page.waitForTimeout(4000);

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
            await page.waitForTimeout(3000);

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