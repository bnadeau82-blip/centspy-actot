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

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

    const query = `
    query searchModel($storeId: String, $startIndex: Int, $pageSize: Int, $keyword: String, $sortby: String, $orderby: String) {
      searchModel(keyword: $keyword, storeId: $storeId, sortby: $sortby, orderby: $orderby) {
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
          fulfillment {
            anchorStoreStatusType
            fulfillmentOptions {
              type
              services {
                type
                locations {
                  locationId
                  inventory {
                    quantity
                    isInStock
                  }
                }
              }
            }
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
        log.info('Landing on HD homepage to get fresh Akamai cookies...');

        await page.waitForLoadState('load');
        await page.waitForTimeout(5000);

        // Navigate to clearance page to get proper Akamai session
        await page.goto('https://www.homedepot.com/b/Clearance/N-5yc1vZar4y', { waitUntil: 'load' });
        await page.waitForTimeout(4000);

        log.info('Clearance page loaded. URL: ' + page.url());

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

        log.info('Store cookies set. Starting GraphQL pagination...');

        while (!done) {
          log.info('Fetching index ' + startIndex);

          const variables = {
            storeId,
            keyword: 'clearance',
            startIndex,
            pageSize: PAGE_SIZE,
            sortby: 'price',
            orderby: 'asc',
          };

          let json;
          try {
            const cookies = await page.context().cookies();
const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

const apiResponse = await page.request.post(GRAPHQL_URL, {
  headers: {
    'content-type': 'application/json',
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'x-experience-name': 'general-merchandise',
    'x-api-cookies': `{"x-user-id":"guest"}`,
    'x-debug': 'false',
    'x-hd-dc': 'origin',
    'x-current-url': '/s/clearance',
    'origin': 'https://www.homedepot.com',
    'referer': 'https://www.homedepot.com/',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'cookie': cookieHeader,
  },
  data: JSON.stringify({ query, variables }),
});
json = { status: apiResponse.status(), body: await apiResponse.text() };

          } catch (err) {
            log.error('Fetch error: ' + err.message);
            done = true;
            break;
          }

          log.info('Response status: ' + json.status);
          log.info('Body preview: ' + json.body.substring(0, 300));

          if (json.status !== 200) {
            log.error('Non-200 response, stopping');
            done = true;
            break;
          }

          let parsed;
          try {
            parsed = JSON.parse(json.body);
          } catch(e) {
            log.error('Failed to parse JSON: ' + e.message);
            done = true;
            break;
          }

          const products = parsed?.data?.searchModel?.products ?? [];

          if (totalProducts === null) {
            totalProducts = parsed?.data?.searchModel?.searchReport?.totalProducts ?? 0;
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

          log.info('Collected ' + allItems.length + ' items');

          if (allItems.length >= maxResults) { done = true; break; }
          if (totalProducts && startIndex + PAGE_SIZE >= totalProducts) { done = true; break; }

          startIndex += PAGE_SIZE;
          await page.waitForTimeout(800 + Math.random() * 400);
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