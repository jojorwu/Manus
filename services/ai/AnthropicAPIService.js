// File: services/ai/AnthropicAPIService.js
import BaseAIService from '../BaseAIService.js';
import Anthropic from '@anthropic-ai/sdk';

class AnthropicAPIService extends BaseAIService {
    /**
     * Constructor for AnthropicAPIService.
     * @param {string} apiKey - The API key for Anthropic.
     * @param {object} baseConfig - Base configuration options.
     * @param {string} [baseConfig.defaultModel='claude-3-sonnet-20240229'] - Default model to use.
     * @param {number} [baseConfig.temperature=0.7] - Default temperature.
     * @param {number} [baseConfig.maxTokens=2048] - Default max output tokens (max_tokens_to_sample for older API, max_tokens for Messages API).
     */
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig); // Sets this.apiKey and this.baseConfig
        this.anthropic = null; // Initialized in _ensureClient

        if (!this._getApiKey()) {
            console.warn("AnthropicAPIService: API key is not provided directly or via ANTHROPIC_API_KEY env var. Service will fail on execution.");
        }
    }

    _getApiKey() {
        return this.apiKey || process.env.ANTHROPIC_API_KEY;
    }

    _ensureClient() {
        if (this.anthropic) {
            return true;
        }
        const apiKey = this._getApiKey();
        if (!apiKey) {
             throw new Error("AnthropicAPIService: API key is missing. Cannot initialize client.");
        }
        try {
            // console.log("AnthropicAPIService: Initializing Anthropic client.");
            this.anthropic = new Anthropic({ apiKey });
            return true;
        } catch (error) {
            console.error(\`AnthropicAPIService: Failed to initialize Anthropic client. Error: \${error.message}\`);
            this.anthropic = null;
            throw new Error(\`AnthropicAPIService client initialization failed: \${error.message}\`);
        }
    }

    /**
     * @override
     */
    async generateText(promptString, params = {}) {
        this._ensureClient();
        if (typeof promptString !== 'string') {
            throw new Error("AnthropicAPIService.generateText: promptString must be a string.");
        }

        const messages = [];
        if (params.systemMessage && typeof params.systemMessage === 'string') {
            // For Claude's Messages API, system prompt is a top-level parameter.
            // We'll pass it through params in completeChat.
        }
        messages.push({ role: 'user', content: promptString });

        return this.completeChat(messages, params);
    }

    /**
     * @override
     */
    async completeChat(messagesArray, params = {}) {
        this._ensureClient();

        const model = params.model || this.baseConfig.defaultModel || 'claude-3-sonnet-20240229';
        const temperature = params.temperature !== undefined ? params.temperature : this.baseConfig.temperature;
        // Anthropic Messages API uses 'max_tokens'. Older text completions used 'max_tokens_to_sample'.
        const maxTokens = params.max_tokens || params.maxTokens || this.baseConfig.maxTokens || 2048;
        const stopSequences = params.stop_sequences || params.stopSequences || this.baseConfig.stopSequences;
        let systemPrompt = params.systemMessage || this.baseConfig.systemMessage;


        if (!Array.isArray(messagesArray) || messagesArray.length === 0) {
            throw new Error("AnthropicAPIService.completeChat: messagesArray cannot be empty.");
        }

        const anthropicMessages = [];
        for (const msg of messagesArray) {
            if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
                throw new Error("AnthropicAPIService.completeChat: Each message must have 'role' and 'content' strings.");
            }
            if (msg.role === 'system') {
                if (!systemPrompt) systemPrompt = msg.content; // Prefer explicit system param, but take from messages if first.
                continue; // System messages are not part of the 'messages' array for Anthropic API
            }
            if (msg.role !== 'user' && msg.role !== 'assistant') {
                console.warn(\`AnthropicAPIService: Invalid role '\${msg.role}' converted to 'user'.\`);
                anthropicMessages.push({ role: 'user', content: \`[\${msg.role} message]: \${msg.content}\` });
            } else {
                anthropicMessages.push({ role: msg.role, content: msg.content });
            }
        }

        if (anthropicMessages.length === 0 && !systemPrompt) {
            throw new Error("AnthropicAPIService.completeChat: No user/assistant messages to send after processing system prompt.");
        }
        // Ensure the last message is from the user if the API requires it (some versions/models might)
        // However, Claude's Messages API is flexible; it can end with an assistant message for few-shot.
        // For a typical chat, it expects the last message to be 'user'.
        // If the last message is 'assistant', the model will continue that assistant's turn.
        // This behavior is generally fine for the `completeChat` abstraction.

        // console.log(\`AnthropicAPIService: Calling Messages API. Model: \${model}, Messages: \${anthropicMessages.length}\`);
        try {
            const requestPayload = {
                model: model,
                messages: anthropicMessages,
                max_tokens: maxTokens,
            };
            if (systemPrompt) requestPayload.system = systemPrompt;
            if (temperature !== undefined) requestPayload.temperature = temperature;
            if (stopSequences !== undefined) requestPayload.stop_sequences = stopSequences;
            if (params.top_k !== undefined) requestPayload.top_k = params.top_k;
            if (params.top_p !== undefined) requestPayload.top_p = params.top_p;

            const response = await this.anthropic.messages.create(requestPayload);

            if (response && response.content && response.content.length > 0) {
                // Assuming the first content block is the primary text response
                const textContent = response.content.filter(block => block.type === 'text').map(block => block.text).join('\\n');
                return textContent;
            }
            console.warn("AnthropicAPIService API response warning: No content found or unexpected format.", response);
            throw new Error("Anthropic API response error: No message content found.");
        } catch (error) {
            const errorDetail = error.response?.data?.error?.message || error.error?.message || error.message;
            console.error(\`AnthropicAPIService: Error during Messages API call for model \${model}:\`, errorDetail, error.stack);
            throw new Error(\`Anthropic API Error: \${errorDetail}\`);
        }
    }

    /**
     * @override
     */
    getTokenizer() {
        // Anthropic doesn't expose a client-side tokenizer in their Node SDK as of last check.
        // They recommend counting bytes for a rough estimate (approx 4 chars/token, or byte length).
        // Using byte length as a more direct measure.
        console.warn("AnthropicAPIService.getTokenizer: Using byte length as an approximate tokenizer. Actual token count is determined server-side.");
        return (text) => {
            if (!text) return 0;
            return new TextEncoder().encode(text).length;
        };
    }

    /**
     * @override
     */
    getMaxContextTokens() {
        // Values as of early 2024. Claude 3 models have a 200K context window.
        // Older models like Claude 2.1 also had 200K, Claude 2.0 had 100K.
        // The actual number of tokens the API will *accept* might be slightly less than advertised
        // to leave room for the response. It's safest to aim a bit lower for input.
        const model = params.model || this.baseConfig.defaultModel || 'claude-3-sonnet-20240229';
        const modelContextWindows = {
            // Claude 3 Series (all list 200K context window)
            'claude-3-opus-20240229': 200000,
            'claude-3-sonnet-20240229': 200000,
            'claude-3-haiku-20240307': 200000,

            // Older models
            'claude-2.1': 200000,
            'claude-2.0': 100000,
            'claude-instant-1.2': 100000,

            'default': 100000 // Fallback for older or unknown models
        };

        let contextSize = modelContextWindows[model];
        if (!contextSize) {
            // Basic fallback for unlisted variants
            if (model.includes('claude-3')) contextSize = 200000;
            else if (model.includes('claude-2')) contextSize = 100000; // Defaulting to 100K for Claude 2 variants
            else contextSize = modelContextWindows['default'];
            // console.warn(\`AnthropicAPIService.getMaxContextTokens: Model '\${model}' not in known list. Using inferred \${contextSize} tokens.\`);
        }
        // It's good practice to use a fraction of this for input, e.g., 90-95%
        return Math.floor(contextSize * 0.95);
    }

    /**
     * @override
     */
    getServiceName() {
        return "Anthropic";
    }

    /**
     * @override
     */
    async prepareContextForModel(contextParts, options = {}) {
        // For Anthropic's Messages API, context is passed as an array of messages,
        // with an optional top-level system prompt.
        // This method will format various inputs into this structure.

        let messages = [];
        let systemPrompt = options.systemMessage || null;

        if (typeof contextParts === 'string') {
            messages.push({ role: 'user', content: contextParts });
        } else if (Array.isArray(contextParts)) {
            for (const part of contextParts) {
                if (part.role === 'system') {
                    if (!systemPrompt) systemPrompt = part.content; // Prioritize options.systemMessage
                    // Do not add system messages to the main messages array for Anthropic
                } else if (part.role === 'user' || part.role === 'assistant') {
                    messages.push(part);
                } else {
                    console.warn(\`AnthropicAPIService.prepareContextForModel: Unknown role '\${part.role}' encountered. Treating as user message.\`);
                    messages.push({ role: 'user', content: \`[\${part.role}]: \${part.content}\`});
                }
            }
        } else if (contextParts === null || contextParts === undefined) {
            // No initial messages, systemPrompt might still be set from options
        } else {
            throw new Error("AnthropicAPIService.prepareContextForModel: contextParts must be a string or an array of message objects.");
        }

        // Anthropic doesn't have a concept of a "cacheHandle" to return like Gemini.
        // This method returns the processed messages and system prompt, ready for the API call.
        // The actual API call in completeChat will use these.
        // To align with BaseAIService that might return a specific handle or null,
        // we can return an object that completeChat can destructure.
        return {
            messages: messages, // This will be used as 'messages' in anthropic.messages.create
            systemPrompt: systemPrompt // This will be used as 'system' in anthropic.messages.create
        };
        // Or, if completeChat is made robust enough to handle these parts from params,
        // this method could return null if no transformation beyond basic validation is done.
        // For now, returning the structured parts is cleaner.
    }
}

export default AnthropicAPIService;
