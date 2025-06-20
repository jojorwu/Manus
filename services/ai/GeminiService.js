// File: services/ai/GeminiService.js
const fs = require('fs');
const path = require('path');
const BaseAIService = require('../BaseAIService.js'); // Corrected path
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");

class GeminiService extends BaseAIService {
    /**
     * Constructor for GeminiService.
     * @param {string} apiKey - The API key for the Gemini API.
     * @param {object} baseConfig - Base configuration options.
     * @param {string} [baseConfig.defaultModel='gemini-pro'] - Default model to use.
     * @param {number} [baseConfig.temperature=0.7] - Default temperature.
     * @param {number} [baseConfig.maxTokens=2048] - Default max output tokens.
     * @param {Array<string>} [baseConfig.stopSequences] - Default stop sequences.
     * @param {string} [baseConfig.systemInstruction] - Default system instruction text.
     * @param {number} [baseConfig.maxTokensForContext=131072] - Effective token limit for context assembly for 1.5 models.
     */
    constructor(apiKey, baseConfig = {}) {
        super(apiKey, baseConfig); // baseConfig is now stored in this.baseConfig by super
        this.genAI = null; // Initialize GoogleGenerativeAI client instance
        this.tokenizerWarningShown = false;

        this.modelSpecs = null;
        try {
            const specsPath = path.join(__dirname, '..', '..', 'config', 'ai_model_specs.json'); // Path from services/ai/ to config/
            if (fs.existsSync(specsPath)) {
                const specsContent = fs.readFileSync(specsPath, 'utf8');
                this.modelSpecs = JSON.parse(specsContent);
            } else {
                console.warn(`GeminiService: Model specs file not found at ${specsPath}. Using hardcoded defaults or baseConfig only for context windows.`);
            }
        } catch (e) {
            console.error(`GeminiService: Error loading or parsing model specs file: ${e.message}.`);
            this.modelSpecs = null; // Ensure modelSpecs is null in case of error
        }

        if (!this._getApiKey() && !process.env.GEMINI_API_KEY) { // Check resolved API key
            console.warn("GeminiService: API key is not provided directly or via GEMINI_API_KEY env var. Service may use stubbed responses or fail on client init if key becomes mandatory for SDK.");
        }
        // The actual generativeModel instance (e.g., for gemini-pro) is created on demand or within methods.
        // Vision model can also be initialized similarly if needed:
        // if (this.baseConfig.visionModel) {
        //     this.generativeVisionModel = this._ensureClient() ? this.genAI.getGenerativeModel({ model: this.baseConfig.visionModel }) : null;
        // }
    }

    _getApiKey() {
        return this.apiKey || process.env.GEMINI_API_KEY;
    }

    _ensureClient() {
        if (this.genAI) {
            return true;
        }
        const apiKey = this._getApiKey();
        if (!apiKey) {
             console.warn("GeminiService: API key for Gemini is missing. Cannot initialize client.");
             return false;
        }
        try {
            // console.log("GeminiService: Initializing GoogleGenerativeAI client.");
            this.genAI = new GoogleGenerativeAI(apiKey);
            return true;
        } catch (error) {
            console.error(`GeminiService: Failed to initialize GoogleGenerativeAI client. Error: ${error.message}`);
            this.genAI = null; // Ensure it's null on failure
            // Optional: throw new Error(\`GeminiService client initialization failed: \${error.message}\`);
            return false;
        }
    }

    /**
     * @override
     */
    async generateText(promptString, params = {}) {
        if (!this._ensureClient()) {
            console.warn("GeminiService: Client not available. Returning stub for generateText.");
            return `GeminiService stub response for: ${promptString.substring(0, 50)}...`;
        }

        // Security: Validate model name from params against a list of known/allowed models for this service
        const allowedModels = ['gemini-1.5-pro-latest', 'gemini-1.5-pro', 'gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-pro', 'gemini-1.0-pro', 'gemini-1.0-pro-vision-latest'];
        let modelName = this.baseConfig.defaultModel || 'gemini-pro';
        if (params.model) {
            if (allowedModels.includes(params.model)) {
                modelName = params.model;
            } else {
                console.warn(`GeminiService: Requested model '${params.model}' is not in the allowed list. Using default: ${modelName}`);
            }
        }

        const temperature = params.temperature !== undefined ? params.temperature : this.baseConfig.temperature;
        const maxOutputTokens = params.maxTokens || this.baseConfig.maxTokens; // Let Gemini SDK use its default if undefined
        const stopSequences = params.stopSequences || this.baseConfig.stopSequences;
        const systemInstructionText = params.systemInstruction || this.baseConfig.systemInstruction;

        // Use cacheHandle if provided
        const cacheName = params.cacheHandle?.cacheName;

        // console.log(\`GeminiService (\${modelName}): Calling generateContent API. Prompt (first 100 chars): "\${String(promptString).substring(0,100)}...". CachedContent: \${cacheName || 'N/A'}\`);

        const requestPayload = {
            generationConfig: {},
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ],
        };

