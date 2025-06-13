// services/LLMService.js

// require('dotenv').config(); // Decided that dotenv is configured in index.js

// Recommendations for Integrating a Real LLM SDK (e.g., Google Gemini):
//
// 1. Prompt Engineering for Brevity and Efficiency:
//    - Craft concise and clear prompts. Avoid unnecessary verbosity.
//    - Be selective about the data and history sent to the LLM. Do not include excessively large
//      chunks of text or entire conversation histories if only a summary or recent turns are needed.
//    - Consider summarizing previous context (e.g., using another LLM call or a local summarization)
//      before including it in new prompts, especially in long-running interactions. This helps manage
//      token limits and can reduce costs.
//
// 2. Handling Large Responses (Output from LLM):
//    - Streaming: If the LLM API supports streaming responses (e.g., Server-Sent Events - SSE),
//      use this feature for generating long pieces of text. Streaming allows you to process data
//      chunk by chunk as it arrives, significantly reducing the memory required to hold the
//      entire response. This is crucial for applications like chatbots or content generation tools.
//    - Non-Streaming: If streaming is not used or unavailable, be aware that the full response
//      from the LLM will be loaded into memory. For very large generations, this could lead to
//      high memory consumption. Monitor and potentially set limits or use chunking if applicable.
//
// 3. Input/Output Token Monitoring:
//    - Most LLM SDKs provide information about the number of input and output tokens used per API call.
//    - Actively monitor these token counts. This is vital for:
//        a) Cost Management: LLM usage is often billed per token.
//        b) Context Window Limits: Models have maximum context window sizes (input + output tokens).
//           Exceeding these limits will result in errors. Careful prompt engineering and context
//           management (see point 1) are key to staying within these limits.
//
// 4. Robust Error Handling and Retries:
//    - Implement comprehensive error handling for API calls.
//    - Include retry mechanisms with exponential backoff and jitter for transient network issues
//      or temporary API rate limits. This is especially important when dealing with potentially
//      large data transfers (prompts or responses) that might be more susceptible to interruptions.
//    - Handle specific API error codes gracefully.
//
// 5. Configuration and API Keys:
//    - API Key Management: Ensure API keys (like GEMINI_API_KEY) are managed securely.
//      Using environment variables (as done with `process.env.GEMINI_API_KEY`) is a good practice.
//      Avoid hardcoding keys in the source code.
//    - Configurable Parameters: Consider making LLM parameters (e.g., model name, temperature, topP,
//      maxOutputTokens) configurable, perhaps through environment variables or a configuration file,
//      to allow for easier adjustments without code changes.

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
