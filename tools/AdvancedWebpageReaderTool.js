const playwright = require('playwright');
const cheerio = require('cheerio');
const { URL } = require('url'); // For resolving relative URLs

/**
 * AdvancedWebpageReaderTool uses Playwright to load webpages, extract textual content,
 * and optionally, image information. It maintains a persistent browser instance
 * to optimize performance across multiple calls.
 */
class AdvancedWebpageReaderTool {
  /**
   * Initializes the tool and starts the asynchronous browser initialization.
   * The browser instance is managed internally.
   */
  constructor() {
    this.browser = null; // Holds the Playwright browser instance.
    // Asynchronous initialization of the browser.
    // This is done to avoid making the constructor itself async, which can be problematic.
    this._initializeBrowser().then(() => {
      // Logging the attempt. Success/failure is logged in _initializeBrowser.
      console.log("INFO: AdvancedWebpageReaderTool: Browser initialization process kicked off via constructor.");
    }).catch(error => {
      // This catch is for unexpected errors in the _initializeBrowser().then() chain itself,
      // though _initializeBrowser already catches its own errors.
      console.error("ERROR: AdvancedWebpageReaderTool: Unexpected error during post-initialization step in constructor:", error);
    });
    console.log("INFO: AdvancedWebpageReaderTool instance created, browser initialization pending or in progress.");
  }

  /**
   * Asynchronously launches the Playwright Chromium browser and assigns it to this.browser.
   * This method is called by the constructor and can be called by execute if the browser
   * was not previously initialized or was closed.
   * It manages its own errors and logs the outcome.
   */
  async _initializeBrowser() {
    try {
      console.log("INFO: AdvancedWebpageReaderTool: Attempting to launch Playwright browser...");
      this.browser = await playwright.chromium.launch({ headless: true });
      console.log("INFO: AdvancedWebpageReaderTool: Playwright browser launched successfully.");
    } catch (error) {
      console.error("ERROR: AdvancedWebpageReaderTool: Failed to launch Playwright browser:", error);
      this.browser = null; // Ensure browser is null if launch fails to prevent further issues.
    }
  }

  /**
   * Executes the webpage reading process for a given URL.
   * It uses the managed browser instance. If the browser is not ready,
   * it attempts to initialize it.
   * The method handles page navigation, content type checking, text extraction,
   * and image gathering. Page and context are closed after each execution,
   * but the browser instance remains open.
   * @param {object} params - The parameters object.
   * @param {string} params.url - The URL to read.
   * @returns {Promise<object>} - A promise that resolves to an object containing
   *                              the extracted data or an error.
   */
  async execute({ url }) {
    if (!url || typeof url !== 'string' || url.trim() === "") {
      console.error("ERROR: AdvancedWebpageReaderTool: Invalid URL provided.");
      return { success: false, error: "Invalid URL", details: "URL string is required." };
    }
    console.log(`INFO: AdvancedWebpageReaderTool: Starting to process URL: ${url}`);

    // Check if browser is initialized. If not, attempt to initialize.
    // This makes the tool resilient, e.g. if initial constructor init failed or browser was closed.
    if (!this.browser || !this.browser.isConnected()) {
      console.warn("WARN: AdvancedWebpageReaderTool: Browser not initialized or not connected. Attempting to initialize now.");
      await this._initializeBrowser();
      if (!this.browser || !this.browser.isConnected()) {
        console.error("ERROR: AdvancedWebpageReaderTool: Browser initialization failed or browser is not connected. Cannot proceed with URL processing.");
        return { success: false, error: "Browser not initialized", details: "Playwright browser instance could not be started or is not connected." };
      }
      console.log("INFO: AdvancedWebpageReaderTool: Browser re-initialized successfully for execute method.");
    }

    let context = null;
    let page = null; // Initialize page to null for the finally block
    try {
      // Create a new incognito browser context for each execution.
      // This provides isolation between different calls to `execute`.
      context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        // Consider adding other context options if needed, e.g., viewport size, locale.
      });
      page = await context.newPage();