        if (temperature !== undefined) requestPayload.generationConfig.temperature = temperature;
        if (maxOutputTokens !== undefined) requestPayload.generationConfig.maxOutputTokens = maxOutputTokens;
        if (stopSequences && Array.isArray(stopSequences) && stopSequences.length > 0) {
            requestPayload.generationConfig.stopSequences = stopSequences;
        }

        if (systemInstructionText) {
            requestPayload.systemInstruction = { role: "system", parts: [{ text: systemInstructionText }] };
        }

        if (cacheName) {
            requestPayload.cachedContent = cacheName;
            requestPayload.contents = [{ role: "user", parts: [{ text: promptString }] }]; // Prompt is the new turn
        } else {
            requestPayload.contents = [{ role: "user", parts: [{ text: promptString }] }]; // Prompt is the full content
        }

        try {
            const modelInstance = this.genAI.getGenerativeModel({ model: modelName });

            const requestFn = () => modelInstance.generateContent(requestPayload);
            const result = await this._executeRequestWithRetry(
                requestFn,
                this.baseConfig.maxRetries || 3,
                this.baseConfig.initialRetryDelayMs || 1000,
                this.getServiceName()
            );
            const response = result.response;

            if (response && typeof response.text === 'function') {
                return response.text();
            } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return response.candidates[0].content.parts[0].text;
            } else {
                console.warn(`GeminiService (${modelName}): API response format error (after retries). No text found. Response:`, JSON.stringify(response, null, 2));
                throw new Error("Gemini API response format error (after retries): No text content found.");
            }
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (generateContent after retries):`, error.message, error.stack);
            throw new Error(`Gemini API Error (after retries): ${error.message}`);
        }
    }

    /**
     * @override
     */
    async completeChat(messagesArray, params = {}) {
        if (!this._ensureClient()) {
            console.warn("GeminiService: Client not available. Returning stub for completeChat.");
            return "GeminiService stub chat response.";
        }

        // Security: Validate model name from params (using the same logic as generateText)
        const allowedModels = ['gemini-1.5-pro-latest', 'gemini-1.5-pro', 'gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-pro', 'gemini-1.0-pro', 'gemini-1.0-pro-vision-latest'];
        let modelName = this.baseConfig.defaultModel || 'gemini-pro';
        if (params.model) {
            if (allowedModels.includes(params.model)) {
                modelName = params.model;
            } else {
                console.warn(`GeminiService: Requested model '${params.model}' is not in the allowed list for chat. Using default: ${modelName}`);
            }
        }

        const temperature = params.temperature !== undefined ? params.temperature : this.baseConfig.temperature;
        const maxOutputTokens = params.maxTokens || this.baseConfig.maxTokens;
        const stopSequences = params.stopSequences || this.baseConfig.stopSequences;
        let systemInstructionText = params.systemInstruction || this.baseConfig.systemInstruction;

        const cacheName = params.cacheHandle?.cacheName;

        // If cacheName is provided, use generateContent directly as ChatSession doesn't support cachedContent.
        if (cacheName) {
            // console.log(\`GeminiService (\${modelName}): Using cachedContent ('\${cacheName}') for chat. Making a direct generateContent call.\`);
            const newTurns = messagesArray.map(msg => ({
                role: msg.role === 'assistant' ? 'model' : msg.role,
                parts: [{ text: msg.content }]
            }));

            const requestPayload = {
                contents: newTurns,
                cachedContent: cacheName,
                generationConfig: {},
                safetySettings: [ /* ... safety settings ... */ ],
            };
            if (temperature !== undefined) requestPayload.generationConfig.temperature = temperature;
            if (maxOutputTokens !== undefined) requestPayload.generationConfig.maxOutputTokens = maxOutputTokens;
            if (stopSequences?.length) requestPayload.generationConfig.stopSequences = stopSequences;
            // System instruction might be part of cachedContent. If provided here, it might override or be an error depending on API.
            // For Gemini, system_instruction is part of the model or cachedContent itself.
            // If a new system instruction is provided with a cache, it might lead to complex behavior.
            // It's generally safer to bake system_instruction into the cache via prepareContextForModel.
            // If systemInstructionText is provided here AND cacheName exists, it's ambiguous.
            // For now, if cacheName exists, we assume systemInstruction is part of it or not applicable for override.

            try {
                const modelInstance = this.genAI.getGenerativeModel({ model: modelName });
                const requestFn = () => modelInstance.generateContent(requestPayload);
                const result = await this._executeRequestWithRetry(
                    requestFn,
                    this.baseConfig.maxRetries || 3,
                    this.baseConfig.initialRetryDelayMs || 1000,
                    this.getServiceName()
                );
                const response = result.response;
                if (response && typeof response.text === 'function') return response.text();
                if (response?.candidates?.[0]?.content?.parts?.[0]?.text) return response.candidates[0].content.parts[0].text;
                throw new Error("Gemini API chat response format error (with cache, after retries): No text content found.");
            } catch (error) {
                console.error(`GeminiService (${modelName}): Error during generateContent (with cache for chat, after retries):`, error.message, error.stack);
                throw new Error(`Gemini API Error (with cache for chat, after retries): ${error.message}`);
            }
        }

        // Standard chat session if no cacheName
        let chatHistoryForSDK = messagesArray.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role, // Convert 'assistant' to 'model'
            parts: [{ text: msg.content }]
        }));

        let currentSystemInstruction = undefined;
        if (systemInstructionText) {
            currentSystemInstruction = { role: "system", parts: [{text: systemInstructionText}] };
        } else if (chatHistoryForSDK.length > 0 && chatHistoryForSDK[0].role === 'system') {
            // SDK v0.10+ uses systemInstruction in getGenerativeModel, not as part of history
            // currentSystemInstruction = chatHistoryForSDK.shift();
        }


        // console.log(\`GeminiService (\${modelName}): Calling Chat API (no cache). History length: \${chatHistoryForSDK.length}\`);
        try {
            const generationConfig = {};
            if (temperature !== undefined) generationConfig.temperature = temperature;
            if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
            if (stopSequences?.length) generationConfig.stopSequences = stopSequences;

            const modelInstanceParams = {
                model: modelName,
                generationConfig,
                safetySettings: [ /* ... safety settings ... */ ]
            };
            if (currentSystemInstruction) {
                modelInstanceParams.systemInstruction = currentSystemInstruction;
            }

            const modelInstance = this.genAI.getGenerativeModel(modelInstanceParams);

            // For SDK v0.10+, history for startChat should not include the last user message if we send it via sendMessage.
            // It should also not include system instructions if passed at model level.
            const messagesForChatSDK = chatHistoryForSDK.filter(m => m.role !== 'system');
            let lastUserMessage = "";
            if (messagesForChatSDK.length > 0 && messagesForChatSDK[messagesForChatSDK.length -1].role === 'user') {
                 lastUserMessage = messagesForChatSDK.pop().parts[0].text;
            } else if (messagesForChatSDK.length === 0 && !lastUserMessage && !currentSystemInstruction) {
                // console.warn(`GeminiService (${modelName}): completeChat called with no user messages to respond to and no system instruction.`);
                 lastUserMessage = ""; // Allow sending empty message if history is also empty (e.g. to kick off with system prompt)
            }


            const chat = modelInstance.startChat({ history: messagesForChatSDK });

            const requestFn = () => chat.sendMessage(lastUserMessage);
            const result = await this._executeRequestWithRetry(
                requestFn,
                this.baseConfig.maxRetries || 3,
                this.baseConfig.initialRetryDelayMs || 1000,
                this.getServiceName()
            );
            const response = result.response;

            if (response && typeof response.text === 'function') return response.text();
            if (response?.candidates?.[0]?.content?.parts?.[0]?.text) return response.candidates[0].content.parts[0].text;
            throw new Error("Gemini API chat response format error (after retries): No text content found.");
        } catch (error) {
            console.error(`GeminiService (${modelName}): Error during Gemini API call (sendMessage/startChat, after retries):`, error.message, error.stack);
            throw new Error(`Gemini API Chat Error (after retries): ${error.message}`);
        }
    }

    /**
     * @override
     */
    getTokenizer(modelName = null) { // modelName is not used by current Gemini sync tokenizer
        if (!this.tokenizerWarningShown) {
            console.warn(`GeminiService.getTokenizer: Using approximate word count as tokenizer (for model: ${modelName || this.baseConfig.defaultModel || 'unknown'}). For precise token counts, use asynchronous model.countTokens() where possible or ensure context is managed conservatively.`);
            this.tokenizerWarningShown = true;
        }
        return (text) => {
            if (!text) return 0;
            return text.split(/\s+/).filter(Boolean).length; // Более точный подсчет слов
        };
    }

    /**
     * @override
     */
    getMaxContextTokens(modelName = null) {
        const modelNameToUse = modelName || this.baseConfig.defaultModel || 'default';
        // Абсолютный fallback, если ничего не найдено или не загружено
        let contextWindow = 30720;

        if (this.modelSpecs && this.modelSpecs.gemini) {
            const serviceSpecs = this.modelSpecs.gemini;
            let specToUse = null;

            if (serviceSpecs[modelNameToUse]) {
                specToUse = serviceSpecs[modelNameToUse];
            } else if (serviceSpecs.default) {
                specToUse = serviceSpecs.default;
                console.warn(`GeminiService.getMaxContextTokens: Model '${modelNameToUse}' not found in specs. Using default spec.`);
            } else {
                console.warn(`GeminiService.getMaxContextTokens: Model '${modelNameToUse}' and default spec not found. Using hardcoded fallback: ${contextWindow}`);
            }

            if (specToUse) {
                // Gemini 1.5 модели могут иметь 'effectiveContextWindow' для практического использования
                if (modelNameToUse.startsWith('gemini-1.5') && specToUse.effectiveContextWindow) {
                    contextWindow = specToUse.effectiveContextWindow;
                } else if (specToUse.contextWindow) {
                    contextWindow = specToUse.contextWindow;
                } else {
                     console.warn(`GeminiService.getMaxContextTokens: contextWindow not defined for '${modelNameToUse}' or default in specs. Using hardcoded fallback: ${contextWindow}`);
                }
            }
        } else {
            console.warn(`GeminiService.getMaxContextTokens: Model specs not loaded. Using hardcoded fallback: ${contextWindow}`);
        }
        // Дополнительное применение this.baseConfig.maxTokensForContext для Gemini 1.5 моделей, если оно было специфично задано
        if (modelNameToUse.startsWith('gemini-1.5') && this.baseConfig?.maxTokensForContext && this.baseConfig.maxTokensForContext < contextWindow) {
            // console.log(`GeminiService.getMaxContextTokens: Overriding spec-defined context window for ${modelNameToUse} with baseConfig.maxTokensForContext: ${this.baseConfig.maxTokensForContext}`);
            contextWindow = this.baseConfig.maxTokensForContext;
        }
        return contextWindow;
    }

    /**
     * @override
     */
    getServiceName() {
        return "Gemini";
    }

    /**
     * Internal method to create or update cached content.
     * @param {object} creationParams - Parameters for creating the cached content.
     * @param {string} creationParams.modelName - The model name for which this cache is intended (e.g., 'gemini-1.5-pro-latest').
     * @param {Array<object>} creationParams.contents - The content to be cached.
     * @param {object} [creationParams.systemInstruction] - Optional system instruction.
     * @param {number} [creationParams.ttlSeconds] - Optional Time-To-Live for the cache entry in seconds.
     * @param {string} [creationParams.displayName] - Optional display name for the cache.
     * @returns {Promise<object>} The full CachedContent object from the SDK.
     */
    async _createOrUpdateCachedContent(creationParams) {
        if (!this._ensureClient() || !this.genAI.embedContent) { // Check for a method that implies SDK v0.10+ structure, like embedContent or caches
             console.error("GeminiService._createOrUpdateCachedContent: genAI client is not available or not modern SDK version.");
             throw new Error("GeminiService: genAI client not initialized or incompatible SDK version for caching.");
        }

        const { modelName, contents, systemInstruction, ttlSeconds, displayName } = creationParams;

        if (!modelName || !Array.isArray(contents)) {
            throw new Error("GeminiService._createOrUpdateCachedContent: 'modelName' and 'contents' (array) are required.");
        }

        // Ensure modelName is correctly formatted (e.g., "models/gemini-1.5-pro-latest")
        // The SDK usually expects the plain model ID like "gemini-1.5-pro-latest" for getGenerativeModel,
        // but for cache creation, it might need the "models/" prefix.
        // The `createCachedContent` in the previous version of this file used `this.genAI.caches.create`.
        // Let's assume the model name needs the "models/" prefix for cache operations.
        const fullModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;

        const cacheCreationRequest = {
            model: fullModelName,
            contents: contents,
        };

        if (systemInstruction) { // systemInstruction should be { role: "system", parts: [{text: "..."}]}
            cacheCreationRequest.systemInstruction = systemInstruction;
        }
        if (ttlSeconds && typeof ttlSeconds === 'number' && ttlSeconds > 0) {
            cacheCreationRequest.ttl = { seconds: ttlSeconds }; // SDK format for TTL
        }
        if (displayName) {
            cacheCreationRequest.displayName = displayName;
        }

        try {
            // console.log(`GeminiService: Creating cached content for model ${fullModelName}. DisplayName: ${displayName || 'N/A'}`);
            // Assuming this.genAI is the top-level GenerativeModel instance from new GoogleGenerativeAI(apiKey)
            // and it has a .cachedContent property or similar for managing caches.
            // The exact SDK call might differ slightly based on version (e.g., this.genAI.cache() or this.genAI.cachedContent())
            // Based on previous `createCachedContent` it was `this.genAI.caches.create()`
            // This API seems to have changed in the SDK or was a misunderstanding.
            // The current Gemini SDK (e.g. @google/generative-ai v0.8.0+) has Content Caching on the model instance.
            // `this.genAI.getGenerativeModel({ model: modelName }).createCachedContent(...)`

            const modelInstanceForCache = this.genAI.getGenerativeModel({ model: modelName }); // Use plain model name here
            const cachedContentResult = await modelInstanceForCache.createCachedContent(cacheCreationRequest); // Pass the full request

            // console.log(`GeminiService: Cached content created successfully. Name: ${cachedContentResult.name}`);
            return cachedContentResult; // This is the CachedContent object
        } catch (error) {
            console.error(`GeminiService._createOrUpdateCachedContent: Error for model ${fullModelName}:`, error.message);
            throw new Error(`Gemini API Error (_createOrUpdateCachedContent): ${error.message}`);
        }
    }

    /**
     * @override
     */
    async prepareContextForModel(contextParts, options = {}) {
        if (!this._ensureClient()) {
            console.warn("GeminiService: Client not available for prepareContextForModel.");
            return null;
        }

        const { modelName, systemInstruction, cacheConfig = {} } = options;
        const { ttlSeconds, displayName /*, forceRecreate*/ } = cacheConfig; // taskId not directly used for API, but for managing multiple caches if needed by caller // forceRecreate removed

        if (!modelName) {
            throw new Error("GeminiService.prepareContextForModel: 'modelName' is required in options.");
        }

        // For Gemini, contextParts should be an array of Content objects,
        // e.g., [{ role: "user", parts: [{ text: "..." }] }, { role: "model", parts: [{ text: "..." }] }]
        // or a single string if it's simple user input to be wrapped.
        let sdkContents;
        if (typeof contextParts === 'string') {
            sdkContents = [{ role: "user", parts: [{ text: contextParts }] }];
        } else if (Array.isArray(contextParts)) {
            sdkContents = contextParts; // Assume it's already in the correct [{role, parts:[{text}]}] format
        } else {
            throw new Error("GeminiService.prepareContextForModel: 'contextParts' must be a string or an array of Gemini Content objects.");
        }

        // For now, we don't have a sophisticated cache look-up mechanism here.
        // We'll always try to create it. A true cache manager would check if identical content already exists.
        // The `forceRecreate` flag is more of a hint for such a manager.
        // The current OrchestratorAgent's planning phase creates a hash and checks MemoryManager.
        // This method simply exposes the underlying "create" capability.

        try {
            const creationParams = {
                modelName: modelName, // The model this cache will be used with
                contents: sdkContents,
            };
            if (systemInstruction) { // systemInstruction should be {role: "system", parts:[{text:"..."}]}
                 creationParams.systemInstruction = typeof systemInstruction === 'string' ? {role: "system", parts:[{text: systemInstruction}]} : systemInstruction;
            }
            if (ttlSeconds) creationParams.ttlSeconds = ttlSeconds;
            if (displayName) creationParams.displayName = displayName;

            const cachedContentResult = await this._createOrUpdateCachedContent(creationParams);

            if (cachedContentResult && cachedContentResult.name) {
                return {
                    cacheName: cachedContentResult.name, // e.g., "models/gemini-1.5-pro-latest/cachedContents/xxxx"
                    // Include other useful info from cachedContentResult if needed by the caller
                    model: cachedContentResult.model, // e.g., "models/gemini-1.5-pro-latest"
                    createTime: cachedContentResult.createTime,
                    expireTime: cachedContentResult.expireTime,
                };
            }
            return null;
        } catch (error) {
            console.error(`GeminiService.prepareContextForModel: Failed to prepare/cache context for model ${modelName}:`, error.message);
            // Don't re-throw, allow fallback to non-cached generation if desired by caller
            return null;
        }
    }
}

module.exports = GeminiService; // Use ES module export for consistency with BaseAIService
// export default GeminiService;
