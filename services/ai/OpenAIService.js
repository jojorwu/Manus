// File: services/ai/OpenAIService.js
const BaseAIService = require('./BaseAIService');
const OpenAI = require('openai'); // Official OpenAI library

class OpenAIService extends BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig);
        this.defaultModel = baseConfig.defaultModel || 'gpt-3.5-turbo';
        this.openai = null; // Initialize to null

        if (!this.apiKey && !process.env.OPENAI_API_KEY) {
            console.warn("OpenAIService: API key is not provided at construction and OPENAI_API_KEY env var is not set. Service will likely fail on execution.");
        }

        // Attempt to initialize only if a key might be available (either direct or env)
        // The actual key retrieval and check is done in _getApiKey before each call.
        const potentialApiKey = this.apiKey || process.env.OPENAI_API_KEY;
        if (potentialApiKey) {
            try {
                this.openai = new OpenAI({ apiKey: potentialApiKey });
            } catch (error) {
                console.error(`OpenAIService: Failed to initialize OpenAI client during construction. Error: ${error.message}`);
                // this.openai remains null
            }
        } else {
            // No API key available at all, openai client cannot be initialized.
            // console.warn already issued.
        }
    }

    _getApiKey() {
        const key = this.apiKey || process.env.OPENAI_API_KEY;
        if (!key) {
            throw new Error("OpenAI API key is missing. Please provide it in the constructor or set OPENAI_API_KEY environment variable.");
        }
        return key;
    }

    // Helper to ensure openai client is initialized, attempting late initialization if possible.
    _ensureClient() {
        if (this.openai) {
            return true;
        }
        // Attempt to initialize if not done already (e.g. API key set via env var after construction)
        const potentialApiKey = this.apiKey || process.env.OPENAI_API_KEY;
        if (potentialApiKey && !this.openai) {
            try {
                console.log("OpenAIService: Attempting late initialization of OpenAI client.");
                this.openai = new OpenAI({ apiKey: potentialApiKey });
                return true;
            } catch (error) {
                console.error(`OpenAIService: Failed to initialize OpenAI client (late attempt). Error: ${error.message}`);
                this.openai = null; // Explicitly set to null on failure
            }
        }
        if (!this.openai) {
             throw new Error("OpenAIService: OpenAI client is not initialized. API key might be missing or initialization failed.");
        }
        return false; // Should not be reached if error is thrown
    }

    async completeChat(messages, params = {}) {
        this._ensureClient(); // Checks API key and initializes client if needed and possible

        const model = params.model || this.defaultModel;
        const temperature = params.temperature !== undefined ? params.temperature : (this.baseConfig.temperature !== undefined ? this.baseConfig.temperature : 0.7);
        const maxTokens = params.maxTokens || this.baseConfig.maxTokens || 2048; // Default for many chat models

        try {
            // Ensure messages is an array and has at least one message
            if (!Array.isArray(messages) || messages.length === 0) {
                throw new Error("Messages array cannot be empty and must be an array.");
            }
            // Ensure each message has 'role' and 'content'
            for (const msg of messages) {
                if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
                    throw new Error("Each message in the array must have a 'role' (string) and 'content' (string).");
                }
            }

            console.log(`OpenAIService: Calling ChatCompletion API. Model: ${model}, Messages Count: ${messages.length}, Temp: ${temperature}, MaxTokens: ${maxTokens}`);

            const requestPayload = {
                model: model,
                messages: messages,
                temperature: temperature,
                max_tokens: maxTokens,
            };
            if (params.topP !== undefined) requestPayload.top_p = params.topP;
            if (params.stopSequences !== undefined) requestPayload.stop = params.stopSequences;
            // Add other common parameters as needed based on params object

            const completion = await this.openai.chat.completions.create(requestPayload);

            if (completion.choices && completion.choices.length > 0) {
                const choice = completion.choices[0];
                if (choice.message && choice.message.content) {
                    console.log(`OpenAIService: ChatCompletion successful. Finish reason: ${choice.finish_reason}, Model used: ${completion.model}`);
                    return choice.message.content.trim();
                } else {
                    console.warn("OpenAIService API response format warning: No message content found in the first choice.", completion.choices[0]);
                    throw new Error("OpenAI API response format error: No message content found in the first choice.");
                }
            } else {
                console.warn("OpenAIService API response format warning: No choices returned.", completion);
                throw new Error("OpenAI API response format error: No choices returned.");
            }
        } catch (error) {
            let errorDetail = error.message;
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorDetail = error.response.data.error.message;
            } else if (error.error && error.error.message) { // Sometimes error structure is different
                errorDetail = error.error.message;
            }
            console.error(`OpenAIService: Error during OpenAI API call to model ${model}: ${errorDetail}`, error.stack);
            throw new Error(`OpenAI API Error: ${errorDetail}`);
        }
    }

    async generateText(prompt, params = {}) {
        // Ensure prompt is a string
        if (typeof prompt !== 'string') {
            throw new Error("Prompt must be a string for generateText.");
        }
        const messages = [{ role: 'user', content: prompt }];
        if (params.systemMessage && typeof params.systemMessage === 'string') {
            messages.unshift({ role: 'system', content: params.systemMessage });
        }
        // Remove systemMessage from params if it exists, so it's not passed to completeChat's generic params
        const chatParams = { ...params };
        delete chatParams.systemMessage;

        return this.completeChat(messages, chatParams);
    }
}

module.exports = OpenAIService;
