const playwright = require('playwright');
const cheerio = require('cheerio');
const { URL } = require('url'); // For resolving relative URLs

class AdvancedWebpageReaderTool {
  constructor() {
    // Any future initialization can go here
    console.log("AdvancedWebpageReaderTool initialized.");
  }

  async execute({ url }) {
    if (!url || typeof url !== 'string' || url.trim() === "") {
      console.error("AdvancedWebpageReaderTool: Invalid URL provided.");
      return { success: false, error: "Invalid URL", details: "URL string is required." };
    }
    console.log(`AdvancedWebpageReaderTool: Starting to process URL: ${url}`);

    let browser = null;
    try {
      // Launch browser (Chromium is often a good default)
      browser = await playwright.chromium.launch({
        headless: true // Run headless for server environments
      });
      const context = await browser.newContext({
        // Emulate a common user agent
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        // Bypass CSP for easier content access if needed, but be mindful of security implications
        // bypassCSP: true,
      });
      const page = await context.newPage();

      // Navigate to the URL
      console.log(`AdvancedWebpageReaderTool: Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Get page content
      console.log(`AdvancedWebpageReaderTool: Retrieving content from ${url}`);
      const htmlContent = await page.content();

      // Close the browser now that content is retrieved
      console.log(`AdvancedWebpageReaderTool: Closing browser for ${url}`);
      await browser.close();
      browser = null; // Mark as closed

      // Parse content with Cheerio
      console.log(`AdvancedWebpageReaderTool: Parsing content for ${url}`);
      const $ = cheerio.load(htmlContent);

      // Extract Text
      // Attempt to select a main content area, otherwise fallback to body
      let mainText = '';
      const mainContentSelectors = ['article', 'main', '[role="main"]', '.main-content', '#main-content', '.main', '#main'];
      for (const selector of mainContentSelectors) {
        if ($(selector).length) {
          mainText = $(selector).text();
          break;
        }
      }
      if (!mainText) {
        mainText = $('body').text();
      }
      mainText = mainText.replace(/\s\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

      // Extract Image Information
      const images = [];
      $('img').each((index, element) => {
        const src = $(element).attr('src');
        const alt = $(element).attr('alt');
        if (src) {
          try {
            const absoluteSrc = new URL(src, url).href;
            images.push({ src: absoluteSrc, alt: alt || '' });
          } catch (e) {
            // Could be a malformed URL or data URI, etc.
            images.push({ src: src, alt: alt || '', error: 'Could not resolve to absolute URL' });
          }
        }
      });
      console.log(`AdvancedWebpageReaderTool: Successfully processed ${url}`);
      return {
        success: true,
        url: url,
        text: mainText,
        images: images,
        htmlContentPreview: htmlContent.substring(0, 500) + (htmlContent.length > 500 ? '...' : '')
      };

    } catch (e) {
      console.error(`AdvancedWebpageReaderTool: Error processing URL ${url}: ${e.message}`, e);
      if (browser) {
        console.log(`AdvancedWebpageReaderTool: Ensuring browser is closed after error for ${url}`);
        await browser.close();
      }
      return { success: false, error: "Failed to load or process page", details: e.message };
    }
  }
}

module.exports = AdvancedWebpageReaderTool;

// // Example Usage (uncomment to run directly for testing)
// (async () => {
//   const tool = new AdvancedWebpageReaderTool();
//   // const result = await tool.execute({ url: 'https://example.com' });
//   const result = await tool.execute({ url: 'https://www.google.com/search?q=cats' });
//   // const result = await tool.execute({ url: 'https://www.wikipedia.org/' });

//   if (result.success) {
//     console.log("URL:", result.url);
//     console.log("Text (first 500 chars):", result.text.substring(0, 500) + "...");
//     console.log("Images (first 5):", result.images.slice(0, 5));
//     console.log("HTML Preview (first 200 chars):", result.htmlContentPreview);
//     console.log("Total images found:", result.images.length);
//   } else {
//     console.error("Error:", result.error);
//     console.error("Details:", result.details);
//   }
// })();
