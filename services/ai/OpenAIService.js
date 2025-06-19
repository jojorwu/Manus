// File: services/ai/OpenAIService.js
const fs = require('fs');
const path = require('path');
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

        this.modelSpecs = null;
        try {
            const specsPath = path.join(__dirname, '..', '..', 'config', 'ai_model_specs.json'); // Path from services/ai/ to config/
            if (fs.existsSync(specsPath)) {
                const specsContent = fs.readFileSync(specsPath, 'utf8');
                this.modelSpecs = JSON.parse(specsContent);
            } else {
                console.warn(`OpenAIService: Model specs file not found at ${specsPath}. Using hardcoded defaults or baseConfig only for context windows.`);
            }
        } catch (e) {
            console.error(`OpenAIService: Error loading or parsing model specs file: ${e.message}.`);
            this.modelSpecs = null; // Ensure modelSpecs is null in case of error
        }

        let tokenizerNameToUse = this.baseConfig.tokenizerName || 'cl100k_base'; // Global fallback
        const defaultModelName = this.baseConfig.defaultModel || 'default';

        if (this.modelSpecs && this.modelSpecs.openai && this.modelSpecs.openai[defaultModelName] && this.modelSpecs.openai[defaultModelName].tokenizer) {
            tokenizerNameToUse = this.modelSpecs.openai[defaultModelName].tokenizer;
        } else if (this.modelSpecs && this.modelSpecs.openai && this.modelSpecs.openai.default && this.modelSpecs.openai.default.tokenizer) {
            tokenizerNameToUse = this.modelSpecs.openai.default.tokenizer;
        }
        this.tokenizerName = tokenizerNameToUse;
        this.enc = null;

        try {
            // Try to get encoding by model name first if a defaultModel is specified
            // The tokenizerName determined above (from specs or fallback) is the primary one to try.
            // However, encodingForModel is generally more robust if a model name is available.
            const modelForTiktoken = this.baseConfig.defaultModel;
            if (modelForTiktoken) {
                 this.enc = encodingForModel(modelForTiktoken);
            } else {
                this.enc = get_encoding(this.tokenizerName); // Fallback to tokenizerName if no defaultModel
            }
        } catch (e) {
            console.warn(`OpenAIService: Failed to load tiktoken encoder for model '${this.baseConfig.defaultModel || 'N/A'}' or tokenizer '${this.tokenizerName}'. Attempting fallback. Error: ${e.message}`);
            try {
                // Fallback to the determined tokenizerName if model-specific loading failed or no model was specified
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

        // Security: Validate model name from params against a list of known/allowed models for this service
        const allowedModels = [
            'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-0125-preview', 'gpt-4-1106-preview', 'gpt-4-vision-preview',
            'gpt-4', 'gpt-4-0613', 'gpt-4-32k', 'gpt-4-32k-0613',
            'gpt-3.5-turbo-0125', 'gpt-3.5-turbo', 'gpt-3.5-turbo-1106', 'gpt-3.5-turbo-instruct', 'gpt-3.5-turbo-0613', 'gpt-3.5-turbo-16k', 'gpt-3.5-turbo-16k-0613'
        ];
        let model = this.baseConfig.defaultModel || 'gpt-3.5-turbo';
        if (params.model) {
            if (allowedModels.includes(params.model)) {
                model = params.model;
            } else {
                // Attempt to match base model (e.g. gpt-4 from gpt-4-0125-preview)
                const baseModel = params.model.split('-').slice(0, 2).join('-');
                if (allowedModels.includes(baseModel)) {
                    model = params.model; // Allow if base model is known, actual sub-version might work
                     console.warn(`OpenAIService: Requested model '${params.model}' is not in the primary allowed list, but its base '${baseModel}' is known. Proceeding.`);
                } else {
                    console.warn(`OpenAIService: Requested model '${params.model}' is not in the allowed list. Using default: ${model}`);
                }
            }
        }

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

            const requestFn = () => this.openai.chat.completions.create(requestPayload);
            const completion = await this._executeRequestWithRetry(
                requestFn,
                this.baseConfig.maxRetries || 3,
                this.baseConfig.initialRetryDelayMs || 1000,
                this.getServiceName()
            );

            if (completion.choices && completion.choices.length > 0) {
                const choice = completion.choices[0];
                if (choice.message && choice.message.content) {
                    return choice.message.content.trim();
                }
            }
            console.warn("OpenAIService API response warning: No content found or unexpected format (after retries).", completion);
            throw new Error("OpenAI API response error: No message content found (after retries).");
        } catch (error) {
            // error.message should already be enriched by _executeRequestWithRetry
            const errorDetail = error.finalStatusCode ? `Status ${error.finalStatusCode}: ${error.message}` : (error.response?.data?.error?.message || error.error?.message || error.message);
            console.error(`OpenAIService: Error during chat completion for model ${model} (after retries):`, errorDetail, error.stack);
            // If _executeRequestWithRetry threw, error.message is already "Failed AIService API call after X attempts: original_message"
            // So, we might not need to prepend "OpenAI API Error (after retries):" if error.message is already descriptive.
            // However, to be explicit about the source:
            throw new Error(`OpenAI API Error (after retries): ${error.message}`);
        }
    }

    /**
     * @override
     */
    getTokenizer(modelName = null) {
        const targetModelName = modelName || this.baseConfig.defaultModel;
        let specificEncoder;

        if (targetModelName) {
            try {
                specificEncoder = encodingForModel(targetModelName);
                if (specificEncoder) {
                    return (text) => text ? specificEncoder.encode(text).length : 0;
                }
            } catch (e) {
                console.warn(`OpenAIService.getTokenizer: Failed to load tiktoken encoder for specific model '${targetModelName}'. Falling back. Error: ${e.message}`);
            }
        }

        // Fallback to the initialized encoder (this.enc) or default logic
        if (this.enc) {
            return (text) => text ? this.enc.encode(text).length : 0;
        }

        // Absolute fallback if this.enc also failed (should be rare after constructor improvements)
        console.warn("OpenAIService.getTokenizer: tiktoken encoder not available. Falling back to basic word count.");
        return (text) => text ? text.split(/\s+/).filter(Boolean).length : 0;
    }

    /**
     * @override
     */
    getMaxContextTokens(modelName = null) {
        const modelNameToUse = modelName || this.baseConfig.defaultModel || 'default';
        let contextWindow = 4096; // Absolute fallback

        if (this.modelSpecs && this.modelSpecs.openai) {
            const serviceSpecs = this.modelSpecs.openai;
            if (serviceSpecs[modelNameToUse] && serviceSpecs[modelNameToUse].contextWindow) {
                contextWindow = serviceSpecs[modelNameToUse].contextWindow;
            } else {
                // Attempt to find a base model if exact match not found (e.g., "gpt-4" from "gpt-4-turbo-preview")
                const baseModelMatch = modelNameToUse.match(/^(gpt-4o|gpt-4-turbo|gpt-4|gpt-3\.5-turbo)/);
                let foundBaseSpec = false;
                if (baseModelMatch && baseModelMatch[0] && serviceSpecs[baseModelMatch[0]] && serviceSpecs[baseModelMatch[0]].contextWindow) {
                    contextWindow = serviceSpecs[baseModelMatch[0]].contextWindow;
                    console.warn(`OpenAIService.getMaxContextTokens: No exact spec for '${modelNameToUse}', using base model '${baseModelMatch[0]}' context window: ${contextWindow}`);
                    foundBaseSpec = true;
                }

                if (!foundBaseSpec && serviceSpecs.default && serviceSpecs.default.contextWindow) {
                    contextWindow = serviceSpecs.default.contextWindow;
                    console.warn(`OpenAIService.getMaxContextTokens: Model '${modelNameToUse}' not found in specs or known base models. Using default OpenAI spec context window: ${contextWindow}`);
                } else if (!foundBaseSpec) {
                    console.warn(`OpenAIService.getMaxContextTokens: Model '${modelNameToUse}' not found and no default OpenAI spec context window. Using hardcoded fallback: ${contextWindow}`);
                }
            }
        } else {
            console.warn(`OpenAIService.getMaxContextTokens: Model specs not loaded. Using hardcoded fallback: ${contextWindow}`);
        }
        return contextWindow;
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
