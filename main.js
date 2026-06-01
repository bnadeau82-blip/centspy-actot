const { Actor } = require('apify');
const { HttpsProxyAgent } = require('https-proxy-agent');

(async () => {
  await Actor.init();

  const input = await Actor.getInput() || {};
  const storeId = input.storeId || '';
  const zipCode = input.zipCode || input.zipcode || '';
  const maxResults = input.maxResults || 100;

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
  });

  const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

  const query = `
  query searchModel(
    $startIndex: Int
    $pageSize: Int
    $storeId: String
    $zipCode: String
    $navParam: String
    $storefilter: StoreFilter = ALL
    $channel: Channel = DESKTOP
    $skipInstallServices: Boolean = true
    $skipFavoriteCount: Boolean = false
    $skipKPF: Boolean = false
    $skipSpecificationGroup: Boolean = false
    $skipSubscribeAndSave: Boolean = false
    $skipDiscoveryZones: Boolean = true
  ) {
    searchModel(
      navParam: $navParam
      storefilter: $storefilter
      storeId: $storeId
      channel: $channel
    ) {
      products(startIndex: $startIndex, pageSize: $pageSize) {
        itemId
        identifiers {
          storeSkuNumber
          canonicalUrl
          brandName
          productLabel
          modelNumber
        }
        pricing(storeId: $storeId) {
          value
          original
          promotion {
            type
            dollarOff
            percentageOff
            promotionTag
          }
        }
        fulfillment(storeId: $storeId, zipCode: $zipCode) {
          fulfillmentOptions {
            type
            fulfillable
            services {
              locations {
                inventory {
                  isInStock
                  quantity
                }
                isAnchor
                storeName
              }
              type
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

  const PAGE_SIZE = 24;
  const allItems = [];
  let startIndex = 0;
  let totalProducts = null;

  console.log('Starting CentSpy HD Clearance Scraper...');
  console.log('Store ID:', storeId || 'ZIP: ' + zipCode);

  while (true) {
    console.log('Fetching index ' + startIndex);

    const proxyUrl = await proxyConfiguration.newUrl();
    const agent = new HttpsProxyAgent(proxyUrl);

    const variables = {
      storeId: storeId || null,
      zipCode: zipCode || null,
      navParam: 'N-5yc1vZ1z11adf',
      startIndex: startIndex,
      pageSize: PAGE_SIZE,
      storefilter: 'ALL',
      channel: 'DESKTOP',
      skipInstallServices: true,
      skipFavoriteCount: true,
      skipKPF: true,
      skipSpecificationGroup: true,
      skipSubscribeAndSave: true,
      skipDiscoveryZones: true,
    };

    const HEADERS = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.homedepot.com',
      'Referer': 'https://www.homedepot.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Experience-Name': 'general-merchandise',
      'X-Api-Cookies': '{"x-user-id":"guest"}',
    };

    let response;
    try {
      response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables }),
        agent: agent,
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
    console.log('Response preview:', JSON.stringify(json).slice(0, 500));

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

      const price = item.pricing ? item.pricing.value : 0;
      const original = item.pricing ? item.pricing.original : 0;
      const pct = item.pricing && item.pricing.promotion ? item.pricing.promotion.percentageOff : (original > 0 && price > 0 ? Math.round(((original - price) / original) * 100) : 0);
      const dollarOff = item.pricing && item.pricing.promotion ? item.pricing.promotion.dollarOff : 0;
      const isPenny = price > 0 && price <= 0.03;

      var stock = 0;
      var inStock = false;
      if (item.fulfillment && item.fulfillment.fulfillmentOptions) {
        for (var fo of item.fulfillment.fulfillmentOptions) {
          if (fo.services) {
            for (var svc of fo.services) {
              if (svc.locations) {
                for (var loc of svc.locations) {
                  if (loc.isAnchor && loc.inventory) {
                    stock = loc.inventory.quantity || 0;
                    inStock = loc.inventory.isInStock || false;
                  }
                }
              }
            }
          }
        }
      }

      allItems.push({
        name: item.identifiers ? item.identifiers.productLabel : 'Unknown',
        brand: item.identifiers ? item.identifiers.brandName : '',
        price: price,
        retail: original,
        pct: pct,
        dollarOff: dollarOff,
        isPenny: isPenny,
        stock: stock,
        inStock: inStock,
        sku: item.identifiers ? item.identifiers.storeSkuNumber : '',
        itemId: item.itemId || '',
        image: item.media && item.media.images && item.media.images[0] ? item.media.images[0].url : '',
        url: 'https://www.homedepot.com' + (item.identifiers && item.identifiers.canonicalUrl ? item.identifiers.canonicalUrl : ''),
        store: storeId ? 'Store #' + storeId : 'Near ' + zipCode,
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
