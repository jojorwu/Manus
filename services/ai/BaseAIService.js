// File: services/ai/BaseAIService.js

class BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        this.apiKey = apiKey;
        this.baseConfig = baseConfig;
        // console.log("BaseAIService: Initialized."); // Example of a log, would be localized if part of the system
    }

    // Abstract methods that subclasses should implement
    async completeChat(messages, params = {}) {
        throw new Error("Method 'completeChat()' must be implemented by subclasses.");
    }

    async generateText(prompt, params = {}) {
        throw new Error("Method 'generateText()' must be implemented by subclasses.");
    }

    getServiceName() {
        return this.constructor.name;
    }

    // Utility methods, if any, could be added here
}

module.exports = BaseAIService;
