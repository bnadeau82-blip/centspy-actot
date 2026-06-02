const { Actor } = require('apify');
const tls = require('tls');
const https = require('https');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });
    console.log('Proxy configured');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '3917';
    const zipcode = input.zipcode || '';
    const maxResults = input.maxResults || 500;
    const minDiscount = input.minDiscount || 0;
    const maxPrice = input.maxPrice || 999999;

    const GRAPHQL_URL = 'https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel';

    const HEADERS = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://www.homedepot.com',
      'Referer': 'https://www.homedepot.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'X-Experience-Name': 'general-merchandise',
      'X-Api-Cookies': JSON.stringify({ 'x-user-id': 'guest' }),
      'X-Debug': 'false',
      'X-Hd-Dc': 'origin',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
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

    // Make a request through the proxy using Node's built-in https
    async function makeRequest(variables) {
      const proxyUrl = await proxyConfiguration.newUrl();
      const proxyParsed = new URL(proxyUrl);
      
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const urlParsed = new URL(GRAPHQL_URL);
        
        // Connect through proxy using CONNECT tunnel
        const proxyReq = https.request({
          host: proxyParsed.hostname,
          port: proxyParsed.port,
          method: 'CONNECT',
          path: `${urlParsed.hostname}:443`,
          headers: {
            'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxyParsed.username}:${decodeURIComponent(proxyParsed.password)}`).toString('base64'),
          },
        });

        proxyReq.on('connect', (res, socket) => {
          const tlsSocket = tls.connect({
            socket,
            servername: urlParsed.hostname,
            rejectUnauthorized: false,
          });

          const req = https.request({
            createConnection: () => tlsSocket,
            hostname: urlParsed.hostname,
            path: urlParsed.pathname + urlParsed.search,
            method: 'POST',
            headers: {
              ...HEADERS,
              'Content-Length': Buffer.byteLength(body),
            },
          });

          req.on('response', (response) => {
            let data = '';
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
              try {
                const buf = Buffer.concat(chunks);
                const json = JSON.parse(buf.toString());
                resolve(json);
              } catch(e) {
                reject(new Error('Failed to parse response: ' + e.message));
              }
            });
          });

          req.on('error', reject);
          req.write(body);
          req.end();
        });

        proxyReq.on('error', reject);
        proxyReq.end();
      });
    }

    const PAGE_SIZE = 24;
    const allItems = [];
    let startIndex = 0;
    let totalProducts = null;

    console.log('Starting CentSpy HD Clearance Scraper...');
    console.log('Store ID:', storeId);

    while (true) {
      console.log('Fetching index ' + startIndex);

      const variables = {
        storeId: storeId || null,
        keyword: 'clearance',
        startIndex,
        pageSize: PAGE_SIZE,
      };

      let json;
      try {
        json = await makeRequest(variables);
      } catch (err) {
        console.log('Request error:', err.message);
        break;
      }

      console.log('Response preview:', JSON.stringify(json).slice(0, 300));

      const products = json?.data?.searchModel?.products ?? [];

      if (totalProducts === null) {
        totalProducts = json?.data?.searchModel?.searchReport?.totalProducts ?? 0;
        console.log('Total products:', totalProducts);
      }

      if (products.length === 0) {
        console.log('No more products');
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

      console.log('Collected ' + allItems.length + ' items');

      if (allItems.length >= maxResults) break;
      if (totalProducts && startIndex + PAGE_SIZE >= totalProducts) break;

      startIndex += PAGE_SIZE;
      await new Promise(r => setTimeout(r, 800));
    }

    console.log('Done! Total: ' + allItems.length);
    await Actor.pushData(allItems);
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    await Actor.exit({ exitCode: 1 });
  }
})();
