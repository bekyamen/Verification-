// find-cbe-endpoint.js
//
// Usage (from your backend folder, where puppeteer is already installed):
//   node find-cbe-endpoint.js "https://mbreciept.cbe.com.et/v2-<your-token>"
//
// Opens the CBE receipt viewer in a headless browser and prints every request
// that looks like data (JSON, PDF, or a URL containing "api"), with the request
// headers and the start of any JSON body.  The request that returns the receipt
// is the endpoint to call directly from the backend.
//
// You can redact the token from the output before sharing.

const puppeteer = require('puppeteer');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node find-cbe-endpoint.js "<receipt-url>"');
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Intercept every response that looks like data
    page.on('response', async (res) => {
      const url = res.url();
      const ct  = (res.headers()['content-type'] || '').toLowerCase();
      const looksLikeData =
        /json|pdf/.test(ct) ||
        /\/api\b|\/api\/|graphql/i.test(url) ||
        url.includes('receipt') ||
        url.includes('transaction');

      if (!looksLikeData) return;

      console.log('\n' + '='.repeat(72));
      console.log(`${res.status()} ${res.request().method()} ${url}`);
      console.log('content-type :', ct || '(none)');
      console.log('req headers  :', JSON.stringify(res.request().headers(), null, 2));

      if (ct.includes('json') || ct.includes('text')) {
        try {
          const body = await res.text();
          console.log('body (first 800 chars):', body.slice(0, 800));
        } catch {
          console.log('(could not read body)');
        }
      } else if (ct.includes('pdf') || url.endsWith('.pdf')) {
        console.log('(PDF response — binary)');
      }
    });

    console.log(`Opening: ${target}`);
    await page.goto(target, { waitUntil: 'networkidle0', timeout: 45_000 });

    // Wait a bit longer for lazily-fired XHRs
    await new Promise((r) => setTimeout(r, 4_000));

    console.log('\n' + '='.repeat(72));
    console.log('Done. All data-like requests printed above.');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
