// tools/ReadWebpageTool.js - Инструмент для чтения веб-страниц
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const crypto = require('crypto');
const { t } = require('../utils/localization');

class ReadWebpageTool {
    constructor() {
        // console.log(t('INIT_DONE', { componentName: 'ReadWebpageTool' })); // Если логирование конструктора было необходимо
    }

    async execute(input) {
        console.log(t('RW_PROCESSING_URL', { componentName: 'ReadWebpageTool', url: input.url }));
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
            // Эта ошибка возвращается, уже на русском языке.
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
                // Возвращаемая ошибка, уже на русском языке.
                return { result: null, error: `ReadWebpageTool: Ошибка навигации для ${input.url}: ${navError.message.substring(0, 200)}` };
            }

            const htmlContent = await page.content();

            if (typeof htmlContent !== 'string') {
                console.warn(t('RW_NON_STRING_CONTENT_LOG', { componentName: 'ReadWebpageTool', url: input.url, contentType: typeof htmlContent }));
                // Возвращаемая ошибка, уже на русском языке.
                return { result: null, error: "ReadWebpageTool: Playwright вернул не строковое содержимое со страницы." };
            }

            let extractedText = null;
            let processingMethod = "";
            let articleTitle = null; // For Readability title

            // Попытка 1: Использовать @mozilla/readability
            try {
                console.log(t('RW_READABILITY_ATTEMPT', { componentName: 'ReadWebpageTool', url: input.url }));
                const dom = new JSDOM(htmlContent, { url: input.url });
                const reader = new Readability(dom.window.document);
                const article = reader.parse(); // article can be null

                if (article && article.textContent && article.textContent.trim().length > 0) {
                    extractedText = article.textContent;
                    articleTitle = article.title || null; // Capture title if available
                    processingMethod = "Readability";
                    console.log(t('RW_READABILITY_SUCCESS', { componentName: 'ReadWebpageTool', url: input.url }));
                } else {
                    console.log(t('RW_READABILITY_NO_CONTENT_LOG', { componentName: 'ReadWebpageTool', url: input.url, hasArticle: !!article }));
                }
            } catch (readabilityError) {
                console.warn(t('RW_READABILITY_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url, errorMessage: readabilityError.message }));
            }

            // Попытка 2: Переход к Cheerio, если Readability не удалась или не вернула текст
            if (extractedText === null || extractedText.trim().length === 0) {
                articleTitle = null; // Reset title if falling back to Cheerio, as Cheerio doesn't easily provide a single "article title"
                processingMethod = "Cheerio";
                console.log(t('RW_CHEERIO_ATTEMPT', { componentName: 'ReadWebpageTool', url: input.url }));
                try {
                    const $ = cheerio.load(htmlContent);
                    $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();
                    extractedText = $('body').text();
                    console.log(t('RW_CHEERIO_SUCCESS', { componentName: 'ReadWebpageTool', url: input.url }));
                } catch (cheerioError) {
                    console.error(t('RW_CHEERIO_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url }), cheerioError);
                    // Убедиться, что браузер закрыт, даже если Cheerio завершается с ошибкой, перед возвратом
                    if (browser) {
                        await browser.close();
                        console.log(t('RW_BROWSER_CLOSED_CHEERIO_ERROR', { componentName: 'ReadWebpageTool' }));
                        browser = null; // Avoid closing again in finally
                    }
                    // Возвращаемая ошибка, уже на русском языке.
                    return { result: null, error: `ReadWebpageTool: Не удалось обработать HTML с помощью Cheerio: ${cheerioError.message}` };
                }
            }

            // Общая постобработка для текста, извлеченного любым из методов
            if (extractedText && typeof extractedText === 'string') {
                extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ').trim();

                if (extractedText.length === 0) {
                    // Возвращаемое сообщение о результате, уже на русском языке.
                    return { result: `ReadWebpageTool: Не найдено значимого текстового содержимого на странице с использованием ${processingMethod || 'любого метода'}.`, error: null, _processingMethod: processingMethod };
                }

                const MAX_TEXT_LENGTH = 15000; // Обновленная максимальная длина
                let truncatedIndicator = "";
                if (extractedText.length > MAX_TEXT_LENGTH) {
                    extractedText = extractedText.substring(0, MAX_TEXT_LENGTH);
                    truncatedIndicator = "... (обрезано)"; // Это часть результата, уже на русском языке.
                    console.log(t('RW_TEXT_TRUNCATED_LOG', { componentName: 'ReadWebpageTool', maxLength: MAX_TEXT_LENGTH }));
                }

                const pageUrl = input.url;
                const contentForId = pageUrl + extractedText.substring(0, 500); // URL + part of content for ID
                const recordId = crypto.createHash('sha256').update(contentForId).digest('hex');

                const pageContentRecord = {
                    id: recordId,
                    url: pageUrl,
                    title: articleTitle, // Populated if Readability was successful and provided a title
                    textContent: extractedText + truncatedIndicator,
                    timestamp: new Date().toISOString(),
                    sourceTool: 'ReadWebpageTool',
                    _processingMethod: processingMethod
                };
                return { result: pageContentRecord, error: null };

            } else {
                // Этот случай в идеале должен быть обработан проверками на пустоту выше, но в качестве запасного варианта:
                // Возвращаемое сообщение о результате, уже на русском языке.
                return { result: "ReadWebpageTool: Не удалось извлечь текстовый контент.", error: null, _processingMethod: processingMethod || "N/A" };
            }

        } catch (error) { // Перехватывает ошибки от playwright.launch, newContext, newPage или общие ошибки, не обработанные внутренними обработчиками
            console.error(t('RW_PLAYWRIGHT_GENERAL_ERROR_LOG', { componentName: 'ReadWebpageTool', url: input.url }), error);
            // Возвращаемая ошибка, уже на русском языке.
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
