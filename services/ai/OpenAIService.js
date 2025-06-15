// File: services/ai/OpenAIService.js
const BaseAIService = require('./BaseAIService');
const OpenAI = require('openai'); // Official OpenAI library
let get_encoding_lib; // To handle potential dynamic import
try {
    get_encoding_lib = require('tiktoken');
} catch (e) {
    console.warn("OpenAIService: tiktoken library not found or failed to load. `getTokenizer` will fall back to base. Error: " + e.message);
    get_encoding_lib = null;
}


class OpenAIService extends BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig);
        this.defaultModel = baseConfig.defaultModel || 'gpt-3.5-turbo';
        this.openai = null; // Initialize to null
        this.tokenizerName = this.baseConfig.tokenizerName || 'cl100k_base';
        this.enc = null;

        if (get_encoding_lib) {
            try {
                this.enc = get_encoding_lib.get_encoding(this.tokenizerName);
            } catch (e) {
                console.warn(`OpenAIService: Failed to load tiktoken encoder '${this.tokenizerName}'. Falling back to base tokenizer. Error: ${e.message}`);
                this.enc = null;
            }
        }

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

    /**
     * Returns a tokenizer function for OpenAI models using the `tiktoken` library.
     * If `tiktoken` is unavailable or the specified encoder fails to load,
     * it falls back to the base class's approximate tokenizer.
     * @returns {Function} A function that takes a string and returns the number of tokens.
     */
    getTokenizer() {
        if (this.enc) {
            return (text) => text ? this.enc.encode(text).length : 0;
        }
        // Fallback to BaseAIService's placeholder if tiktoken loading failed
        console.warn("OpenAIService.getTokenizer: tiktoken encoder not available, falling back to base approximate tokenizer.");
        return super.getTokenizer();
    }

    /**
     * Returns the maximum number of context tokens for the configured default OpenAI model.
     * It uses a predefined map of known OpenAI models and their context window sizes.
     * @returns {number} The maximum number of context tokens.
     */
    getMaxContextTokens() {
        const model = this.defaultModel || (this.baseConfig && this.baseConfig.defaultModel) || 'gpt-3.5-turbo';
        // Source: https://platform.openai.com/docs/models
        // Refreshed April 2024
        const modelContextWindows = {
            // GPT-4 Turbo (includes vision) - all these point to models with 128k context
            'gpt-4-turbo': 128000,
            'gpt-4-turbo-2024-04-09': 128000,
            'gpt-4-turbo-preview': 128000,
            'gpt-4-0125-preview': 128000,
            'gpt-4-1106-preview': 128000,
            'gpt-4-vision-preview': 128000, // Vision model, but context window is for tokens

            // GPT-4
            'gpt-4': 8192,
            'gpt-4-0613': 8192,
            'gpt-4-32k': 32768,
            'gpt-4-32k-0613': 32768,

            // GPT-3.5 Turbo
            'gpt-3.5-turbo-0125': 16385,
            'gpt-3.5-turbo': 16385, // Default alias often points to 16k model
            'gpt-3.5-turbo-1106': 16385, // Also 16k
            'gpt-3.5-turbo-instruct': 4096,
            'gpt-3.5-turbo-16k': 16385, // Explicit 16k model
            'gpt-3.5-turbo-0613': 4096, // Older 4k model

            // Default if model not listed
            'default': 4096
        };

        const contextSize = modelContextWindows[model] || modelContextWindows['default'];
        if (!modelContextWindows[model]) {
            console.warn(`OpenAIService.getMaxContextTokens: Model ${model} not found in known list. Using default ${contextSize} tokens.`);
        }
        return contextSize;
    }

    // Optional: cleanup encoder when no longer needed
    // close() { if (this.enc) this.enc.free(); } // Tiktoken docs say free is not usually needed in JS
}

module.exports = OpenAIService;
