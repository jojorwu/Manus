// tools/WebSearchTool.js
const axios = require('axios');

class WebSearchTool {
    constructor(apiKeyConfig) {
        this.apiKey = apiKeyConfig.apiKey;
        this.cseId = apiKeyConfig.cseId;
        console.log("WebSearchTool: Инициализирован.");
    }

    async execute(input) {
        console.log('WebSearchTool: Поиск по запросу:', input.query);
        if (!this.apiKey || !this.cseId) {
            const errorMsg = "WebSearchTool не настроен с API ключом или CSE ID.";
            console.error(`WebSearchTool: ${errorMsg}`);
            return { result: null, error: errorMsg };
        }

        if (!input || typeof input.query !== 'string') {
            const errorMsg = "Неверный ввод для WebSearchTool: требуется строка 'query'.";
            console.error(`WebSearchTool: ${errorMsg}`);
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
                    const errorMsg = "WebSearchTool: Ответ API не содержит массив элементов.";
                    console.error(errorMsg, response.data.items);
                    return { result: null, error: errorMsg };
                }

                if (response.data.items.length === 0) {
                    console.log("WebSearchTool: Поиск не дал результатов.");
                    return { result: "Поиск не дал результатов.", error: null };
                }

                // Проверка структуры элементов
                for (const item of response.data.items) {
                    if (typeof item.title !== 'string' || typeof item.link !== 'string') {
                        const errorMsg = "WebSearchTool: Элемент результата поиска имеет неверную структуру.";
                        console.error(errorMsg, item);
                        return { result: null, error: errorMsg };
                    }
                }

                console.log(`WebSearchTool: Получено ${response.data.items.length} результатов.`);
                const formattedResults = response.data.items.map(item => ({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                }));
                return { result: formattedResults, error: null };
            } else {
                const errorMsg = "WebSearchTool: Ответ API не содержит ожидаемых данных (items).";
                console.error(errorMsg, response.data);
                return { result: "Ответ API не содержит ожидаемых данных.", error: errorMsg };
            }
        } catch (error) {
            console.error("WebSearchTool: Ошибка во время вызова API веб-поиска:", error);
            let errorMessage = "WebSearchTool: Ошибка запроса к API: " + error.message;
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorMessage = `WebSearchTool: Ошибка запроса к API: ${error.response.data.error.message}`;
            }
            console.error(`WebSearchTool: ${errorMessage}`);
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = WebSearchTool;
