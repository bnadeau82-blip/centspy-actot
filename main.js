import { Actor } from 'apify';

(async () => {
  await Actor.init();

  const input = await Actor.getInput() || {};
  const storeId = input.storeId || '';
  const zipcode = input.zipcode || '';
  const maxResults = input.maxResults || 100;
  const minDiscount = input.minDiscount || 0;
  const maxPrice = input.maxPrice || 999999;

  const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

  const HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': 'https://www.homedepot.com',
    'Referer': 'https://www.homedepot.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Experience-Name': 'general-merchandise',
    'X-Api-Cookies': '{"x-user-id":"guest"}',
  };

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
  console.log('Store ID:', storeId || 'ZIP: ' + zipcode);

  while (true) {
    console.log('Fetching index ' + startIndex);

    const variables = {
      storeId: storeId || null,
      keyword: 'clearance',
      startIndex: startIndex,
      pageSize: PAGE_SIZE,
    };

    let response;
    try {
      response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      console.log('Fetch error:', err.message);
      break;
    }

    if (!response.ok) {
      console.log('Bad response:', response.status);
      break;
    }

    const json = await response.json();
    console.log('Response preview:', JSON.stringify(json).slice(0, 300));

    const products = json.data && json.data.searchModel && json.data.searchModel.products ? json.data.searchModel.products : [];

    if (totalProducts === null) {
      totalProducts = json.data && json.data.searchModel && json.data.searchModel.searchReport ? json.data.searchModel.searchReport.totalProducts : 0;
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
      const pct = item.pricing && item.pricing.clearance ? item.pricing.clearance.percentageOff : (originalPrice > 0 && price > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0);
      const isPenny = price > 0 && price <= 0.03;

      if (price > maxPrice) continue;
      if (pct < minDiscount) continue;

      allItems.push({
        name: item.identifiers ? item.identifiers.productLabel : 'Unknown',
        brand: item.identifiers ? item.identifiers.brandName : '',
        price: price,
        retail: originalPrice,
        pct: pct,
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
