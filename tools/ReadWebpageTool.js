// tools/ReadWebpageTool.js
const { chromium } = require('playwright');
const cheerio = require('cheerio');

class ReadWebpageTool {
    constructor() {
        // console.log("ReadWebpageTool initialized with Playwright support.");
    }

    async execute(input) {
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
            return { result: null, error: "Invalid input for ReadWebpageTool: 'url' string is required." };
        }

        let browser = null;
        try {
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                javaScriptEnabled: true, // Ensure JS is enabled, though networkidle should handle most cases
            });
            const page = await context.newPage();

            try {
                await page.goto(input.url, { waitUntil: 'networkidle', timeout: 45000 });
            } catch (navError) {
                console.error(`ReadWebpageTool: Navigation error for ${input.url}: ${navError.message}`);
                // Browser will be closed in the finally block of the outer try
                return { result: null, error: `Navigation failed for ${input.url}: ${navError.message.substring(0, 200)}` };
            }

            const htmlContent = await page.content();

            if (typeof htmlContent !== 'string') {
                 console.warn(`ReadWebpageTool: Playwright returned non-string content for URL ${input.url}, typeof: ${typeof htmlContent}`);
                return { result: null, error: "Playwright returned non-string content from page." };
            }

            // HTML content is available, process with Cheerio
            try {
                const $ = cheerio.load(htmlContent);

                // Remove unnecessary elements
                $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();

                let extractedText = $('body').text();

                if (extractedText) {
                    extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ');
                    extractedText = extractedText.trim();

                    if (extractedText.length === 0) {
                        return { result: "No meaningful text content found on the page after processing.", error: null };
                    }

                    const MAX_TEXT_LENGTH = 10000;
                    if (extractedText.length > MAX_TEXT_LENGTH) {
                        extractedText = extractedText.substring(0, MAX_TEXT_LENGTH) + "... (truncated)";
                    }
                    return { result: extractedText, error: null };
                } else {
                    return { result: "No text content found in body after processing.", error: null };
                }
            } catch (cheerioError) {
                console.error(`ReadWebpageTool: Error processing HTML content with Cheerio for URL ${input.url}:`, cheerioError);
                return { result: null, error: `Failed to process HTML content with Cheerio: ${cheerioError.message}` };
            }

        } catch (error) { // Catches errors from playwright.launch, newContext, newPage, or general errors
            console.error(`ReadWebpageTool: General Playwright error for URL ${input.url}:`, error);
            return { result: null, error: `Playwright operation failed: ${error.message.substring(0,200)}` };
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}

module.exports = ReadWebpageTool;
