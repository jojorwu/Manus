// Файл: tools/Context7DocumentationTool.js
const { t } = require('../utils/localization'); // Для будущей локализации логов
const Context7Client = require('../services/Context7Client'); // Скорректируйте путь, если Context7Client находится в другом месте

class Context7DocumentationTool {
    constructor(context7ClientInstance) {
        if (!context7ClientInstance || typeof context7ClientInstance.resolveLibraryId !== 'function' || typeof context7ClientInstance.getLibraryDocs !== 'function') {
            console.error(t('C7TOOL_ERROR_INVALID_CLIENT')); // Или пока более прямое сообщение об ошибке
            throw new Error("Context7DocumentationTool: Предоставлен недействительный экземпляр Context7Client.");
        }
        this.client = context7ClientInstance;
        console.log(t('C7TOOL_INIT_DONE', { serviceName: 'Context7DocumentationTool' }));
    }

    /**
     * Получает документацию для указанного имени библиотеки, опционально сфокусированную на теме.
     * Этот метод инкапсулирует двухэтапный процесс: определение ID библиотеки и затем получение документации.
     * @param {object} input - Входной объект.
     * @param {string} input.libraryName - Общепринятое имя библиотеки (например, "React", "Next.js").
     * @param {string} [input.topic] - Необязательная тема для фокусировки документации (например, "hooks", "routing").
     * @param {number} [input.maxTokens=5000] - Необязательное максимальное количество токенов для документации.
     * @returns {Promise<{result: string, error?: string}>} Объект, содержащий текст документации или сообщение об ошибке.
     */
    async execute(input) {
        const { libraryName, topic = null, maxTokens = 5000 } = input;

        if (!libraryName || typeof libraryName !== 'string' || libraryName.trim() === '') {
            console.warn(t('C7TOOL_WARN_INVALID_LIB_NAME'));
            return { result: null, error: "Неверный ввод: 'libraryName' должен быть непустой строкой." };
        }

        console.log(t('C7TOOL_LOG_FETCHING_DOCS', { libraryName, topic }));
        try {
            // Шаг 1: Определение ID библиотеки
            console.log(t('C7TOOL_LOG_RESOLVING_ID', { libraryName }));
            const libraryId = await this.client.resolveLibraryId(libraryName);

            if (!libraryId || libraryId.trim() === '') {
                console.warn(t('C7TOOL_WARN_ID_NOT_RESOLVED', { libraryName }));
                return { result: null, error: `Не удалось определить ID для библиотеки "${libraryName}". Возможно, Context7 не поддерживает эту библиотеку.` };
            }
            console.log(t('C7TOOL_LOG_ID_RESOLVED', { libraryName, libraryId }));

            // Шаг 2: Получение документации по библиотеке
            console.log(t('C7TOOL_LOG_GETTING_DOCS', { libraryId, topic }));
            const documentation = await this.client.getLibraryDocs(libraryId, topic, maxTokens);

            if (documentation === null || documentation.trim() === '') {
                console.log(t('C7TOOL_LOG_DOCS_EMPTY', { libraryId, topic }));
                 return { result: `Для ID библиотеки "${libraryId}" (тема: ${topic || 'общая'}) не найдено конкретной документации.`, error: null };
            }

            console.log(t('C7TOOL_LOG_DOCS_RECEIVED', { libraryId, topic, length: documentation.length }));
            return { result: documentation, error: null };

        } catch (error) {
            console.error(t('C7TOOL_ERROR_FETCH_FAILED', { libraryName, errorMessage: error.message }), error);
            if (error.message && error.message.startsWith('Context7Client') || error.message.startsWith('Context7 RPC Error')) {
                 return { result: null, error: error.message }; // Assuming these are already localized or specific enough
            }
            return { result: null, error: `Ошибка получения документации для "${libraryName}": ${error.message}` };
        }
    }
}

module.exports = Context7DocumentationTool;
