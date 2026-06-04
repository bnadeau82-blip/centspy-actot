const { Actor } = require('apify');
const { PlaywrightCrawler, RequestList } = require('crawlee');

(async () => {
  try {
    await Actor.init();
    console.log('Actor initialized');

    const input = await Actor.getInput() || {};
    const storeId = input.storeId || '3917';

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: 'US',
    });

    // Just one category for debugging
    const CATEGORIES = [
      `https://www.homedepot.com/b/Tools/N-5yc1vZc1xz?sortby=price&order=asc&storeSelection=${storeId}`,
    ];

    console.log('Starting CentSpy DEBUG run...');

    const crawler = new PlaywrightCrawler({
      proxyConfiguration,
      headless: true,
      browserPoolOptions: { useFingerprints: true },
      requestHandlerTimeoutSecs: 120,
      requestList: await RequestList.open(null, CATEGORIES),

      async requestHandler({ page, request, log }) {
        log.info('Scanning: ' + request.url);

        // Log ALL network requests so we can see what's firing
        page.on('request', (req) => {
          const url = req.url();
          if (url.includes('homedepot') && url.includes('graphql')) {
            log.info('GraphQL REQUEST: ' + url);
          }
        });

        page.on('response', async (response) => {
          const url = response.url();
          if (url.includes('homedepot') && (url.includes('graphql') || url.includes('api'))) {
            log.info('API RESPONSE [' + response.status() + ']: ' + url.substring(0, 100));
            try {
              const text = await response.text();
              // Log first 200 chars to see what's coming back
              log.info('BODY PREVIEW: ' + text.substring(0, 200));
            } catch(e) {}
          }
        });

        await page.waitForLoadState('networkidle');
        log.info('Page loaded. URL: ' + page.url());

        // Save screenshot
        const screenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue('screenshot', screenshot, { contentType: 'image/png' });

        await page.waitForTimeout(3000);
        log.info('Debug run complete');
      },
    });

    await crawler.run();
    await Actor.exit();

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    await Actor.exit({ exitCode: 1 });
  }
})();
