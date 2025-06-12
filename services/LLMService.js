// services/LLMService.js

// services/LLMService.js
const logger = require('../core/logger'); // Import the logger

// require('dotenv').config(); // Decided that dotenv is configured in index.js

const geminiLLMService = async (prompt) => {
    logger.info(`LLM Service called.`, { promptSnippet: prompt.substring(0,100)+'...' });
    logger.debug("Full prompt to LLM Service:", { prompt });

    // Real integration with @google/generative-ai should be here
    // GEMINI_API_KEY should be available from process.env
    if (!process.env.GEMINI_API_KEY) {
        const errorMsg = "GEMINI_API_KEY is not set in .env file. LLM service cannot operate.";
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    // This is a very simplified stub. The actual response should be a JSON plan or synthesized text.
    // Для планирования ожидается JSON массив. Для синтеза - строка.
    // Сейчас вернем пустой массив для планирования, чтобы избежать ошибок парсинга JSON.
    // И простую строку для синтеза.
    if (prompt.includes("create a sequential plan")) {
         return "[]"; // Пустой план, чтобы не было ошибок парсинга у OrchestratorAgent
    }
    return "LLM synthesized answer (stub).";
};

module.exports = geminiLLMService;
