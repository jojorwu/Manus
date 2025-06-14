// tools/WebSearchTool.js
const axios = require('axios');
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
            const errorMsg = "WebSearchTool не настроен с API ключом или CSE ID."; // This is a returned error, already Russian.
            console.error(t('WS_NOT_CONFIGURED_LOG', { componentName: 'WebSearchTool', message: errorMsg }));
            return { result: null, error: errorMsg };
        }

        if (!input || typeof input.query !== 'string') {
            const errorMsg = "Неверный ввод для WebSearchTool: требуется строка 'query'."; // Returned error, already Russian.
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
                    const errorMsg = "WebSearchTool: Ответ API не содержит массив элементов."; // Returned error, Russian.
                    console.error(t('WS_API_NO_ARRAY_LOG', { componentName: 'WebSearchTool', message: errorMsg, itemsData: JSON.stringify(response.data.items) }));
                    return { result: null, error: errorMsg };
                }

                if (response.data.items.length === 0) {
                    console.log(t('WS_NO_RESULTS_FOUND_LOG', { componentName: 'WebSearchTool' }));
                    return { result: "Поиск не дал результатов.", error: null }; // Returned result, Russian.
                }

                // Проверка структуры элементов
                for (const item of response.data.items) {
                    if (typeof item.title !== 'string' || typeof item.link !== 'string') {
                        const errorMsg = "WebSearchTool: Элемент результата поиска имеет неверную структуру."; // Returned error, Russian.
                        console.error(t('WS_INVALID_ITEM_STRUCTURE_LOG', { componentName: 'WebSearchTool', message: errorMsg, itemData: JSON.stringify(item) }));
                        return { result: null, error: errorMsg };
                    }
                }

                console.log(t('WS_RESULTS_COUNT_LOG', { componentName: 'WebSearchTool', count: response.data.items.length }));
                const formattedResults = response.data.items.map(item => ({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                }));
                return { result: formattedResults, error: null };
            } else {
                const errorMsg = "WebSearchTool: Ответ API не содержит ожидаемых данных (items)."; // Returned error, Russian.
                console.error(t('WS_API_NO_ITEMS_LOG', { componentName: 'WebSearchTool', message: errorMsg, responseData: JSON.stringify(response.data) }));
                return { result: null, error: errorMsg };
            }
        } catch (error) {
            console.error(t('WS_API_CALL_ERROR_LOG', { componentName: 'WebSearchTool' }), error);
            let errorMessage = "WebSearchTool: Ошибка запроса к API: " + error.message; // Base part of returned error, Russian.
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorMessage = `WebSearchTool: Ошибка запроса к API: ${error.response.data.error.message}`; // More specific returned error, Russian.
            }
            // The console.error below logs the 'errorMessage' which is already Russian and intended for return.
            // It's better to log the generic error key and let the returned message be specific.
            console.error(t('WS_API_REQUEST_ERROR_LOG', { componentName: 'WebSearchTool', message: errorMessage }));
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = WebSearchTool;
