const { Actor } = require('apify');
const { gotScraping } = require('got-scraping');

(async () => {
  await Actor.init();

  // Use residential proxy to bypass Akamai/Forter bot detection
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
  });

  const input = await Actor.getInput() || {};
  const storeId = input.storeId || '';
  const zipcode = input.zipcode || '';
  const maxResults = input.maxResults || 100;
  const minDiscount = input.minDiscount || 0;
  const maxPrice = input.maxPrice || 999999;

  const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

  const HEADERS = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://www.homedepot.com',
    'Referer': 'https://www.homedepot.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
    'X-Experience-Name': 'fusion-hdh-pip-mobile',
    'X-Api-Cookies': '{"x-user-id":"e8c4d6b6-138f-6816-413f-7b6d787a6631"}',
    'X-Debug': 'false',
    'X-Hd-Dc': 'origin',
    'X-Thd-Customer-Token': '',
    'Sec-Ch-Ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': [
      '_px_f394gi7Fvmc43dfg_user_id=MzU0M2QyNjEtNjk3Ni0xMWYwLWIzNDctZTU2NjY2MjZmMzYz',
      'thda.u=e8c4d6b6-138f-6816-413f-7b6d787a6631',
      'DELIVERY_ZIP=73160',
      'DELIVERY_ZIP_TYPE=USER',
      'HD_DC=origin',
      'THD_NR=1',
      'IN_STORE_API_SESSION=TRUE',
      'THD_LOCALIZER=%7B%22WORKFLOW%22%3A%22LOCALIZED_BY_STORE%22%2C%22THD_FORCE_LOC%22%3A%220%22%2C%22THD_LOCSTORE%22%3A%223917%2BMoore%20-%20Moore%2C%20OK%2B%22%2C%22THD_STRFINDERZIP%22%3A%2273160%22%7D',
      'thda.s=4d279277-649e-3f5c-d10d-ab6da71de7f5',
      'forterToken=8523ab142468405aa0a3e4433e8dcad6_1780346592383__UDF43-m4_29ck_',
      'AKA_A2=A',
      'IN_STORE_USER_NUMBER=Not%20In%20Store',
      'PIM-SESSION-ID=KN4IPANTDehMrt3C',
    ].join('; '),
  };

  // FIX 1: Added zip to query variables so zipcode input is actually used
  const query = `
  query searchModel($storeId: String, $zip: String, $startIndex: Int, $pageSize: Int, $keyword: String) {
    searchModel(keyword: $keyword, storeId: $storeId, zipcode: $zip) {
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
        inventory(storeId: $storeId) {
          isInStock
          quantity
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

  while (true) {
    console.log('Fetching index ' + startIndex);

    const variables = {
      storeId: storeId || null,
      zip: zipcode || null,   // FIX 1: actually pass zipcode to GraphQL
      keyword: 'clearance',
      startIndex: startIndex,
      pageSize: PAGE_SIZE,
    };

    let response;
    try {
      const proxyUrl = await proxyConfiguration.newUrl();
      const result = await gotScraping({
        url: GRAPHQL_URL,
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables }),
        proxyUrl,
        responseType: 'json',
      });
      response = result.body;
    } catch (err) {
      console.log('Fetch error:', err.message);
      break;
    }

    const json = response;
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

      // FIX 2: dollarOff now correctly read from clearance object
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
        dollarOff: dollarOff,   // FIX 2: now included in output
        isPenny: isPenny,
        isClearanceItem: clearancePrice !== null,
        stock: item.inventory ? item.inventory.quantity : 0,
        inStock: item.inventory ? item.inventory.isInStock : false,
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
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  console.log('Done! Total: ' + allItems.length);
  await Actor.pushData(allItems);
  await Actor.exit();

})();
