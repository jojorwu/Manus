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
        const key = this.apiKey || process.env.GEMINI_API_KEY;
        if (!key) {
            // console.warn("GeminiService: API key for Gemini is missing.");
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
        if (!apiKey && !params.isSystemInternalCall) { // Allow internal calls to proceed for potential stubbing/testing
            console.warn("GeminiService: GEMINI_API_KEY is not set. LLM service cannot operate with actual API, returning stub for generateText.");
            if (prompt.includes("create a sequential plan") || prompt.includes("generate a revised plan")) {
                return "[]"; // Specific stub for planning prompts
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
        const systemInstructionText = params.systemInstruction || this.baseConfig.systemInstruction;
        const cachedContentName = params.cachedContentName;

        console.log(`GeminiService (${modelName}): Calling generateContent API. Prompt (first 100 chars): "${String(prompt).substring(0,100)}...". CachedContent: ${cachedContentName || 'N/A'}`);

        const requestPayload = {
            generationConfig: {
                temperature: temperature,
                maxOutputTokens: maxOutputTokens,
            },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ],
        };

        if (systemInstructionText) {
            requestPayload.systemInstruction = { role: "system", parts: [{ text: systemInstructionText }] };
        }

        if (cachedContentName) {
            requestPayload.cachedContent = cachedContentName;
            // If cachedContent is used, the 'prompt' (which is 'contents' in the API) is only the new turn.
            // The prompt argument to this function should be the new text.
            requestPayload.contents = [{ role: "user", parts: [{ text: prompt }] }];
        } else {
            // If no cachedContent, the 'prompt' is the full content for this turn.
            requestPayload.contents = [{ role: "user", parts: [{ text: prompt }] }];
        }

        if (stopSequences && Array.isArray(stopSequences) && stopSequences.length > 0) {
            requestPayload.generationConfig.stopSequences = stopSequences;
        }

        try {
            const modelInstance = this.genAI.getGenerativeModel({ model: modelName });
            const result = await modelInstance.generateContent(requestPayload);
            const response = await result.response;

            if (response && typeof response.text === 'function') {
                const textContent = response.text();
                console.log(`GeminiService (${modelName}): generateContent successful.`);
                return textContent;
            } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const textContent = response.candidates[0].content.parts[0].text;
                console.log(`GeminiService (${modelName}): generateContent successful (extracted from candidate).`);
                return textContent;
            }
            else {
                console.warn(`GeminiService (${modelName}): API response format error. No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API response format error: No text content found.");
            }
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (generateContent):`, error.message, error.stack);
            const detail = error.message;
            throw new Error(`Gemini API Error: ${detail}`);
        }
    }

    async completeChat(messages, params = {}) {
        const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
         if (!apiKey && !params.isSystemInternalCall) {
            console.warn("GeminiService: GEMINI_API_KEY is not set. LLM service cannot operate with actual API, returning stub for completeChat.");
            return "GeminiService LLM chat response (stub due to missing API key).";
        }

        this._ensureClient();
        if (!this.genAI) {
            throw new Error("GeminiService: GoogleGenerativeAI client is not available.");
        }

        const modelName = params.model || this.defaultModel || 'gemini-pro';
        const temperature = params.temperature !== undefined ? params.temperature : (this.baseConfig.temperature !== undefined ? this.baseConfig.temperature : 0.7);
        const maxOutputTokens = params.maxTokens || this.baseConfig.maxTokens || 2048;
        const stopSequences = params.stopSequences || this.baseConfig.stopSequences;
        const systemInstructionText = params.systemInstruction || this.baseConfig.systemInstruction;
        const cachedContentName = params.cachedContentName;

        // If cachedContentName is provided, we must use a direct generateContent call
        // as ChatSession does not directly support cachedContent.
        if (cachedContentName) {
            console.log(`GeminiService (${modelName}): Using cachedContent ('${cachedContentName}') for chat. Making a direct generateContent call.`);

            // Construct 'contents' from the 'messages' array.
            // The 'messages' should only contain the *new* turns since the cache was created.
            const newContents = messages.map(msg => ({
                role: msg.role === 'assistant' ? 'model' : msg.role, // Gemini uses 'model' for assistant role
                parts: [{ text: msg.content }]
            }));

            const requestPayload = {
                contents: newContents, // Contains only new messages
                cachedContent: cachedContentName,
                generationConfig: {
                    temperature: temperature,
                    maxOutputTokens: maxOutputTokens,
                },
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                ],
            };
            if (systemInstructionText) {
                // System instruction might be part of cachedContent. If provided here, it overrides.
                requestPayload.systemInstruction = { role: "system", parts: [{ text: systemInstructionText }] };
            }
            if (stopSequences && Array.isArray(stopSequences) && stopSequences.length > 0) {
                requestPayload.generationConfig.stopSequences = stopSequences;
            }

            try {
                const modelInstance = this.genAI.getGenerativeModel({ model: modelName });
                const result = await modelInstance.generateContent(requestPayload);
                const response = await result.response;

                if (response && typeof response.text === 'function') return response.text();
                if (response?.candidates?.[0]?.content?.parts?.[0]?.text) return response.candidates[0].content.parts[0].text;

                console.warn(`GeminiService (${modelName}): Chat API response format error (with cache). No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API chat response format error (with cache): No text content found.");
            } catch (error) {
                console.error(`GeminiService (${modelName}): Error during generateContent call (with cache for chat):`, error.message, error.stack);
                throw new Error(`Gemini API Error (with cache for chat): ${error.message}`);
            }
        }

        // Original completeChat logic if no cachedContentName is provided
        let effectiveSystemInstruction = systemInstructionText;
        let chatHistoryForSDK = [];
        let currentMessagesForSDK = [...messages];

        if (!effectiveSystemInstruction && currentMessagesForSDK.length > 0 && currentMessagesForSDK[0].role === 'system') {
            effectiveSystemInstruction = currentMessagesForSDK.shift().content;
        }

        chatHistoryForSDK = currentMessagesForSDK.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role,
            parts: [{ text: msg.content }]
        }));

        let lastUserMessageText = "";
        if (chatHistoryForSDK.length > 0 && chatHistoryForSDK[chatHistoryForSDK.length - 1].role === 'user') {
            const lastMessageParts = chatHistoryForSDK.pop().parts; // Remove the last user message from history to send as current message
            if (lastMessageParts && lastMessageParts.length > 0) {
                lastUserMessageText = lastMessageParts[0].text;
            }
        } else if (chatHistoryForSDK.length === 0 && !lastUserMessageText && !effectiveSystemInstruction) {
             console.warn(`GeminiService (${modelName}): completeChat called with no user messages to respond to and no system instruction.`);
             lastUserMessageText = "";
        }

        console.log(`GeminiService (${modelName}): Calling Chat API (no cache). History length: ${chatHistoryForSDK.length}, Last User Msg: "${lastUserMessageText.substring(0,50)}..."`);

        try {
            const generationConfig = { temperature, maxOutputTokens };
            if (stopSequences?.length) generationConfig.stopSequences = stopSequences;

            const modelInstanceParams = { model: modelName, generationConfig, safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ]};
            if (effectiveSystemInstruction) {
                modelInstanceParams.systemInstruction = { role: "system", parts: [{text: effectiveSystemInstruction}] };
            }

            const modelInstance = this.genAI.getGenerativeModel(modelInstanceParams);
            const chat = modelInstance.startChat({ history: chatHistoryForSDK });
            const result = await chat.sendMessage(lastUserMessageText);
            const response = await result.response;

            if (response && typeof response.text === 'function') {
                const textContent = response.text();
                console.log(`GeminiService (${modelName}): Chat call successful.`);
                return textContent;
            } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const textContent = response.candidates[0].content.parts[0].text;
                console.log(`GeminiService (${modelName}): Chat call successful (extracted from candidate).`);
                return textContent;
            }
            else {
                console.warn(`GeminiService (${modelName}): Chat API response format error. No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API chat response format error: No text content found.");
            }
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (sendMessage/startChat):`, error.message, error.stack);
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
        console.warn("GeminiService.getTokenizer: Using approximate tokenizer from BaseAIService. For precise counts for API calls, use the Google AI SDK's countTokens method if available and necessary before making the call.");
        return super.getTokenizer();
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
        const modelContextWindows = {
            'gemini-1.5-pro-latest': 1048576,
            'gemini-1.5-pro': 1048576,
            'gemini-1.5-flash-latest': 1048576,
            'gemini-1.5-flash': 1048576,
            'gemini-1.0-pro': 30720,
            'gemini-pro': 30720,
            'gemini-1.0-pro-vision-latest': 12288,
            'gemini-1.0-pro-001': 30720,
            'default': 30720
        };

        let effectiveLimit = modelContextWindows[model] || modelContextWindows['default'];

        if (model.startsWith('gemini-1.5')) {
            effectiveLimit = this.baseConfig?.maxTokensForContext || 131072;
            console.log(`GeminiService.getMaxContextTokens: Model ${model} is a Gemini 1.5 series. Using effective limit of ${effectiveLimit} for context assembly. Max supported: ${modelContextWindows[model]}.`);
        }

        if (!modelContextWindows[model]) {
            console.warn(`GeminiService.getMaxContextTokens: Model ${model} not found in known list. Using default ${effectiveLimit} tokens.`);
        }
        return effectiveLimit;
    }

    /**
     * Creates a cached content entry on the Gemini API.
     * @param {object} creationParams - Parameters for creating the cached content.
     * @param {string} creationParams.modelName - The model name for which this cache is intended (e.g., 'gemini-1.5-pro-latest').
     * @param {Array<object>} creationParams.contents - The content to be cached, conforming to Gemini's Content API structure.
     * @param {string} [creationParams.systemInstruction] - Optional system instruction to associate with the cached content.
     * @param {number} [creationParams.ttlSeconds] - Optional Time-To-Live for the cache entry in seconds.
     * @param {string} [creationParams.displayName] - Optional display name for the cache.
     * @returns {Promise<object>} The full CachedContent object returned by the SDK.
     * @throws {Error} If API client is not initialized or if the API call fails.
     */
    async createCachedContent(creationParams) {
        this._ensureClient();
        if (!this.genAI || !this.genAI.caches) {
            console.error("GeminiService.createCachedContent: genAI client or caches module is not available/initialized.");
            throw new Error("GeminiService: genAI client or caches module not initialized.");
        }

        if (!creationParams || !creationParams.modelName || !Array.isArray(creationParams.contents)) {
            throw new Error("GeminiService.createCachedContent: 'modelName' and 'contents' (array) are required in creationParams.");
        }

        const { modelName, contents, systemInstruction, ttlSeconds, displayName } = creationParams;

        // Construct the cache creation request carefully.
        // The 'model' for the cache is the model it's intended to be used with, not necessarily this.defaultModel.
        // The 'contents' are provided directly.
        // System instruction needs to be formatted correctly.
        const cacheCreationRequest = {
            model: modelName, // e.g. "models/gemini-1.5-pro-latest" - ensure this is the full model resource name
            contents: contents,
        };

        if (systemInstruction) {
            cacheCreationRequest.systemInstruction = { role: "system", parts: [{ text: systemInstruction }] };
        }
        if (ttlSeconds && typeof ttlSeconds === 'number' && ttlSeconds > 0) {
            cacheCreationRequest.ttl = `${ttlSeconds}s`;
        }
        if (displayName) {
            cacheCreationRequest.displayName = displayName;
        }

        try {
            console.log(`GeminiService: Creating cached content for model ${modelName}. DisplayName: ${displayName || 'N/A'}, TTL: ${ttlSeconds || 'N/A'}`);
            // The genAI.caches.create() method expects the full model resource name string.
            // E.g., "models/gemini-1.5-pro-latest"
            // We need to ensure modelName is passed in this format or construct it.
            // For now, assuming modelName is passed correctly by the caller.
            const cachedContent = await this.genAI.caches.create(cacheCreationRequest);
            console.log(`GeminiService: Cached content created successfully. Name: ${cachedContent.name}`);
            return cachedContent; // Return the full CachedContent object
        } catch (error) {
            console.error(`GeminiService.createCachedContent: Error creating cached content for model ${modelName}:`, error.message, error.stack);
            const detail = error.message;
            throw new Error(`Gemini API Error (createCachedContent): ${detail}`);
        }
    }
}

module.exports = GeminiService;
