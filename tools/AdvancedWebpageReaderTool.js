const playwright = require('playwright');
const cheerio = require('cheerio');
const { URL } = require('url'); // For resolving relative URLs

class AdvancedWebpageReaderTool {
  constructor() {
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
      browser = await playwright.chromium.launch({
        headless: true
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      });
      const page = await context.newPage();

      console.log(`AdvancedWebpageReaderTool: Navigating to ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      if (!response) {
        console.warn(`AdvancedWebpageReaderTool: No response object from page.goto for ${url}. This might indicate a problem or an empty response (e.g. 204).`);
        // Attempt to get content anyway, or decide to error out.
        // For now, let's try to get content; if it fails, the main catch will handle it.
        // If it succeeds but there's no content type, it will be treated as potentially non-HTML by later checks.
      } else {
        const headers = response.headers();
        const contentType = headers['content-type'] || headers['Content-Type'] || '';
        console.log(`AdvancedWebpageReaderTool: Content-Type for ${url} is ${contentType}`);

        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
          let bodyText = "";
          try {
            bodyText = await page.evaluate(() => document.body.innerText);
          } catch(evalError){
             console.warn(`AdvancedWebpageReaderTool: Could not get document.body.innerText for non-HTML content at ${url}. Error: ${evalError.message}`);
             // Try page.textContent() as a more resilient fallback for some non-HTML text types
             try {
                bodyText = await page.textContent('body') || "";
             } catch (textContentError) {
                console.warn(`AdvancedWebpageReaderTool: Could not get page.textContent('body') for non-HTML content at ${url}. Error: ${textContentError.message}`);
                // If all fails, use an empty string or whatever content might have been loaded.
                const rawContentOnError = await page.content(); // Last resort
                bodyText = rawContentOnError.substring(0, 2000); // Limit size
             }
          }

          console.log(`AdvancedWebpageReaderTool: Closing browser for non-HTML content at ${url}`);
          await browser.close();
          browser = null;

          if (contentType.includes('application/json')) {
            try {
              JSON.parse(bodyText); // Validate if it's JSON
              console.log(`AdvancedWebpageReaderTool: Detected JSON content for ${url}.`);
              return {
                success: true, url: url, text: bodyText, images: [], contentType: 'application/json',
                htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '')
              };
            } catch (jsonError) {
              console.warn(`AdvancedWebpageReaderTool: Content-Type was JSON, but failed to parse content as JSON for ${url}. Error: ${jsonError.message}. Returning as text.`);
              return {
                success: true, url: url, text: bodyText.trim(), images: [], contentType: contentType, // Return the body text as is
                htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '')
              };
            }
          } else if (contentType.startsWith('text/')) {
            console.log(`AdvancedWebpageReaderTool: Detected plain text content for ${url}.`);
            return {
              success: true, url: url, text: bodyText.trim(), images: [], contentType: contentType,
              htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '')
            };
          } else {
            console.log(`AdvancedWebpageReaderTool: Unsupported content type (${contentType}) for direct text extraction for ${url}.`);
            return {
              success: false, error: 'Unsupported content type',
              details: `Content-Type is '${contentType}'. This tool primarily processes HTML. Raw content snippet: ${bodyText.substring(0,200)}...`,
              contentType: contentType, text: bodyText.trim(), images: [] // Still return sniffed text
            };
          }
        }
      }

      // If HTML, proceed as before
      console.log(`AdvancedWebpageReaderTool: Retrieving HTML content from ${url}`);
      const htmlContent = await page.content();

      console.log(`AdvancedWebpageReaderTool: Closing browser for HTML content at ${url}`);
      await browser.close();
      browser = null;

      console.log(`AdvancedWebpageReaderTool: Parsing HTML content for ${url}`);
      const $ = cheerio.load(htmlContent);

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

      const images = [];
      $('img').each((index, element) => {
        const src = $(element).attr('src');
        const altText = $(element).attr('alt') || ''; // Ensure altText is defined
        if (src) {
          try {
            const absoluteSrc = new URL(src, url).href;
            images.push({ src: absoluteSrc, alt: altText });
          } catch (e) {
            images.push({ src: src, alt: altText, error: 'Could not resolve to absolute URL: ' + e.message });
          }
        }
      });
      console.log(`AdvancedWebpageReaderTool: Successfully processed HTML for ${url}`);
      return {
        success: true, url: url, text: mainText, images: images, contentType: 'text/html', // Assuming it's HTML if it reached here
        htmlContentPreview: htmlContent.substring(0, 500) + (htmlContent.length > 500 ? '...' : '')
      };

    } catch (e) {
      console.error(`AdvancedWebpageReaderTool: Error processing URL ${url}: ${e.message}`, e.stack);
      if (browser) {
        console.log(`AdvancedWebpageReaderTool: Ensuring browser is closed after error for ${url}`);
        await browser.close();
      }
      return { success: false, error: "Failed to load or process page", details: e.message };
    }
  }
}

module.exports = AdvancedWebpageReaderTool;

// // Example Usage
// (async () => {
//   const tool = new AdvancedWebpageReaderTool();
//   const urlsToTest = [
//     'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img', // HTML
//     'https://jsonplaceholder.typicode.com/todos/1', // JSON
//     'https://www.w3.org/TR/PNG/iso_8859-1.txt', // Plain text
//     'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png' // PNG image
//   ];

//   for (const testUrl of urlsToTest) {
//     console.log(`\n--- Testing URL: ${testUrl} ---`);
//     const result = await tool.execute({ url: testUrl });
//     if (result.success) {
//       console.log("  URL:", result.url);
//       console.log("  Content-Type:", result.contentType);
//       console.log("  Text (first 200 chars):", result.text ? result.text.substring(0, 200) + "..." : "N/A");
//       console.log("  Images (first 2):", result.images.slice(0, 2));
//       console.log("  Total images found:", result.images.length);
//     } else {
//       console.error("  Error:", result.error);
//       console.error("  Details:", result.details);
//       if(result.contentType) console.error("  Content-Type:", result.contentType);
//       if(result.text) console.error("  Sniffed Text:", result.text.substring(0,100));
//     }
//   }
// })();
