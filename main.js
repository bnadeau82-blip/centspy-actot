const { Actor } = require('apify');
const { PlaywrightCrawler, RequestList } = require('crawlee');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '3917';
    const maxResults = input.maxResults || 500;
    const minDiscount = input.minDiscount || 0;
    const maxPrice = input.maxPrice || 999999;
    const debugMode = input.debugMode || false;

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    const allItems = [];

    console.log('Starting CentSpy HD Clearance Scraper...');
    console.log('Store ID:', storeId);

    const crawler = new PlaywrightCrawler({
      proxyConfiguration,
      headless: true,
      browserPoolOptions: { useFingerprints: true },
      requestHandlerTimeoutSecs: 600,
      requestList: await RequestList.open(null, [
        'https://www.homedepot.com/'
      ]),

      async requestHandler({ page, log }) {
        log.info('Landing on HD homepage...');
        await page.waitForLoadState('load');
        await page.waitForTimeout(5000);
        log.info('Homepage loaded. Setting up interceptor...');

        page.on('response', async (response) => {
          const url = response.url();

          // Debug mode: log all HD URLs so we can find the right endpoint
          if (debugMode) {
            if (
              url.includes('homedepot.com') &&
              !url.includes('.jpg') &&
              !url.includes('.png') &&
              !url.includes('.css') &&
              !url.includes('.js') &&
              !url.includes('.woff') &&
              !url.includes('.svg') &&
              !url.includes('.gif')
            ) {
              log.info('URL: ' + url.substring(0, 200));
            }
            return;
          }

          // Production mode: intercept GraphQL search responses
          if (url.includes('graphql') && url.includes('searchModel')) {
            try {
              const body = await response.json();
              const products = body?.data?.searchModel?.products ?? [];

              for (const item of products) {
                if (allItems.length >= maxResults) return;

                const clearancePrice = item.pricing?.clearance?.value ?? null;
                const regularPrice = item.pricing?.value ?? 0;
                const originalPrice = item.pricing?.original ?? regularPrice;
                const price = clearancePrice !== null ? clearancePrice : regularPrice;
                const pct = item.pricing?.clearance?.percentageOff ??
                  (originalPrice > 0 && price > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0);
                const isPenny = price > 0 && price <= 0.03;

                if (price > maxPrice) return;
                if (pct < minDiscount) return;

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
                  dollarOff: Math.round((originalPrice - price) * 100) / 100,
                  isPenny,
                  isClearanceItem: clearancePrice !== null,
                  stock,
                  inStock: stock > 0,
                  aisle: null,
                  bay: null,
                  sku: item.identifiers?.storeSkuNumber ?? '',
                  upc: item.identifiers?.upc ?? '',
                  itemId: item.itemId ?? '',
                  image: item.media?.images?.[0]?.url ?? '',
                  url: 'https://www.homedepot.com' + (item.identifiers?.canonicalUrl ?? ''),
                  store: 'Store #' + storeId,
                  scrapedAt: new Date().toISOString(),
                });
              }

              if (products.length > 0) {
                log.info('Intercepted batch. Total so far: ' + allItems.length);
              }
            } catch(e) {
              // ignore non-JSON responses
            }
          }
        });

        // Set store cookies
        await page.evaluate((storeId) => {
          const localizerValue = JSON.stringify({
            WORKFLOW: 'LOC_HISTORY_BY_IP',
            THD_FORCE_LOC: '1',
            THD_LOCSTORE: `${storeId}+Moore+-+Moore,+OK+`,
            THD_STRFINDERZIP: '73160',
          });
          document.cookie = `THD_LOCALIZER=${encodeURIComponent(localizerValue)}; domain=.homedepot.com; path=/`;
          document.cookie = `DELIVERY_ZIP=73160; domain=.homedepot.com; path=/`;
          document.cookie = `HD_DC=origin; domain=.homedepot.com; path=/`;
          document.cookie = `IN_STORE_API_SESSION=TRUE; domain=.homedepot.com; path=/`;
        }, storeId);

        // Navigate to Appliances department (has real products with clearance tags)
        log.info('Navigating to Appliances department...');
        await page.goto(
          'https://www.homedepot.com/b/Appliances/N-5yc1vZc3pl',
          { waitUntil: 'networkidle', timeout: 60000 }
        );
        await page.waitForTimeout(3000);

        log.info('Scrolling to trigger product loads...');
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await page.waitForTimeout(2000);
        }

        log.info('Scrape complete. Total: ' + allItems.length);
      },
    });

    await crawler.run();

    console.log('Done! Total: ' + allItems.length);
    await Actor.pushData(allItems);
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    await Actor.exit({ exitCode: 1 });
  }
})();