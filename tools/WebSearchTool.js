// tools/WebSearchTool.js - Инструмент веб-поиска
const axios = require('axios');
const crypto = require('crypto');
const { t } = require('../utils/localization');

class WebSearchTool {
    constructor(apiKeyConfig) {
        this.apiKey = apiKeyConfig.apiKey;
        this.cseId = apiKeyConfig.cseId;
        console.log(t('INIT_DONE', { componentName: 'WebSearchTool' }));
    }

    async execute(input) {
        console.log(t('WS_SEARCHING', { componentName: 'WebSearchTool', query: input.query }));
        if (!this.apiKey || !this.cseId) {
            const errorMsg = "WebSearchTool не настроен с API ключом или CSE ID."; // Это возвращаемая ошибка, уже на русском языке.
            console.error(t('WS_NOT_CONFIGURED_LOG', { componentName: 'WebSearchTool', message: errorMsg }));
            return { result: null, error: errorMsg };
        }

        if (!input || typeof input.query !== 'string') {
            const errorMsg = "Неверный ввод для WebSearchTool: требуется строка 'query'."; // Возвращаемая ошибка, уже на русском языке.
            console.error(t('WS_INVALID_INPUT_LOG', { componentName: 'WebSearchTool', message: errorMsg }));
            return { result: null, error: errorMsg };
        }

        const apiUrl = "https://www.googleapis.com/customsearch/v1";
        const queryParams = {
            key: this.apiKey,
            cx: this.cseId,
            q: input.query,
        };

        try {
            const response = await axios.get(apiUrl, { params: queryParams });

            if (response.data && response.data.items) {
                if (!Array.isArray(response.data.items)) {
                    const errorMsg = "WebSearchTool: Ответ API не содержит массив элементов."; // Возвращаемая ошибка, на русском языке.
                    console.error(t('WS_API_NO_ARRAY_LOG', { componentName: 'WebSearchTool', message: errorMsg, itemsData: JSON.stringify(response.data.items) }));
                    return { result: null, error: errorMsg };
                }

                if (response.data.items.length === 0) {
                    console.log(t('WS_NO_RESULTS_FOUND_LOG', { componentName: 'WebSearchTool' }));
                    return { result: "Поиск не дал результатов.", error: null }; // Возвращаемый результат, на русском языке.
                }

                // Проверка структуры элементов
                for (const item of response.data.items) {
                    if (typeof item.title !== 'string' || typeof item.link !== 'string') {
                        const errorMsg = "WebSearchTool: Элемент результата поиска имеет неверную структуру."; // Возвращаемая ошибка, на русском языке.
                        console.error(t('WS_INVALID_ITEM_STRUCTURE_LOG', { componentName: 'WebSearchTool', message: errorMsg, itemData: JSON.stringify(item) }));
                        return { result: null, error: errorMsg };
                    }
                }

                console.log(t('WS_RESULTS_COUNT_LOG', { componentName: 'WebSearchTool', count: response.data.items.length }));
                const listOfSearchResultRecords = response.data.items.map(item => {
                    const idContent = item.link + (item.snippet || ''); // Ensure snippet is not undefined for hash
                    const recordId = crypto.createHash('sha256').update(idContent).digest('hex');
                    return {
                        id: recordId,
                        query: input.query,
                        url: item.link,
                        title: item.title,
                        snippet: item.snippet || null, // Ensure snippet is null if not present
                        timestamp: new Date().toISOString(),
                        sourceTool: 'WebSearchTool'
                    };
                });
                return { result: listOfSearchResultRecords, error: null };
            } else {
                const errorMsg = "WebSearchTool: Ответ API не содержит ожидаемых данных (items)."; // Возвращаемая ошибка, на русском языке.
                console.error(t('WS_API_NO_ITEMS_LOG', { componentName: 'WebSearchTool', message: errorMsg, responseData: JSON.stringify(response.data) }));
                return { result: null, error: errorMsg };
            }
        } catch (error) {
            console.error(t('WS_API_CALL_ERROR_LOG', { componentName: 'WebSearchTool' }), error);
            let errorMessage = "WebSearchTool: Ошибка запроса к API: " + error.message; // Базовая часть возвращаемой ошибки, на русском языке.
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorMessage = `WebSearchTool: Ошибка запроса к API: ${error.response.data.error.message}`; // Более конкретная возвращаемая ошибка, на русском языке.
            }
            // Приведенный ниже console.error логирует 'errorMessage', который уже на русском и предназначен для возврата.
            // Лучше логировать общий ключ ошибки и позволить возвращаемому сообщению быть специфичным.
            console.error(t('WS_API_REQUEST_ERROR_LOG', { componentName: 'WebSearchTool', message: errorMessage }));
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = WebSearchTool;
