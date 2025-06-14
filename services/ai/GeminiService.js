// File: services/ai/GeminiService.js
const BaseAIService = require('./BaseAIService');

class GeminiService extends BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig);
        this.defaultModel = baseConfig.defaultModel || 'gemini-pro'; // Example default
        if (!this.apiKey && !process.env.GEMINI_API_KEY) {
            console.warn("GeminiService: API key is not provided and GEMINI_API_KEY env var is not set. Service will use stubbed responses.");
        }
    }

    _getApiKey() {
        // In a real scenario, this would throw an error if the key is truly needed and missing.
        // For now, aligns with stub behavior.
        const key = this.apiKey || process.env.GEMINI_API_KEY;
        if (!key) {
            // console.warn("GeminiService: API key for Gemini is missing. Using stubbed behavior.");
        }
        return key;
    }

    async generateText(prompt, params = {}) {
        const apiKey = this._getApiKey();
        const model = params.model || this.defaultModel;
        // const temperature = params.temperature !== undefined ? params.temperature : 0.7;
        // const maxTokens = params.maxTokens || 1000;

        console.log(`GeminiService (${model}): Called generateText with prompt (first 100 chars): "${prompt.substring(0,100)}..."`);

        if (!apiKey) { // If no API key, return stubbed response
            const errorMsg = "GeminiService: GEMINI_API_KEY is not set. LLM service cannot operate with actual API, returning stub.";
            console.warn(errorMsg);
             // Mimic current stub from services/LLMService.js
            if (prompt.includes("create a sequential plan") || prompt.includes("generate a revised plan")) {
                return "[]";
            }
            return "GeminiService LLM synthesized answer (stub due to missing API key).";
        }

        // TODO: Replace with actual Gemini API call using the official Google AI SDK
        // For now, returning the same stub as the original LLMService.js for compatibility
        console.warn(`GeminiService (${model}): Actual API call to Gemini not implemented. Returning stub response.`);
        if (prompt.includes("create a sequential plan") || prompt.includes("generate a revised plan")) {
             return "[]"; // Пустой план, чтобы не было ошибок парсинга у OrchestratorAgent
        }
        return `GeminiService LLM synthesized answer (stub for model ${model}).`;
    }

    async completeChat(messages, params = {}) {
        // Gemini also supports chat-like interactions. This could be implemented.
        // For now, we can make it call generateText with a formatted prompt.
        const apiKey = this._getApiKey();
        const model = params.model || this.defaultModel;
        console.log(`GeminiService (${model}): Called completeChat with ${messages.length} messages.`);

        if (!apiKey) {
             console.warn("GeminiService: API key for Gemini is missing. Using stubbed behavior for completeChat.");
             return "GeminiService LLM chat response (stub due to missing API key).";
        }

        // Simple conversion of messages to a single prompt string for the stub.
        // A real implementation would use the Gemini SDK's chat/multi-turn conversation methods.
        let combinedPrompt = "";
        messages.forEach(msg => {
            combinedPrompt += `${msg.role}: ${msg.content}\n`;
        });
        console.warn(`GeminiService (${model}): Actual chat API call to Gemini not implemented. Simulating with generateText using combined prompt. Returning stub response.`);
        return this.generateText(combinedPrompt.trim(), params);
    }
}

module.exports = GeminiService;
