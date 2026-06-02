const { Actor } = require('apify');
const puppeteer = require('puppeteer');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });
    console.log('Proxy configured: RESIDENTIAL');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '';
    const zipcode = input.zipcode || '';
    const maxResults = input.maxResults || 100;
    const minDiscount = input.minDiscount || 0;
    const maxPrice = input.maxPrice || 999999;

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

    const PAGE_SIZE = 24;
    const allItems = [];
    let startIndex = 0;
    let totalProducts = null;

    console.log('Starting CentSpy HD Clearance Scraper...');
    console.log('Store ID:', storeId || ('ZIP: ' + zipcode));

    // Launch Puppeteer with residential proxy
    const proxyUrl = await proxyConfiguration.newUrl();
    console.log('Launching browser with proxy...');

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--proxy-server=${proxyUrl}`,
      ],
    });

    const page = await browser.newPage();

    // Set cookies from a real HD session
    await page.setCookie(
      { name: 'thda.u', value: 'e8c4d6b6-138f-6816-413f-7b6d787a6631', domain: '.homedepot.com' },
      { name: 'DELIVERY_ZIP', value: zipcode || '73160', domain: '.homedepot.com' },
      { name: 'THD_LOCALIZER', value: encodeURIComponent(JSON.stringify({
        WORKFLOW: 'LOCALIZED_BY_STORE',
        THD_FORCE_LOC: '0',
        THD_LOCSTORE: storeId ? `${storeId}+` : '3917+Moore - Moore, OK+',
        THD_STRFINDERZIP: zipcode || '73160',
      })), domain: '.homedepot.com' },
    );

    console.log('Browser launched, starting pagination...');

    while (true) {
      console.log('Fetching index ' + startIndex);

      const variables = {
        storeId: storeId || null,
        keyword: 'clearance',
        startIndex: startIndex,
        pageSize: PAGE_SIZE,
      };

      let json;
      try {
        const response = await page.evaluate(async (url, query, variables) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': '*/*',
              'Origin': 'https://www.homedepot.com',
              'Referer': 'https://www.homedepot.com/',
              'X-Experience-Name': 'fusion-hdh-pip-mobile',
              'X-Api-Cookies': '{"x-user-id":"e8c4d6b6-138f-6816-413f-7b6d787a6631"}',
              'X-Debug': 'false',
              'X-Hd-Dc': 'origin',
            },
            body: JSON.stringify({ query, variables }),
          });
          return res.json();
        }, GRAPHQL_URL, query, variables);

        json = response;
      } catch (err) {
        console.log('Fetch error:', err.message);
        break;
      }

      console.log('Response preview:', JSON.stringify(json).slice(0, 300));

      const products =
        json.data &&
        json.data.searchModel &&
        json.data.searchModel.products
          ? json.data.searchModel.products
          : [];

      if (totalProducts === null) {
        totalProducts =
          json.data &&
          json.data.searchModel &&
          json.data.searchModel.searchReport
            ? json.data.searchModel.searchReport.totalProducts
            : 0;
        console.log('Total products:', totalProducts);
      }

      if (products.length === 0) {
        console.log('No more products');
        break;
      }

      for (const item of products) {
        if (allItems.length >= maxResults) break;

        const clearancePrice = item.pricing && item.pricing.clearance ? item.pricing.clearance.value : null;
        const regularPrice = item.pricing ? item.pricing.value : 0;
        const originalPrice = item.pricing ? item.pricing.original : regularPrice;
        const price = clearancePrice !== null ? clearancePrice : regularPrice;

        const dollarOff =
          item.pricing && item.pricing.clearance && item.pricing.clearance.dollarOff != null
            ? item.pricing.clearance.dollarOff
            : (originalPrice > 0 && price > 0 ? Math.round((originalPrice - price) * 100) / 100 : 0);

        const pct =
          item.pricing && item.pricing.clearance
            ? item.pricing.clearance.percentageOff
            : originalPrice > 0 && price > 0
              ? Math.round(((originalPrice - price) / originalPrice) * 100)
              : 0;

        const isPenny = price > 0 && price <= 0.03;

        if (price > maxPrice) continue;
        if (pct < minDiscount) continue;

        allItems.push({
          name: item.identifiers ? item.identifiers.productLabel : 'Unknown',
          brand: item.identifiers ? item.identifiers.brandName : '',
          price: price,
          retail: originalPrice,
          pct: pct,
          dollarOff: dollarOff,
          isPenny: isPenny,
          isClearanceItem: clearancePrice !== null,
          stock: 0,
          inStock: item.availabilityType ? item.availabilityType.status : false,
          aisle: item.location ? item.location.aisle : null,
          bay: item.location ? item.location.bay : null,
          sku: item.identifiers ? item.identifiers.storeSkuNumber : '',
          upc: item.identifiers ? item.identifiers.upc : '',
          itemId: item.itemId || '',
          image: item.media && item.media.images && item.media.images[0] ? item.media.images[0].url : '',
          url: 'https://www.homedepot.com' + (item.identifiers && item.identifiers.canonicalUrl ? item.identifiers.canonicalUrl : ''),
          store: storeId ? 'Store #' + storeId : 'Near ' + zipcode,
          scrapedAt: new Date().toISOString(),
        });
      }

      console.log('Collected ' + allItems.length + ' items');

      if (allItems.length >= maxResults) break;
      if (totalProducts && startIndex + PAGE_SIZE >= totalProducts) break;

      startIndex += PAGE_SIZE;
      await new Promise(function(r) { setTimeout(r, 1000); });
    }

    await browser.close();
    console.log('Done! Total: ' + allItems.length);
    await Actor.pushData(allItems);
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    await Actor.exit({ exitCode: 1 });
  }
})();
