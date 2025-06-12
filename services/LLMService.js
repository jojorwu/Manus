// services/LLMService.js

// require('dotenv').config(); // Решено, что dotenv конфигурируется в index.js

const geminiLLMService = async (prompt) => {
    console.log(`LLM Service called with prompt (first 100 chars): "${prompt.substring(0,100)}..."`);
    // Здесь должна быть реальная интеграция с @google/generative-ai
    // GEMINI_API_KEY должен быть доступен из process.env
    if (!process.env.GEMINI_API_KEY) {
        const errorMsg = "GEMINI_API_KEY is not set in .env file. LLM service cannot operate.";
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
    // Это очень упрощенная заглушка. Реальный ответ должен быть JSON планом или синтезированным текстом.
    // Для планирования ожидается JSON массив. Для синтеза - строка.
    // Сейчас вернем пустой массив для планирования, чтобы избежать ошибок парсинга JSON.
    // И простую строку для синтеза.
    if (prompt.includes("create a sequential plan")) {
         return "[]"; // Пустой план, чтобы не было ошибок парсинга у OrchestratorAgent
    }
    return "LLM synthesized answer (stub).";
};

module.exports = geminiLLMService;
