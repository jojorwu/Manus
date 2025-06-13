// tools/ReadWebpageTool.js
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

class ReadWebpageTool {
    constructor() {
        // console.log("ReadWebpageTool: Инициализирован с поддержкой Playwright, Readability и Cheerio."); // Example if constructor logging was desired
    }

    async execute(input) {
        console.log('ReadWebpageTool: Начинаю обработку URL:', input.url);
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
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
                console.log('ReadWebpageTool: Страница успешно загружена:', input.url);
            } catch (navError) {
                console.error(`ReadWebpageTool: Ошибка навигации для URL ${input.url}: ${navError.message}`);
                return { result: null, error: `ReadWebpageTool: Ошибка навигации для ${input.url}: ${navError.message.substring(0, 200)}` };
            }

            const htmlContent = await page.content();

            if (typeof htmlContent !== 'string') {
                console.warn(`ReadWebpageTool: Playwright вернул не строковое содержимое для URL ${input.url}, тип: ${typeof htmlContent}`);
                return { result: null, error: "ReadWebpageTool: Playwright вернул не строковое содержимое со страницы." };
            }

            let extractedText = null;
            let processingMethod = "";

            // Attempt 1: Use @mozilla/readability
            try {
                console.log('ReadWebpageTool: Попытка извлечения контента с помощью Readability для URL:', input.url);
                const dom = new JSDOM(htmlContent, { url: input.url });
                const reader = new Readability(dom.window.document);
                const article = reader.parse();

                if (article && article.textContent && article.textContent.trim().length > 0) {
                    extractedText = article.textContent;
                    processingMethod = "Readability";
                    console.log('ReadWebpageTool: Контент успешно извлечен с помощью Readability для URL:', input.url);
                } else {
                    console.log('ReadWebpageTool: Readability не нашел значимого контента для URL:', input.url);
                }
            } catch (readabilityError) {
                console.warn(`ReadWebpageTool: Ошибка Readability для URL ${input.url}: ${readabilityError.message}. Переключаюсь на Cheerio.`);
            }

            // Attempt 2: Fallback to Cheerio if Readability failed or produced no text
            if (extractedText === null || extractedText.trim().length === 0) {
                processingMethod = "Cheerio";
                console.log('ReadWebpageTool: Попытка извлечения контента с помощью Cheerio для URL:', input.url);
                try {
                    const $ = cheerio.load(htmlContent);
                    $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();
                    extractedText = $('body').text();
                    console.log('ReadWebpageTool: Контент успешно извлечен с помощью Cheerio для URL:', input.url);
                } catch (cheerioError) {
                    console.error(`ReadWebpageTool: Ошибка обработки Cheerio для URL ${input.url}: ${cheerioError.message}`);
                    // Ensure browser is closed even if Cheerio fails before returning
                    if (browser) {
                        await browser.close();
                        console.log('ReadWebpageTool: Браузер Playwright закрыт (после ошибки Cheerio).');
                        browser = null; // Avoid closing again in finally
                    }
                    return { result: null, error: `ReadWebpageTool: Не удалось обработать HTML с помощью Cheerio: ${cheerioError.message}` };
                }
            }

            // Common post-processing for text extracted by either method
            if (extractedText && typeof extractedText === 'string') {
                extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ').trim();

                if (extractedText.length === 0) {
                    return { result: `ReadWebpageTool: Не найдено значимого текстового содержимого на странице с использованием ${processingMethod || 'любого метода'}.`, error: null, _processingMethod: processingMethod };
                }

                const MAX_TEXT_LENGTH = 15000; // Updated max length
                let truncatedIndicator = "";
                if (extractedText.length > MAX_TEXT_LENGTH) {
                    extractedText = extractedText.substring(0, MAX_TEXT_LENGTH);
                    truncatedIndicator = "... (обрезано)";
                    console.log('ReadWebpageTool: Текст был обрезан до', MAX_TEXT_LENGTH, 'символов.');
                }
                return { result: extractedText + truncatedIndicator, error: null, _processingMethod: processingMethod };
            } else {
                // This case should ideally be caught by the empty checks above, but as a fallback:
                return { result: "ReadWebpageTool: Не удалось извлечь текстовый контент.", error: null, _processingMethod: processingMethod || "N/A" };
            }

        } catch (error) { // Catches errors from playwright.launch, newContext, newPage, or general errors not caught by inner handlers
            console.error(`ReadWebpageTool: Общая ошибка Playwright или обработки для URL ${input.url}:`, error);
            return { result: null, error: `ReadWebpageTool: Ошибка операции Playwright или основной обработки: ${error.message.substring(0,200)}` };
        } finally {
            if (browser) {
                await browser.close();
                console.log('ReadWebpageTool: Браузер Playwright закрыт.');
            }
        }
    }
}

module.exports = ReadWebpageTool;
