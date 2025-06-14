// tools/ReadWebpageTool.js
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { t } = require('../utils/localization');

class ReadWebpageTool {
    constructor() {
        // console.log(t('INIT_DONE', { componentName: 'ReadWebpageTool' })); // If constructor logging was desired
    }

    async execute(input) {
        console.log(t('RW_PROCESSING_URL', { componentName: 'ReadWebpageTool', url: input.url }));
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
            // This error is returned, already Russian.
            return { result: null, error: "ReadWebpageTool: Неверный ввод: требуется непустая строка 'url'." };
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
                console.log(t('RW_PAGE_LOADED', { componentName: 'ReadWebpageTool', url: input.url }));
            } catch (navError) {
                console.error(t('RW_NAV_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url }), navError);
                // Returned error is already Russian
                return { result: null, error: `ReadWebpageTool: Ошибка навигации для ${input.url}: ${navError.message.substring(0, 200)}` };
            }

            const htmlContent = await page.content();

            if (typeof htmlContent !== 'string') {
                console.warn(t('RW_NON_STRING_CONTENT_LOG', { componentName: 'ReadWebpageTool', url: input.url, contentType: typeof htmlContent }));
                // Returned error is already Russian
                return { result: null, error: "ReadWebpageTool: Playwright вернул не строковое содержимое со страницы." };
            }

            let extractedText = null;
            let processingMethod = "";

            // Attempt 1: Use @mozilla/readability
            try {
                console.log(t('RW_READABILITY_ATTEMPT', { componentName: 'ReadWebpageTool', url: input.url }));
                const dom = new JSDOM(htmlContent, { url: input.url });
                const reader = new Readability(dom.window.document);
                const article = reader.parse();

                if (article && article.textContent && article.textContent.trim().length > 0) {
                    extractedText = article.textContent;
                    processingMethod = "Readability";
                    console.log(t('RW_READABILITY_SUCCESS', { componentName: 'ReadWebpageTool', url: input.url }));
                } else {
                    console.log(t('RW_READABILITY_NO_CONTENT_LOG', { componentName: 'ReadWebpageTool', url: input.url }));
                }
            } catch (readabilityError) {
                console.warn(t('RW_READABILITY_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url, errorMessage: readabilityError.message }));
            }

            // Attempt 2: Fallback to Cheerio if Readability failed or produced no text
            if (extractedText === null || extractedText.trim().length === 0) {
                processingMethod = "Cheerio";
                console.log(t('RW_CHEERIO_ATTEMPT', { componentName: 'ReadWebpageTool', url: input.url }));
                try {
                    const $ = cheerio.load(htmlContent);
                    $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();
                    extractedText = $('body').text();
                    console.log(t('RW_CHEERIO_SUCCESS', { componentName: 'ReadWebpageTool', url: input.url }));
                } catch (cheerioError) {
                    console.error(t('RW_CHEERIO_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url }), cheerioError);
                    // Ensure browser is closed even if Cheerio fails before returning
                    if (browser) {
                        await browser.close();
                        console.log(t('RW_BROWSER_CLOSED_CHEERIO_ERROR', { componentName: 'ReadWebpageTool' }));
                        browser = null; // Avoid closing again in finally
                    }
                    // Returned error is already Russian
                    return { result: null, error: `ReadWebpageTool: Не удалось обработать HTML с помощью Cheerio: ${cheerioError.message}` };
                }
            }

            // Common post-processing for text extracted by either method
            if (extractedText && typeof extractedText === 'string') {
                extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ').trim();

                if (extractedText.length === 0) {
                    // Returned result message is already Russian
                    return { result: `ReadWebpageTool: Не найдено значимого текстового содержимого на странице с использованием ${processingMethod || 'любого метода'}.`, error: null, _processingMethod: processingMethod };
                }

                const MAX_TEXT_LENGTH = 15000; // Updated max length
                let truncatedIndicator = "";
                if (extractedText.length > MAX_TEXT_LENGTH) {
                    extractedText = extractedText.substring(0, MAX_TEXT_LENGTH);
                    truncatedIndicator = "... (обрезано)"; // This is part of the result, already Russian.
                    console.log(t('RW_TEXT_TRUNCATED_LOG', { componentName: 'ReadWebpageTool', maxLength: MAX_TEXT_LENGTH }));
                }
                return { result: extractedText + truncatedIndicator, error: null, _processingMethod: processingMethod };
            } else {
                // This case should ideally be caught by the empty checks above, but as a fallback:
                // Returned result message is already Russian
                return { result: "ReadWebpageTool: Не удалось извлечь текстовый контент.", error: null, _processingMethod: processingMethod || "N/A" };
            }

        } catch (error) { // Catches errors from playwright.launch, newContext, newPage, or general errors not caught by inner handlers
            console.error(t('RW_PLAYWRIGHT_GENERAL_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url }), error);
            // Returned error is already Russian
            return { result: null, error: `ReadWebpageTool: Ошибка операции Playwright или основной обработки: ${error.message.substring(0,200)}` };
        } finally {
            if (browser) {
                await browser.close();
                console.log(t('RW_BROWSER_CLOSED', { componentName: 'ReadWebpageTool' }));
            }
        }
    }
}

module.exports = ReadWebpageTool;