      console.log(`INFO: AdvancedWebpageReaderTool: Navigating to ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      if (!response) {
        // This case can happen for various reasons, e.g., 204 No Content responses, or network issues not throwing an error.
        console.warn(`WARN: AdvancedWebpageReaderTool: No response object received from page.goto for ${url}. This might indicate an empty response or network issue.`);
        // Attempt to get content anyway, or decide to error out.
        // For now, proceed and let content extraction logic handle it.
      } else {
        const headers = response.headers();
        const contentType = headers['content-type'] || headers['Content-Type'] || ''; // Handle case variations
        console.log(`INFO: AdvancedWebpageReaderTool: Content-Type for ${url} is '${contentType}'`);

        // Handle non-HTML content types directly if possible.
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
          let bodyText = "";
          try {
            bodyText = await page.evaluate(() => document.body.innerText); // Best effort for JS-rendered text
          } catch(evalError){
             console.warn(`WARN: AdvancedWebpageReaderTool: Could not get document.body.innerText for non-HTML content at ${url}. Error: ${evalError.message}`);
             try {
                bodyText = await page.textContent('body') || ""; // Fallback for simpler text extraction
             } catch (textContentError) {
                console.warn(`WARN: AdvancedWebpageReaderTool: Could not get page.textContent('body') for non-HTML content at ${url}. Error: ${textContentError.message}`);
                const rawContentOnError = await page.content(); // Last resort: get raw page content
                bodyText = rawContentOnError.substring(0, 2000); // Limit size for safety
             }
          }
          // The browser instance (this.browser) is NOT closed here to allow reuse.
          // Only the page and context are closed in the finally block.

          if (contentType.includes('application/json')) {
            try {
              JSON.parse(bodyText); // Validate if it's actual JSON
              console.log(`INFO: AdvancedWebpageReaderTool: Detected and validated JSON content for ${url}.`);
              return {
                success: true, url: url, text: bodyText, images: [], contentType: 'application/json',
                htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '') // Provide preview for JSON
              };
            } catch (jsonError) {
              console.warn(`WARN: AdvancedWebpageReaderTool: Content-Type was JSON, but failed to parse content as JSON for ${url}. Error: ${jsonError.message}. Returning as text.`);
              return { // Still return success true, but indicate it's treated as text.
                success: true, url: url, text: bodyText.trim(), images: [], contentType: contentType,
                htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '')
              };
            }
          } else if (contentType.startsWith('text/')) { // Handles text/plain, text/csv, etc.
            console.log(`INFO: AdvancedWebpageReaderTool: Detected plain text content for ${url}.`);
            return {
              success: true, url: url, text: bodyText.trim(), images: [], contentType: contentType,
              htmlContentPreview: bodyText.substring(0, 500) + (bodyText.length > 500 ? '...' : '')
            };
          } else {
            // For other non-HTML/JSON/text types (e.g., images, PDFs), text extraction might be minimal or irrelevant.
            console.log(`INFO: AdvancedWebpageReaderTool: Unsupported content type ('${contentType}') for direct text extraction for ${url}. Returning basic info.`);
            return { // Return success:false as the tool's primary purpose (HTML text extraction) isn't met well.
              success: false, error: 'Unsupported content type for deep extraction',
              details: `Content-Type is '${contentType}'. This tool primarily processes HTML. A raw text snippet was attempted.`,
              contentType: contentType, text: bodyText.trim(), images: [] // Still return any sniffed text and content type
            };
          }
        }
      }
      // If it's HTML or content type check was inconclusive (e.g. !response), proceed with HTML processing.
      console.log(`INFO: AdvancedWebpageReaderTool: Retrieving HTML content from ${url} for parsing.`);
      const htmlContent = await page.content();
      // The browser instance (this.browser) is NOT closed here.

      console.log(`INFO: AdvancedWebpageReaderTool: Parsing HTML content for ${url} using Cheerio.`);
      const $ = cheerio.load(htmlContent);

      // Attempt to extract main content using common semantic tags and IDs/classes.
      // This is a heuristic approach and might need refinement for specific site structures.
      let mainText = '';
      const mainContentSelectors = ['article', 'main', '[role="main"]', '.main-content', '#main-content', '.main', '#main', '#content'];
      for (const selector of mainContentSelectors) {
        if ($(selector).length) {
          mainText = $(selector).text(); // .text() from Cheerio strips HTML tags
          if (mainText.trim()) break; // Use first one with actual text
        }
      }
      if (!mainText.trim()) { // Fallback to full body text if main content selectors fail
        mainText = $('body').text();
      }
      // Basic text cleaning: replace multiple spaces/newlines with single ones.
      mainText = mainText.replace(/\s\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

      const images = [];
      $('img').each((index, element) => {
        const src = $(element).attr('src');
        const altText = $(element).attr('alt') || ''; // Ensure altText is defined, default to empty string
        if (src) {
          try {
            const absoluteSrc = new URL(src, url).href; // Resolve relative URLs to absolute
            images.push({ src: absoluteSrc, alt: altText });
          } catch (e) {
            // If URL resolution fails (e.g. malformed src), store original src with an error note.
            images.push({ src: src, alt: altText, error: 'Could not resolve to absolute URL: ' + e.message });
          }
        }
      });
      console.log(`INFO: AdvancedWebpageReaderTool: Successfully processed HTML content for ${url}. Found ${images.length} images.`);
      return {
        success: true, url: url, text: mainText, images: images, contentType: 'text/html', // Assuming it's HTML if it reached here
        htmlContentPreview: htmlContent.substring(0, 500) + (htmlContent.length > 500 ? '...' : '')
      };

    } catch (e) {
      console.error(`ERROR: AdvancedWebpageReaderTool: Unhandled error processing URL ${url}: ${e.message}`, e.stack);
      // The shared browser instance (this.browser) is NOT closed in case of an error during a specific URL processing.
      // This allows the tool to be used for subsequent URLs. Only page and context are closed.
      return { success: false, error: "Failed to load or process page", details: e.message };
    } finally {
      // Crucial cleanup: ensure page and context are closed to free resources,
      // regardless of success or failure in the try block.
      if (page) {
        try {
          await page.close();
          console.log(`INFO: AdvancedWebpageReaderTool: Page closed successfully for ${url}`);
        } catch (pcError) {
          console.error(`ERROR: AdvancedWebpageReaderTool: Error closing page for ${url}: ${pcError.message}`);
        }
      }
      if (context) {
        try {
          await context.close();
          console.log(`INFO: AdvancedWebpageReaderTool: Context closed successfully for ${url}`);
        } catch (ccError) {
          console.error(`ERROR: AdvancedWebpageReaderTool: Error closing context for ${url}: ${ccError.message}`);
        }
      }
    }
  }

  /**
   * Closes the persistent Playwright browser instance.
   * This method should be called when the application is shutting down
   * or when the tool is no longer needed, to free up system resources.
   */
  async closeBrowser() {
    if (this.browser && this.browser.isConnected()) {
      try {
        console.log("INFO: AdvancedWebpageReaderTool: Attempting to close Playwright browser...");
        await this.browser.close();
        console.log("INFO: AdvancedWebpageReaderTool: Playwright browser closed successfully.");
        this.browser = null; // Set to null after successful close.
      } catch (error) {
        console.error("ERROR: AdvancedWebpageReaderTool: Error closing Playwright browser:", error);
        this.browser = null; // Attempt to nullify even if close fails, to prevent reuse of a bad instance.
      }
    } else {
      console.log("INFO: AdvancedWebpageReaderTool: Browser already closed, not connected, or never initialized.");
      this.browser = null; // Ensure it's null if not connected or doesn't exist.
    }
  }
}

module.exports = AdvancedWebpageReaderTool;

// // Example Usage (updated to show closeBrowser)
// (async () => {
//   const tool = new AdvancedWebpageReaderTool();
//   // Wait a bit for browser to initialize, in a real app this might be handled by startup logic
//   await new Promise(resolve => setTimeout(resolve, 2000));

//   const urlsToTest = [
//     'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img', // HTML
//     'https://jsonplaceholder.typicode.com/todos/1', // JSON
//     'https://www.w3.org/TR/PNG/iso_8859-1.txt', // Plain text
//     'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png' // PNG image (will be handled as non-HTML)
//   ];

//   for (const testUrl of urlsToTest) {
//     console.log(`\n--- Testing URL: ${testUrl} ---`);
//     const result = await tool.execute({ url: testUrl });
//     if (result.success) {
//       console.log("  URL:", result.url);
//       console.log("  Content-Type:", result.contentType);
//       console.log("  Text (first 200 chars):", result.text ? result.text.substring(0, 200) + "..." : "N/A");
//       console.log("  Images (first 2):", result.images ? result.images.slice(0, 2) : "N/A");
//       console.log("  Total images found:", result.images ? result.images.length : "N/A");
//     } else {
//       console.error("  Error:", result.error);
//       console.error("  Details:", result.details);
//       if(result.contentType) console.error("  Content-Type:", result.contentType);
//       if(result.text) console.error("  Sniffed Text (first 100 chars):", result.text.substring(0,100) + "...");
//     }
//   }

//   // Close the browser when done with all operations
//   await tool.closeBrowser();
// })();
