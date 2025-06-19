// File: services/ai/BaseAIService.js

class BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        this.apiKey = apiKey;
        this.baseConfig = baseConfig;
        // console.log("BaseAIService: Initialized."); // Example of a log, would be localized if part of the system
    }

    // Abstract methods that subclasses should implement
    async completeChat(_messages, _params = {}) {
        throw new Error("Method 'completeChat()' must be implemented by subclasses.");
    }

    async generateText(_prompt, _params = {}) {
        throw new Error("Method 'generateText()' must be implemented by subclasses.");
    }

    getServiceName() {
        return this.constructor.name;
    }

    /**
     * Returns a tokenizer function suitable for approximating token counts for this service.
     * This base implementation provides a very rough character-based approximation.
     * Subclasses should override this with more accurate, model-specific tokenizers if available.
     * @returns {Function} A function that takes a string and returns an estimated number of tokens.
     */
    getTokenizer(modelName = null) {
        throw new Error("Method 'getTokenizer(modelName = null)' must be implemented by subclasses.");
    }

    /**
     * Returns the maximum number of context tokens supported by the default model for this service.
     * This base implementation relies on `this.baseConfig.modelMaxTokens` (a map of model names to token limits)
     * and `this.baseConfig.defaultModel`, or falls back to a general default.
     * Subclasses should override this to provide more accurate limits based on their specific models.
     * @returns {number} The maximum number of context tokens.
     */
    getMaxContextTokens() {
        throw new Error("Method 'getMaxContextTokens()' must be implemented by subclasses.");
    }

    // Utility methods, if any, could be added here

    async _executeRequestWithRetry(requestFn, maxRetries = 3, initialDelayMs = 1000, serviceName = 'AIService') {
        let attempts = 0;
        let currentDelayMs = initialDelayMs;
        while (attempts < maxRetries) {
            try {
                return await requestFn();
            } catch (error) {
                attempts++;
                const statusCode = error.status || error.response?.status; // OpenAI SDK uses error.status, axios uses error.response.status
                const retryableStatusCodes = [429, 500, 502, 503, 504];

                // Логируем ошибку более подробно
                const errorMessage = error.message || 'Unknown error';
                let errorDetailsToLog = `Error during ${serviceName} API call (Attempt ${attempts}/${maxRetries}): Status ${statusCode || 'N/A'}, Message: ${errorMessage}`;
                if (error.response?.data) { // Axios-like error structure
                    errorDetailsToLog += `, Data: ${JSON.stringify(error.response.data)}`;
                } else if (error.error) { // OpenAI SDK error structure
                     errorDetailsToLog += `, Details: ${JSON.stringify(error.error)}`;
                }
                console.error(errorDetailsToLog);


                if (retryableStatusCodes.includes(statusCode) && attempts < maxRetries) {
                    console.log(`${serviceName}: Retrying in ${currentDelayMs}ms... (Attempt ${attempts}/${maxRetries}) for status ${statusCode}`);
                    await new Promise(resolve => setTimeout(resolve, currentDelayMs));
                    currentDelayMs *= 2; // Exponential backoff
                } else {
                    // If not a retryable status code or max retries reached, re-throw the last error
                    // Enrich the error slightly if possible, or rethrow as is
                    error.message = `Failed ${serviceName} API call after ${attempts} attempts: ${errorMessage}`;
                    if (statusCode) error.finalStatusCode = statusCode; // Add final status code to the error object
                    throw error;
                }
            }
        }
    }
}

module.exports = BaseAIService;
