// tools/ReadWebpageTool.js
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

class ReadWebpageTool {
    constructor() {
        // console.log("ReadWebpageTool initialized with Playwright, Readability, and Cheerio support.");
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
                javaScriptEnabled: true,
            });
            const page = await context.newPage();

            try {
                await page.goto(input.url, { waitUntil: 'networkidle', timeout: 45000 });
            } catch (navError) {
                console.error(`ReadWebpageTool: Navigation error for ${input.url}: ${navError.message}`);
                return { result: null, error: `Navigation failed for ${input.url}: ${navError.message.substring(0, 200)}` };
            }

            const htmlContent = await page.content();

            if (typeof htmlContent !== 'string') {
                console.warn(`ReadWebpageTool: Playwright returned non-string content for URL ${input.url}, typeof: ${typeof htmlContent}`);
                return { result: null, error: "Playwright returned non-string content from page." };
            }

            let extractedText = null;
            let processingMethod = "";

            // Attempt 1: Use @mozilla/readability
            try {
                console.log(`ReadWebpageTool: Attempting to extract content with Readability for ${input.url}`);
                const dom = new JSDOM(htmlContent, { url: input.url });
                const reader = new Readability(dom.window.document);
                const article = reader.parse();

                if (article && article.textContent && article.textContent.trim().length > 0) {
                    extractedText = article.textContent;
                    processingMethod = "Readability";
                    console.log(`ReadWebpageTool: Content successfully extracted using Readability for ${input.url}`);
                } else {
                    console.log(`ReadWebpageTool: Readability did not find substantial content for ${input.url}.`);
                }
            } catch (readabilityError) {
                console.warn(`ReadWebpageTool: Readability failed for ${input.url}: ${readabilityError.message}. Falling back to Cheerio.`);
            }

            // Attempt 2: Fallback to Cheerio if Readability failed or produced no text
            if (extractedText === null || extractedText.trim().length === 0) {
                processingMethod = "Cheerio";
                console.log(`ReadWebpageTool: Attempting to extract content with Cheerio for ${input.url}`);
                try {
                    const $ = cheerio.load(htmlContent);
                    $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();
                    extractedText = $('body').text();
                } catch (cheerioError) {
                    console.error(`ReadWebpageTool: Cheerio processing failed for ${input.url}: ${cheerioError.message}`);
                    // Ensure browser is closed even if Cheerio fails before returning
                    if (browser) {
                        await browser.close();
                        browser = null; // Avoid closing again in finally
                    }
                    return { result: null, error: `Failed to process HTML with Cheerio: ${cheerioError.message}` };
                }
            }

            // Common post-processing for text extracted by either method
            if (extractedText && typeof extractedText === 'string') {
                extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ').trim();

                if (extractedText.length === 0) {
                    return { result: `No meaningful text content found on the page using ${processingMethod || 'any method'}.`, error: null, _processingMethod: processingMethod };
                }

                const MAX_TEXT_LENGTH = 15000; // Updated max length
                let truncatedIndicator = "";
                if (extractedText.length > MAX_TEXT_LENGTH) {
                    extractedText = extractedText.substring(0, MAX_TEXT_LENGTH);
                    truncatedIndicator = "... (truncated)";
                }
                return { result: extractedText + truncatedIndicator, error: null, _processingMethod: processingMethod };
            } else {
                // This case should ideally be caught by the empty checks above, but as a fallback:
                return { result: "No text content could be extracted.", error: null, _processingMethod: processingMethod || "N/A" };
            }

        } catch (error) { // Catches errors from playwright.launch, newContext, newPage, or general errors not caught by inner handlers
            console.error(`ReadWebpageTool: General Playwright or processing error for URL ${input.url}:`, error);
            return { result: null, error: `Playwright operation or main processing failed: ${error.message.substring(0,200)}` };
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}

module.exports = ReadWebpageTool;
