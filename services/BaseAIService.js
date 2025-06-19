// services/BaseAIService.js

/**
 * @abstract
 * Base class for AI services, defining a common interface.
 * Concrete AI service implementations (e.g., OpenAIService, GeminiService) should extend this class.
 */
class BaseAIService {
    /**
     * Constructor for BaseAIService.
     * @param {string} apiKey - The API key for the AI service.
     * @param {object} baseConfig - Base configuration for the service.
     * @param {string} [baseConfig.defaultModel] - Default model to use for general tasks.
     * @param {string} [baseConfig.planningModel] - Model to use for planning.
     * @param {string} [baseConfig.cwcUpdateModel] - Model to use for Current Working Context updates.
     * @param {string} [baseConfig.synthesisModel] - Model to use for final answer synthesis.
     * @param {string} [baseConfig.summarizationModel] - Model to use for summarization tasks.
     * @param {string} [baseConfig.defaultLLMStepModel] - Default model for LLM steps in PlanExecutor.
     */
    constructor(apiKey, baseConfig = {}) {
        if (this.constructor === BaseAIService) {
            throw new Error("Abstract class 'BaseAIService' cannot be instantiated directly.");
        }
        this.apiKey = apiKey;
        this.baseConfig = baseConfig;
    }

    /**
     * Generates text from a string prompt.
     * @param {string} promptString - The input prompt string.
     * @param {object} params - Parameters for text generation (e.g., temperature, maxTokens, model, cacheHandle).
     * @returns {Promise<string>} The generated text.
     * @throws {Error} If not implemented.
     */
    async generateText(_promptString, _params) {
        throw new Error("Method 'generateText(promptString, params)' must be implemented.");
    }

    /**
     * Generates a chat completion based on a sequence of messages.
     * @param {Array<object>} messagesArray - An array of message objects (e.g., [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]).
     * @param {object} params - Parameters for chat completion (e.g., temperature, maxTokens, model, cacheHandle).
     * @returns {Promise<string>} The assistant's reply content.
     * @throws {Error} If not implemented.
     */
    async completeChat(_messagesArray, _params) {
        throw new Error("Method 'completeChat(messagesArray, params)' must be implemented.");
    }

    /**
     * Gets the tokenizer used by the AI service.
     * The tokenizer should be a function that accepts a string and returns the number of tokens.
     * @returns {function(string): number} Tokenizer function.
     * @throws {Error} If not implemented.
     */
    getTokenizer() {
        throw new Error("Method 'getTokenizer()' must be implemented.");
    }

    /**
     * Gets the maximum number of context tokens allowed by the primary model(s) of this service.
     * @returns {number} Maximum context tokens.
     * @throws {Error} If not implemented.
     */
    getMaxContextTokens() {
        throw new Error("Method 'getMaxContextTokens()' must be implemented.");
    }

    /**
     * Gets the name of the AI service.
     * @returns {string} The name of the service (e.g., "OpenAI", "Gemini").
     * @throws {Error} If not implemented.
     */
    getServiceName() {
        throw new Error("Method 'getServiceName()' must be implemented.");
    }

    /**
     * Prepares context for model consumption, potentially using model-specific features like caching.
     * This method is intended to encapsulate logic like Gemini's Content Caching.
     * The result of this method can be passed as a 'cacheHandle' or similar parameter to
     * `generateText` or `completeChat` if the underlying service supports it.
     *
     * @param {string | Array<object>} contextParts - The content to be prepared or cached.
     *   For Gemini, this would typically be an array of 'parts' or a string for a 'text' part,
     *   intended for `contents` in `createCachedContent`.
     * @param {object} options - Options for context preparation.
     * @param {string} options.modelName - The target model for which this context is being prepared.
     * @param {object} [options.systemInstruction] - System instruction object for services that support it with cached content.
     * @param {object} [options.cacheConfig] - Configuration for caching.
     * @param {string} [options.cacheConfig.taskId] - Optional ID for namespacing or display naming.
     * @param {number} [options.cacheConfig.ttlSeconds] - Time-to-live for the cache entry.
     * @param {string} [options.cacheConfig.displayName] - A display name for the cache entry.
     * @param {boolean} [options.cacheConfig.forceRecreate] - If true, ignore existing cache and recreate.
     * @returns {Promise<object | null>} An object containing a handle to the prepared context (e.g., { cacheName: '...' })
     *                                   or null if no special handle is generated or caching is not applicable/failed.
     * @throws {Error} If not implemented or if preparation fails.
     */
    async prepareContextForModel(_contextParts, _options) {
        throw new Error("Method 'prepareContextForModel(contextParts, options)' must be implemented.");
    }
}

// export default BaseAIService;
module.exports = BaseAIService; // Uncomment if using CommonJS modules elsewhere for this base class
