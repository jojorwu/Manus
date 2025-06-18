// File: services/ai/OpenAIService.js
const BaseAIService = require('../BaseAIService.js'); // Corrected path
const OpenAI = require('openai'); // Official OpenAI library
const { get_encoding, encoding_for_model: encodingForModel } = require('tiktoken'); // Specific import for get_encoding

class OpenAIService extends BaseAIService {
    /**
     * Constructor for OpenAIService.
     * @param {string} apiKey - The API key for OpenAI.
     * @param {object} baseConfig - Base configuration options.
     * @param {string} [baseConfig.defaultModel='gpt-3.5-turbo'] - Default model to use.
     * @param {string} [baseConfig.tokenizerName='cl100k_base'] - Default tokenizer encoding name.
     * @param {number} [baseConfig.temperature=0.7] - Default temperature.
     * @param {number} [baseConfig.maxTokens=2048] - Default max output tokens.
     */
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig); // Sets this.apiKey and this.baseConfig
        this.openai = null; // Initialized in _ensureClient
        this.tokenizerName = this.baseConfig.tokenizerName || 'cl100k_base';
        this.enc = null;

        try {
            // Try to get encoding by model name first if a defaultModel is specified
            if (this.baseConfig.defaultModel) {
                 this.enc = encodingForModel(this.baseConfig.defaultModel);
            } else {
                this.enc = get_encoding(this.tokenizerName);
            }
        } catch (e) {
            console.warn(`OpenAIService: Failed to load tiktoken encoder '${this.baseConfig.defaultModel || this.tokenizerName}'. Attempting fallback to '${this.tokenizerName}'. Error: ${e.message}`);
            try {
                this.enc = get_encoding(this.tokenizerName);
            } catch (e2) {
                 console.warn(`OpenAIService: Fallback tiktoken encoder '${this.tokenizerName}' also failed. Tokenizer will not be available. Error: ${e2.message}`);
            }
        }

        if (!this._getApiKey()) {
            console.warn("OpenAIService: API key is not provided directly or via OPENAI_API_KEY env var. Service will fail on execution unless key is available then.");
        }
    }

    _getApiKey() {
        return this.apiKey || process.env.OPENAI_API_KEY;
    }

    _ensureClient() {
        if (this.openai) {
            return true;
        }
        const apiKey = this._getApiKey();
        if (!apiKey) {
             throw new Error("OpenAIService: API key is missing. Cannot initialize client.");
        }
        try {
            // console.log("OpenAIService: Initializing OpenAI client.");
            this.openai = new OpenAI({ apiKey });
            return true;
        } catch (error) {
            console.error(`OpenAIService: Failed to initialize OpenAI client. Error: ${error.message}`);
            this.openai = null;
            throw new Error(`OpenAIService client initialization failed: ${error.message}`);
        }
    }

    /**
     * @override
     */
    async generateText(promptString, params = {}) {
        this._ensureClient();
        if (typeof promptString !== 'string') {
            throw new Error("OpenAIService.generateText: promptString must be a string.");
        }

        const messages = [];
        if (params.systemMessage && typeof params.systemMessage === 'string') {
            messages.push({ role: 'system', content: params.systemMessage });
        }
        messages.push({ role: 'user', content: promptString });

        // Remove systemMessage from params to avoid conflict if it's not an official OpenAI param for chat.completions
        const chatParams = { ...params };
        delete chatParams.systemMessage;

        return this.completeChat(messages, chatParams);
    }

    /**
     * @override
     */
    async completeChat(messagesArray, params = {}) {
        this._ensureClient();

        const model = params.model || this.baseConfig.defaultModel || 'gpt-3.5-turbo';
        const temperature = params.temperature !== undefined ? params.temperature : this.baseConfig.temperature;
        const maxTokens = params.max_tokens || params.maxTokens || this.baseConfig.maxTokens; // OpenAI uses max_tokens
        const topP = params.top_p || params.topP || this.baseConfig.topP;
        const stopSequences = params.stop || params.stopSequences || this.baseConfig.stopSequences;

        if (!Array.isArray(messagesArray) || messagesArray.length === 0) {
            throw new Error("OpenAIService.completeChat: messagesArray cannot be empty.");
        }
        messagesArray.forEach(msg => {
            if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
                throw new Error("OpenAIService.completeChat: Each message must have 'role' and 'content' strings.");
            }
        });

        // console.log(\`OpenAIService: Calling ChatCompletion API. Model: \${model}, Messages: \${messagesArray.length}\`);
        try {
            const requestPayload = {
                model: model,
                messages: messagesArray,
            };
            if (temperature !== undefined) requestPayload.temperature = temperature;
            if (maxTokens !== undefined) requestPayload.max_tokens = maxTokens;
            if (topP !== undefined) requestPayload.top_p = topP;
            if (stopSequences !== undefined) requestPayload.stop = stopSequences;
            // Add other OpenAI specific parameters from params if needed

            const completion = await this.openai.chat.completions.create(requestPayload);

            if (completion.choices && completion.choices.length > 0) {
                const choice = completion.choices[0];
                if (choice.message && choice.message.content) {
                    return choice.message.content.trim();
                }
            }
            console.warn("OpenAIService API response warning: No content found or unexpected format.", completion);
            throw new Error("OpenAI API response error: No message content found.");
        } catch (error) {
            const errorDetail = error.response?.data?.error?.message || error.error?.message || error.message;
            console.error(`OpenAIService: Error during chat completion for model ${model}:`, errorDetail, error.stack);
            throw new Error(`OpenAI API Error: ${errorDetail}`);
        }
    }

    /**
     * @override
     */
    getTokenizer() {
        if (this.enc) {
            return (text) => text ? this.enc.encode(text).length : 0;
        }
        console.warn("OpenAIService.getTokenizer: tiktoken encoder not available. Falling back to basic word count.");
        return (text) => text ? text.split(/\\s+/).length : 0; // Basic fallback
    }

    /**
     * @override
     */
    getMaxContextTokens() {
        const model = params.model || this.baseConfig.defaultModel || 'gpt-3.5-turbo'; // Use params.model if provided for specific call context
        // Source: https://platform.openai.com/docs/models (Context window column)
        // Values as of late 2023 / early 2024. Always verify with OpenAI documentation.
        const modelContextWindows = {
            // GPT-4 Turbo models
            'gpt-4-turbo': 128000,
            'gpt-4-turbo-2024-04-09': 128000,
            'gpt-4-turbo-preview': 128000,
            'gpt-4-0125-preview': 128000,
            'gpt-4-1106-preview': 128000,
            'gpt-4-vision-preview': 128000,

            // GPT-4 base models
            'gpt-4': 8192,
            'gpt-4-0613': 8192,
            'gpt-4-32k': 32768,
            'gpt-4-32k-0613': 32768,

            // GPT-3.5 Turbo models
            'gpt-3.5-turbo-0125': 16385,
            'gpt-3.5-turbo': 16385,          // Often updated, currently (early 2024) 16K.
            'gpt-3.5-turbo-1106': 16385,     // 16K context window.
            'gpt-3.5-turbo-instruct': 4096, // Instruct model.
            // Older gpt-3.5-turbo versions might have 4096, but aliases usually point to newer ones.
            'gpt-3.5-turbo-0613': 4096,
            'gpt-3.5-turbo-16k': 16385, // Explicitly 16k.
            'gpt-3.5-turbo-16k-0613': 16385,


            'default': 4096 // Default fallback
        };

        let contextSize = modelContextWindows[model];
        if (!contextSize) {
            // Try to find a base model if versioned e.g. gpt-4-0125-preview -> gpt-4
            const baseModel = model.split('-').slice(0, 2).join('-');
            contextSize = modelContextWindows[baseModel];
            if (!contextSize && model.startsWith('gpt-4')) contextSize = modelContextWindows['gpt-4'];
            else if (!contextSize && model.startsWith('gpt-3.5-turbo')) contextSize = modelContextWindows['gpt-3.5-turbo'];
            else contextSize = modelContextWindows['default'];
            // console.warn(\`OpenAIService.getMaxContextTokens: Model '\${model}' not found in known list. Using inferred \${contextSize} tokens.\`);
        }
        return contextSize;
    }

    /**
     * @override
     */
    getServiceName() {
        return "OpenAI";
    }

    /**
     * @override
     */
    async prepareContextForModel(contextParts, options = {}) {
        // OpenAI API for chat completions expects an array of message objects.
        // This method ensures the contextParts are in that format or converts them.
        // No actual caching or special handle is returned like for Gemini.

        if (typeof contextParts === 'string') {
            // If a simple string is provided, assume it's a user message.
            // System message could be passed in options.systemMessage.
            const messages = [];
            if (options.systemMessage && typeof options.systemMessage === 'string') {
                messages.push({ role: 'system', content: options.systemMessage });
            }
            messages.push({ role: 'user', content: contextParts });
            return messages;
        } else if (Array.isArray(contextParts)) {
            // Assume contextParts is already an array of message objects.
            // Basic validation can be done here if desired.
            let valid = true;
            if (contextParts.length > 0) {
                 valid = contextParts.every(msg =>
                    typeof msg.role === 'string' && typeof msg.content === 'string'
                );
            }
            if (valid) {
                return contextParts;
            } else {
                throw new Error("OpenAIService.prepareContextForModel: If contextParts is an array, it must be an array of {role, content} objects.");
            }
        } else if (contextParts === null || contextParts === undefined) {
             return []; // Return empty array if no context parts
        }

        throw new Error("OpenAIService.prepareContextForModel: contextParts must be a string or an array of message objects.");
    }

    // Optional: cleanup encoder when no longer needed (rarely needed in JS)
    // close() { if (this.enc) this.enc.free(); }
}

module.exports = OpenAIService;
