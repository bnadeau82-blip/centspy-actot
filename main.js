const { Actor } = require('apify');
const { PlaywrightCrawler } = require('crawlee');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '3917';
    const maxResults = input.maxResults || 500;
    const minDiscount = input.minDiscount || 0;
    const maxPrice = input.maxPrice || 999999;

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

    const query = `
    query searchModel($storeId: String, $startIndex: Int, $pageSize: Int, $keyword: String) {
      searchModel(keyword: $keyword, storeId: $storeId) {
        products(startIndex: $startIndex, pageSize: $pageSize) {
          itemId
          identifiers {
            brandName
            productLabel
            storeSkuNumber
            canonicalUrl
            upc
          }
          pricing(storeId: $storeId) {
            value
            original
            clearance {
              value
              dollarOff
              percentageOff
            }
          }
          availabilityType {
            discontinued
            status
          }
          location {
            aisle
            bay
          }
          media {
            images {
              url
            }
          }
        }
        searchReport {
          totalProducts
        }
      }
    }`;

    const allItems = [];
    const PAGE_SIZE = 24;
    let startIndex = 0;
    let totalProducts = null;
    let done = false;

    console.log('Starting CentSpy HD Clearance Scraper (Playwright mode)...');
    console.log('Store ID:', storeId);

    const crawler = new PlaywrightCrawler({
      proxyConfiguration,
      headless: true,
      browserPoolOptions: {
        useFingerprints: true,
      },
      requestHandlerTimeoutSecs: 300,
      requestList: await require('crawlee').RequestList.open(null, [
        'https://www.homedepot.com/'
      ]),

      async requestHandler({ page, log }) {
        log.info('Setting up network interception...');

        // Intercept GraphQL responses that the page makes naturally
        // This way Akamai sees legitimate page-initiated requests
        page.on('response', async (response) => {
          const url = response.url();
          if (url.includes('federation-gateway/graphql') && !done) {
            try {
              const json = await response.json();
              const products = json?.data?.searchModel?.products ?? [];

              if (totalProducts === null) {
                totalProducts = json?.data?.searchModel?.searchReport?.totalProducts ?? 0;
                log.info('Total products: ' + totalProducts);
              }

              log.info('Intercepted ' + products.length + ' products from network');

              for (const item of products) {
                if (allItems.length >= maxResults) break;

                const clearancePrice = item.pricing?.clearance?.value ?? null;
                const regularPrice = item.pricing?.value ?? 0;
                const originalPrice = item.pricing?.original ?? regularPrice;
                const price = clearancePrice !== null ? clearancePrice : regularPrice;
                const dollarOff = item.pricing?.clearance?.dollarOff ?? Math.round((originalPrice - price) * 100) / 100;
                const pct = item.pricing?.clearance?.percentageOff ?? (originalPrice > 0 && price > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0);
                const isPenny = price > 0 && price <= 0.03;

                if (price > maxPrice) return;
                if (pct < minDiscount) return;

                allItems.push({
                  name: item.identifiers?.productLabel ?? 'Unknown',
                  brand: item.identifiers?.brandName ?? '',
                  price,
                  retail: originalPrice,
                  pct,
                  dollarOff,
                  isPenny,
                  isClearanceItem: clearancePrice !== null,
                  stock: 0,
                  inStock: item.availabilityType?.status ?? false,
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
              }

              log.info('Collected ' + allItems.length + ' items so far');

              if (allItems.length >= maxResults) {
                done = true;
              }

            } catch (e) {
              log.error('Failed to parse intercepted response: ' + e.message);
            }
          }
        });

        // Navigate to HD clearance search page — the page will fire GraphQL naturally
        const searchUrl = `https://www.homedepot.com/s/clearance?NCNI-5&storeSelection=${storeId}`;
        log.info('Navigating to: ' + searchUrl);
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
        log.info('Page loaded. Items collected: ' + allItems.length);

        // Scroll down to trigger pagination loads
        let lastCount = 0;
        let stallCount = 0;

        while (!done && stallCount < 5) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(2000 + Math.random() * 1000);

          if (allItems.length === lastCount) {
            stallCount++;
            log.info('No new items, stall count: ' + stallCount);
          } else {
            stallCount = 0;
            lastCount = allItems.length;
            log.info('Scrolled, total items: ' + allItems.length);
          }
        }

        done = true;
        log.info('Scroll complete. Final count: ' + allItems.length);
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
