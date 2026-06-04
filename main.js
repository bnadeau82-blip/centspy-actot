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
        log.info('Browser landed on HD homepage, warming up session...');

        // Wait for Akamai to finish any challenges/redirects and page to fully settle
        await page.waitForLoadState('networkidle');
        log.info('Network idle, waiting additional settle time...');
        await page.waitForTimeout(5000);
        log.info('Current URL: ' + page.url());

        while (!done) {
          log.info('Fetching index ' + startIndex);

          const variables = {
            storeId,
            keyword: 'clearance',
            startIndex,
            pageSize: PAGE_SIZE,
          };

          let json;
          try {
            // Execute GraphQL call FROM INSIDE the browser page
            // This carries real browser TLS fingerprint, cookies, and headers
            json = await page.evaluate(async ({ url, query, variables }) => {
              const res = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': '*/*',
                  'Accept-Language': 'en-US,en;q=0.9',
                  'Origin': 'https://www.homedepot.com',
                  'Referer': 'https://www.homedepot.com/',
                  'X-Experience-Name': 'general-merchandise',
                  'X-Api-Cookies': '{"x-user-id":"guest"}',
                  'X-Debug': 'false',
                  'X-Hd-Dc': 'origin',
                },
                body: JSON.stringify({ query, variables }),
              });
              return res.json();
            }, { url: GRAPHQL_URL, query, variables });

          } catch (err) {
            log.error('Request error: ' + err.message);
            done = true;
            break;
          }

          const preview = JSON.stringify(json).slice(0, 300);
          log.info('Response preview: ' + preview);

          const products = json?.data?.searchModel?.products ?? [];

          if (totalProducts === null) {
            totalProducts = json?.data?.searchModel?.searchReport?.totalProducts ?? 0;
            log.info('Total products: ' + totalProducts);
          }

          if (products.length === 0) {
            log.info('No more products');
            done = true;
            break;
          }

          for (const item of products) {
            if (allItems.length >= maxResults) break;

            const clearancePrice = item.pricing?.clearance?.value ?? null;
            const regularPrice = item.pricing?.value ?? 0;
            const originalPrice = item.pricing?.original ?? regularPrice;
            const price = clearancePrice !== null ? clearancePrice : regularPrice;
            const dollarOff = item.pricing?.clearance?.dollarOff ?? Math.round((originalPrice - price) * 100) / 100;
            const pct = item.pricing?.clearance?.percentageOff ?? (originalPrice > 0 && price > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0);
            const isPenny = price > 0 && price <= 0.03;

            if (price > maxPrice) continue;
            if (pct < minDiscount) continue;

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

          log.info('Collected ' + allItems.length + ' items');

          if (allItems.length >= maxResults) { done = true; break; }
          if (totalProducts && startIndex + PAGE_SIZE >= totalProducts) { done = true; break; }

          startIndex += PAGE_SIZE;

          // Human-like delay between requests
          await page.waitForTimeout(1000 + Math.random() * 500);
        }
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
