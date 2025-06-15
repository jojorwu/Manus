// File: services/ai/GeminiService.js
const BaseAIService = require('./BaseAIService');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");

class GeminiService extends BaseAIService {
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig);
        this.defaultModel = baseConfig.defaultModel || 'gemini-pro'; // Example default
        this.genAI = null; // Initialize GoogleGenerativeAI client instance
        if (!this.apiKey && !process.env.GEMINI_API_KEY) {
            console.warn("GeminiService: API key is not provided and GEMINI_API_KEY env var is not set. Service will use stubbed responses for actual calls or fail on client init if key becomes mandatory.");
        }
    }

    _getApiKey() {
        // In a real scenario, this would throw an error if the key is truly needed and missing.
        // For now, aligns with stub behavior for generateText if key is missing.
        const key = this.apiKey || process.env.GEMINI_API_KEY;
        if (!key) {
            // console.warn("GeminiService: API key for Gemini is missing."); // Logged by _ensureClient or constructor
        }
        return key;
    }

    _ensureClient() {
        if (this.genAI) {
            return true;
        }
        const apiKey = this._getApiKey();

        if (!apiKey) {
             console.warn("GeminiService: API key for Gemini is missing. Cannot initialize client for actual calls.");
             return false;
        }
        try {
            console.log("GeminiService: Initializing GoogleGenerativeAI client.");
            this.genAI = new GoogleGenerativeAI(apiKey);
            return true;
        } catch (error) {
            console.error(`GeminiService: Failed to initialize GoogleGenerativeAI client. Error: ${error.message}`);
            this.genAI = null;
            throw new Error(`GeminiService client initialization failed: ${error.message}`);
        }
    }

    async generateText(prompt, params = {}) {
        const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn("GeminiService: GEMINI_API_KEY is not set. LLM service cannot operate with actual API, returning stub for generateText.");
            if (prompt.includes("create a sequential plan") || prompt.includes("generate a revised plan")) {
                return "[]";
            }
            return "GeminiService LLM synthesized answer (stub due to missing API key).";
        }

        this._ensureClient();
        if (!this.genAI) {
            throw new Error("GeminiService: GoogleGenerativeAI client is not available.");
        }

        const modelName = params.model || this.defaultModel || 'gemini-pro';
        const temperature = params.temperature !== undefined ? params.temperature : (this.baseConfig.temperature !== undefined ? this.baseConfig.temperature : 0.7);
        const maxOutputTokens = params.maxTokens || this.baseConfig.maxTokens || 2048;
        const stopSequences = params.stopSequences || this.baseConfig.stopSequences;
        const systemInstruction = params.systemInstruction || this.baseConfig.systemInstruction;

        console.log(`GeminiService (${modelName}): Calling generateContent API with prompt (first 100 chars): "${prompt.substring(0,100)}..."`);

        try {
            const generationConfig = {
                temperature: temperature,
                maxOutputTokens: maxOutputTokens,
            };
            if (stopSequences && Array.isArray(stopSequences) && stopSequences.length > 0) {
                generationConfig.stopSequences = stopSequences;
            }

            const modelInstance = this.genAI.getGenerativeModel({
                model: modelName,
                generationConfig,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                ],
                ...(systemInstruction && { systemInstruction: { role: "system", parts: [{text: systemInstruction}] } })
            });

            const result = await modelInstance.generateContent(prompt);
            const response = await result.response;

            if (response && typeof response.text === 'function') {
                const textContent = response.text();
                console.log(`GeminiService (${modelName}): generateContent successful.`);
                return textContent;
            } else if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0 && typeof response.candidates[0].content.parts[0].text === 'string') {
                const textContent = response.candidates[0].content.parts[0].text;
                console.log(`GeminiService (${modelName}): generateContent successful (extracted from candidate).`);
                return textContent;
            }
            else {
                console.warn(`GeminiService (${modelName}): API response format error. No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API response format error: No text content found.");
            }
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (generateContent):`, error.message);
            const detail = error.message;
            throw new Error(`Gemini API Error: ${detail}`);
        }
    }

    async completeChat(messages, params = {}) {
        const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn("GeminiService: GEMINI_API_KEY is not set. LLM service cannot operate with actual API, returning stub for completeChat.");
            return "GeminiService LLM chat response (stub due to missing API key).";
        }

        this._ensureClient();
        if (!this.genAI) {
            throw new Error("GeminiService: GoogleGenerativeAI client is not available.");
        }

        const modelName = params.model || this.defaultModel || 'gemini-pro'; // Default to gemini-pro for chat too
        const temperature = params.temperature !== undefined ? params.temperature : (this.baseConfig.temperature !== undefined ? this.baseConfig.temperature : 0.7);
        const maxOutputTokens = params.maxTokens || this.baseConfig.maxTokens || 2048;
        const stopSequences = params.stopSequences || this.baseConfig.stopSequences;

        let systemInstruction = params.systemInstruction || this.baseConfig.systemInstruction;
        let chatHistory = [];
        let currentMessages = [...messages]; // Create a mutable copy

        // Extract system instruction from messages if not provided in params
        if (!systemInstruction && currentMessages.length > 0 && currentMessages[0].role === 'system') {
            systemInstruction = currentMessages[0].content;
            currentMessages.shift(); // Remove system message from currentMessages
        }

        // Transform messages for Gemini history (role 'assistant' -> 'model')
        chatHistory = currentMessages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role, // 'user' remains 'user'
            parts: [{ text: msg.content }]
        }));

        let lastUserMessage = "";
        if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
            const lastMessageParts = chatHistory.pop().parts;
            if (lastMessageParts && lastMessageParts.length > 0) {
                lastUserMessage = lastMessageParts[0].text;
            }
        } else if (chatHistory.length === 0 && !lastUserMessage) {
            if (!systemInstruction) {
                 console.warn(`GeminiService (${modelName}): completeChat called with no user messages to respond to.`);
                 lastUserMessage = "";
            }
        }

        console.log(`GeminiService (${modelName}): Calling Chat API. History length: ${chatHistory.length}, Last User Msg: "${lastUserMessage.substring(0,50)}..."`);

        try {
            const generationConfig = {
                temperature: temperature,
                maxOutputTokens: maxOutputTokens,
            };
            if (stopSequences && Array.isArray(stopSequences) && stopSequences.length > 0) {
                generationConfig.stopSequences = stopSequences;
            }

            const modelInstanceParams = {
                model: modelName,
                generationConfig,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                ]
            };
            if (systemInstruction) {
                modelInstanceParams.systemInstruction = { role: "system", parts: [{text: systemInstruction}] };
            }

            const modelInstance = this.genAI.getGenerativeModel(modelInstanceParams);

            const chat = modelInstance.startChat({ history: chatHistory });
            const result = await chat.sendMessage(lastUserMessage);
            const response = await result.response;

            if (response && typeof response.text === 'function') {
                const textContent = response.text();
                console.log(`GeminiService (${modelName}): Chat call successful.`);
                return textContent;
            } else if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0 && typeof response.candidates[0].content.parts[0].text === 'string') {
                const textContent = response.candidates[0].content.parts[0].text;
                console.log(`GeminiService (${modelName}): Chat call successful (extracted from candidate).`);
                return textContent;
            }
            else {
                console.warn(`GeminiService (${modelName}): Chat API response format error. No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API chat response format error: No text content found.");
            }
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (sendMessage/startChat):`, error.message);
            const detail = error.message;
            throw new Error(`Gemini API Chat Error: ${detail}`);
        }
    }

    /**
     * Returns a tokenizer function for Gemini models.
     * Note: Gemini tokenization is typically handled server-side via the Google AI SDK (`countTokens`),
     * which is asynchronous. This method provides a synchronous, approximate tokenizer inherited
     * from `BaseAIService` for immediate context assembly estimations.
     * For precise counts, especially before an API call, using the SDK's `countTokens` is recommended if feasible.
     * @returns {Function} An approximate tokenizer function.
     */
    getTokenizer() {
        // Gemini tokenization is typically handled server-side by the Google AI SDK.
        // The SDK's `countTokens` method is asynchronous and involves an API call.
        // For a synchronous tokenizer function needed by Orchestrator/MemoryManager for immediate context assembly,
        // a precise client-side equivalent isn't readily available without deeper SDK integration or a separate library.
        // Therefore, we rely on the base class's approximation.
        console.warn("GeminiService.getTokenizer: Using approximate tokenizer from BaseAIService. For precise counts for API calls, use the Google AI SDK's countTokens method if available and necessary before making the call.");
        return super.getTokenizer(); // Fallback to BaseAIService's placeholder
    }

    /**
     * Returns the maximum number of context tokens for the configured default Gemini model.
     * It uses a predefined map of known Gemini models and their context window sizes.
     * For Gemini 1.5 models, it may apply a practical effective limit for context assembly
     * (e.g., 128k tokens) even if the model supports a larger theoretical maximum (e.g., 1M tokens),
     * unless overridden by `baseConfig.maxTokensForContext`.
     * @returns {number} The maximum number of context tokens.
     */
    getMaxContextTokens() {
        const model = this.defaultModel || (this.baseConfig && this.baseConfig.defaultModel) || 'gemini-pro';
        // Source: https://ai.google.dev/models/gemini (Context windows updated April 2024)
        // These values represent the input token limits. Output limits are often separate.
        const modelContextWindows = {
            // Gemini 1.5 Series (Large context window, but often used with a smaller practical input limit for requests by default)
            'gemini-1.5-pro-latest': 1048576, // Model supports up to 1M tokens
            'gemini-1.5-pro': 1048576,
            'gemini-1.5-flash-latest': 1048576,
            'gemini-1.5-flash': 1048576,

            // Gemini 1.0 Series
            'gemini-1.0-pro': 30720,        // Standard 32k limit (30720 text + 2048 for output generation typically)
            'gemini-pro': 30720,            // Alias for 1.0 pro
            'gemini-1.0-pro-vision-latest': 12288, // Vision model, context includes image data
            'gemini-1.0-pro-001': 30720,    // Specific version

            // Older or variant models if any, ensure these are correct as per docs
            // 'gemini-ultra': some_value, // If Ultra models become available via this SDK

            'default': 30720 // Default to gemini-pro's standard limit
        };

        let effectiveLimit = modelContextWindows[model] || modelContextWindows['default'];

        if (model.startsWith('gemini-1.5')) {
            // For Gemini 1.5 models, while the theoretical limit is 1M tokens,
            // practical usage for context assembly before a call might be best capped lower
            // unless the specific call is designed to leverage the full 1M.
            // The `baseConfig.maxTokensForContext` could override this if set.
            effectiveLimit = this.baseConfig?.maxTokensForContext || 131072; // e.g. 128k as a large but practical default for 1.5 models
            console.log(`GeminiService.getMaxContextTokens: Model ${model} is a Gemini 1.5 series. Using effective limit of ${effectiveLimit} for context assembly. Max supported: ${modelContextWindows[model]}.`);
        }

        if (!modelContextWindows[model]) {
            console.warn(`GeminiService.getMaxContextTokens: Model ${model} not found in known list. Using default ${effectiveLimit} tokens.`);
        }
        return effectiveLimit;
    }
}

module.exports = GeminiService;
