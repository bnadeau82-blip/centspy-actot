const { Actor } = require('apify');
const { PlaywrightCrawler, RequestList } = require('crawlee');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '3917';
    const maxResults = input.maxResults || 1000;
    const maxPrice = input.maxPrice || 999999;

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    // Major HD category browse pages — these load naturally and fire GraphQL
    // Each sorted by lowest price to surface clearance/penny items first
    const CATEGORIES = [
      'https://www.homedepot.com/b/Tools/N-5yc1vZc1xz?sortby=price&order=asc',
      'https://www.homedepot.com/b/Electrical/N-5yc1vZc1x2?sortby=price&order=asc',
      'https://www.homedepot.com/b/Plumbing/N-5yc1vZc1x8?sortby=price&order=asc',
      'https://www.homedepot.com/b/Hardware/N-5yc1vZc21m?sortby=price&order=asc',
      'https://www.homedepot.com/b/Paint/N-5yc1vZbzov?sortby=price&order=asc',
      'https://www.homedepot.com/b/Lighting-Ceiling-Fans/N-5yc1vZbvn1?sortby=price&order=asc',
      'https://www.homedepot.com/b/Bath/N-5yc1vZbz7m?sortby=price&order=asc',
      'https://www.homedepot.com/b/Flooring/N-5yc1vZaqo5?sortby=price&order=asc',
      'https://www.homedepot.com/b/Building-Materials/N-5yc1vZbz6k?sortby=price&order=asc',
      'https://www.homedepot.com/b/Lawn-Garden/N-5yc1vZbx7z?sortby=price&order=asc',
      'https://www.homedepot.com/b/Kitchen/N-5yc1vZbz77?sortby=price&order=asc',
      'https://www.homedepot.com/b/Storage-Organization/N-5yc1vZc7qd?sortby=price&order=asc',
      'https://www.homedepot.com/b/Smart-Home/N-5yc1vZbvmb?sortby=price&order=asc',
      'https://www.homedepot.com/b/Heating-Venting-Cooling/N-5yc1vZc4l2?sortby=price&order=asc',
    ];

    const allItems = [];
    const seenItemIds = new Set();

    console.log('Starting CentSpy HD Category Scraper...');
    console.log('Store ID:', storeId);
    console.log('Categories to scan:', CATEGORIES.length);

    const crawler = new PlaywrightCrawler({
      proxyConfiguration,
      headless: true,
      browserPoolOptions: {
        useFingerprints: true,
      },
      maxConcurrency: 1,
      requestHandlerTimeoutSecs: 120,
      requestList: await RequestList.open(null, CATEGORIES),

      async requestHandler({ page, request, log }) {
        log.info('Scanning: ' + request.url);

        // Intercept GraphQL responses as the page loads naturally
        page.on('response', async (response) => {
          const url = response.url();
          if (!url.includes('federation-gateway/graphql')) return;

          try {
            const json = await response.json();
            const products = json?.data?.searchModel?.products ?? [];
            if (products.length === 0) return;

            let found = 0;
            for (const item of products) {
              if (allItems.length >= maxResults) break;
              if (seenItemIds.has(item.itemId)) continue;

              const clearancePrice = item.pricing?.clearance?.value ?? null;
              const storeStatus = item.fulfillment?.anchorStoreStatusType ?? '';
              const isClearance = clearancePrice !== null || storeStatus === 'CLEARANCE';

              if (!isClearance) continue;

              seenItemIds.add(item.itemId);

              const regularPrice = item.pricing?.value ?? 0;
              const originalPrice = item.pricing?.original ?? regularPrice;
              const price = clearancePrice !== null ? clearancePrice : regularPrice;
              const dollarOff = item.pricing?.clearance?.dollarOff ?? Math.round((originalPrice - price) * 100) / 100;
              const pct = item.pricing?.clearance?.percentageOff ?? (originalPrice > 0 && price > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0);
              const isPenny = price > 0 && price <= 0.03;

              if (price > maxPrice) continue;

              // Get store-specific stock from fulfillment
              let stock = 0;
              try {
                const bopis = item.fulfillment?.fulfillmentOptions
                  ?.find(o => o.type === 'pickup')
                  ?.services?.find(s => s.type === 'bopis')
                  ?.locations?.find(l => l.locationId === storeId);
                stock = bopis?.inventory?.quantity ?? 0;
              } catch(e) {}

              allItems.push({
                name: item.identifiers?.productLabel ?? 'Unknown',
                brand: item.identifiers?.brandName ?? '',
                price,
                retail: originalPrice,
                pct,
                dollarOff,
                isPenny,
                isClearanceItem: true,
                stock,
                inStock: stock > 0,
                aisle: item.location?.aisle ?? null,
                bay: item.location?.bay ?? null,
                sku: item.identifiers?.storeSkuNumber ?? '',
                upc: item.identifiers?.upc ?? '',
                itemId: item.itemId ?? '',
                image: item.media?.images?.[0]?.url ?? '',
                url: 'https://www.homedepot.com' + (item.identifiers?.canonicalUrl ?? ''),
                store: 'Store #' + storeId,
                scrapedAt: new Date().toISOString(),
              });
              found++;
            }

            if (found > 0) {
              log.info('Found ' + found + ' clearance items. Total: ' + allItems.length);
            }

          } catch (e) {
            // silently skip
          }
        });

        // Let page load fully so Akamai issues cookies and GraphQL fires
        await page.waitForLoadState('networkidle');
        log.info('Page loaded. Clearance items so far: ' + allItems.length);

        // Scroll a couple times to trigger more product loads
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(2000);
        }

        log.info('Done with category. Total clearance: ' + allItems.length);
      },
    });

    await crawler.run();

    console.log('Done! Total clearance items: ' + allItems.length);
    await Actor.pushData(allItems);
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    await Actor.exit({ exitCode: 1 });
  }
})();
