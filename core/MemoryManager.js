// core/MemoryManager.js
const fsp = require('fs').promises;
const fs = require('fs'); // For sync operations if needed (e.g. existsSync, though fsp.access is better for async checks)
const path = require('path');
const crypto = require('crypto'); // Added for hashing

const MEMORY_BANK_DIR_NAME = 'memory_bank';
const MEGA_CONTEXT_CACHE_DIR_NAME = 'mega_context_cache'; // For caching assembleMegaContext results
const MEGA_CONTEXT_CACHE_VERSION = 'mcc-v1'; // Cache version, increment to invalidate all old caches
const CHAT_HISTORY_FILENAME = 'chat_history.json'; // Filename for storing chat history

class MemoryManager {
    constructor() {
        // Constructor might be used for configuration in the future
    }

    /**
     * Calculates a stable SHA256 hash for a JavaScript object.
     * Keys are sorted before stringification to ensure hash consistency.
     * @param {object} obj - The object to hash.
     * @returns {string} The hexadecimal SHA256 hash of the object.
     * @private
     */
    _calculateObjectHash(obj) {
        const orderedObj = {};
        Object.keys(obj).sort().forEach(key => {
            if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                orderedObj[key] = obj[key];
            } else {
                orderedObj[key] = obj[key];
            }
        });
        const str = JSON.stringify(orderedObj);
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    /**
     * Calculates the SHA256 hash of a file's content.
     * Returns a special string if the file is not found or if there's a read error,
     * ensuring these states contribute uniquely to any cache key derived from this hash.
     * @param {string} filePath - The full path to the file.
     * @returns {Promise<string>} The hexadecimal SHA256 hash or an error/status string.
     * @private
     */
    async _getFileContentHash(filePath) {
        try {
            const content = await fsp.readFile(filePath, 'utf8');
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return `FILE_NOT_FOUND:${path.basename(filePath)}`;
            }
            console.warn(`MemoryManager: Error reading file ${filePath} for hashing: ${error.message}`);
            return `ERROR_READING_FILE:${path.basename(filePath)}`;
        }
    }

    /**
     * Gets the path to the mega_context_cache directory for a given task.
     * @param {string} taskStateDirPath - The full path to the task's state directory.
     * @returns {string} The path to the mega_context_cache directory.
     * @private
     */
    _getMegaContextCachePath(taskStateDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        return path.join(memoryBankPath, MEGA_CONTEXT_CACHE_DIR_NAME);
    }

    /**
     * Constructs the full file path for a cache entry.
     * @param {string} cacheDir - The directory where caches are stored.
     * @param {string} cacheKey - The unique key for the cache entry (typically a hash).
     * @returns {string} The full path to the cache file.
     * @private
     */
    _getCacheFilePath(cacheDir, cacheKey) {
        return path.join(cacheDir, `${cacheKey.substring(0, 32)}.json`);
    }

    _getTaskMemoryBankPath(taskStateDirPath) {
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            const errMsg = "MemoryManager: taskStateDirPath (full path to task's state directory) must be a non-empty string.";
            console.error(errMsg);
            throw new Error(errMsg);
        }
        return path.join(taskStateDirPath, MEMORY_BANK_DIR_NAME);
    }

    getMemoryFilePath(taskStateDirPath, memoryCategoryFileName) {
        if (!memoryCategoryFileName || typeof memoryCategoryFileName !== 'string' || memoryCategoryFileName.trim() === '') {
             const errMsg = "MemoryManager: memoryCategoryFileName must be a non-empty string.";
             console.error(errMsg);
             throw new Error(errMsg);
        }
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        return path.join(memoryBankPath, memoryCategoryFileName);
    }

    async initializeTaskMemory(taskStateDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        try {
            await fsp.mkdir(memoryBankPath, { recursive: true });
        } catch (error) {
            throw error;
        }
    }

    async loadMemory(taskStateDirPath, memoryCategoryFileName, options = {}) {
        const { isJson = false, defaultValue = null } = options;
        let filePath;
        try {
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            const content = await fsp.readFile(filePath, 'utf8');
            return isJson ? JSON.parse(content) : content;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return defaultValue;
            }
            throw error;
        }
    }

    async appendToMemory(taskStateDirPath, memoryCategoryFileName, contentToAppend) {
        if (contentToAppend === undefined || contentToAppend === null) {
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            await fsp.appendFile(filePath, String(contentToAppend) + '\n', 'utf8');
        } catch (error) {
            throw error;
        }
    }

    async overwriteMemory(taskStateDirPath, memoryCategoryFileName, newContent, options = {}) {
        const { isJson = false } = options;
        if (newContent === undefined) {
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            const contentToWrite = isJson ? JSON.stringify(newContent, null, 2) : String(newContent);
            await fsp.writeFile(filePath, contentToWrite, 'utf8');
        } catch (error) {
            throw error;
        }
    }

    _calculateHash(content) {
        if (typeof content !== 'string') {
            return null;
        }
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    _getSummaryFilePath(originalMemoryFilePath) {
        const dir = path.dirname(originalMemoryFilePath);
        const ext = path.extname(originalMemoryFilePath);
        const base = path.basename(originalMemoryFilePath, ext);
        return path.join(dir, `${base}_summary${ext}`);
    }

    async getSummarizedMemory(taskStateDirPath, memoryCategoryFileName, aiService, summarizationOptions = {}) {
        const {
            maxOriginalLength = 3000,
            promptTemplate = "Summarize this text concisely, focusing on key information: {text_to_summarize}",
            llmParams = {},
            cacheSummary = true,
            forceSummarize = false,
            defaultValue = null
        } = summarizationOptions;

        const originalFilePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
        let originalContent;

        try {
            originalContent = await fsp.readFile(originalFilePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return defaultValue;
            throw error;
        }

        const currentOriginalHash = this._calculateHash(originalContent);
        if (!currentOriginalHash) throw new Error("MemoryManager: Could not calculate hash for original content.");

        const summaryFilePath = this._getSummaryFilePath(originalFilePath);
        const summaryMetaFilePath = this._getSummaryMetaFilePath(summaryFilePath);

        if (!forceSummarize && originalContent.length <= maxOriginalLength) return originalContent;

        if (cacheSummary && !forceSummarize) {
            try {
                const metaContent = JSON.parse(await fsp.readFile(summaryMetaFilePath, 'utf8'));
                if (metaContent.originalContentHash === currentOriginalHash) {
                    return await fsp.readFile(summaryFilePath, 'utf8');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`MemoryManager: Error checking summary cache for '${memoryCategoryFileName}': ${error.message}. Will attempt to regenerate.`);
            }
        }

        if (!aiService || typeof aiService.generateText !== 'function') {
            throw new Error("aiService is required for summarization and must have a generateText method.");
        }
        const prompt = promptTemplate.replace('{text_to_summarize}', originalContent);
        const effectiveLlmParams = {
            model: (llmParams && llmParams.model) || (aiService.baseConfig && aiService.baseConfig.summarizationModel) || 'gpt-3.5-turbo',
            ...llmParams
        };

        try {
            const summaryContent = await aiService.generateText(prompt, effectiveLlmParams);
            if (cacheSummary) {
                try {
                    await this.overwriteMemory(taskStateDirPath, path.basename(summaryFilePath), summaryContent);
                    await this.overwriteMemory(taskStateDirPath, path.basename(summaryMetaFilePath), { originalContentHash: currentOriginalHash, summaryGeneratedTimestamp: new Date().toISOString() }, { isJson: true });
                } catch (writeError) {
                    console.error(`MemoryManager: Failed to cache summary or meta for '${memoryCategoryFileName}': ${writeError.message}`);
                }
            }
            return summaryContent;
        } catch (llmError) {
            throw new Error(`Failed to summarize '${memoryCategoryFileName}': ${llmError.message}`);
        }
    }

    _getSummaryMetaFilePath(summaryFilePath) {
        return `${summaryFilePath}.meta.json`;
    }

    /**
     * Assembles a comprehensive context string from various sources within a specified token budget.
     * This method incorporates caching: it first attempts to read from a cache using a key derived
     * from the context specification and content hashes. If a valid cache entry is found, it's returned.
     * Otherwise, the context is assembled fresh and, if caching is enabled for the call, written to the cache.
     *
     * @param {string} taskStateDirPath - The full path to the task's state directory.
     * @param {object} contextSpecification - Object detailing what to include in the context.
     * @param {string|null} [contextSpecification.systemPrompt=null] - System message for the LLM, prepended to the context.
     * @param {boolean} [contextSpecification.includeTaskDefinition=false] - Whether to load and include 'task_definition.md'.
     * @param {string[]} [contextSpecification.uploadedFilePaths=[]] - Array of paths to user-uploaded files (relative to the task's memory bank) to include.
     * @param {number} [contextSpecification.maxLatestKeyFindings=0] - How many recent key findings to include. Findings are processed newest first.
     * @param {boolean} [contextSpecification.includeRawContentForReferencedFindings=true] - If a key finding references raw content (e.g., a file path), attempt to load and include that raw content. If false or loading fails, uses finding's preview or data.
     * @param {object[]} [contextSpecification.chatHistory=[]] - Array of chat message objects (e.g., `{role: 'user', content: '...'}`). These are typically processed newest first for inclusion.
     * @param {number} contextSpecification.maxTokenLimit - The absolute maximum number of tokens for the assembled context string (including preambles, postambles, separators).
     * @param {string[]} [contextSpecification.priorityOrder=['systemPrompt', 'chatHistory', 'uploadedFilePaths', 'taskDefinition', 'keyFindings']] - Order in which context parts are added. Processing stops if token budget is exceeded.
     * @param {string} [contextSpecification.customPreamble="Use the following information..."] - Text to prepend to the entire assembled context.
     * @param {string} [contextSpecification.customPostamble="--- END CONTEXT ---"] - Text to append to the entire assembled context.
     * @param {string} [contextSpecification.recordSeparator="\n\n--- Next Record ---\n"] - Separator used between major context records.
     * @param {string} [contextSpecification.findingSeparator="\n---\n"] - Separator used within a complex key finding.
     * @param {string} [contextSpecification.currentProgressSummary] - (Optional) Current summary of progress.
     * @param {string} [contextSpecification.currentNextObjective] - (Optional) Current next objective.
     * @param {object[]} [contextSpecification.recentErrorsSummary] - (Optional) Summary of recent errors.
     * @param {string} [contextSpecification.summarizedKeyFindingsText] - (Optional) Pre-summarized key findings.
     * @param {boolean} [contextSpecification.overallExecutionSuccess] - (Optional) Overall success status of the last execution.
     * @param {object[]} [contextSpecification.executionContext] - (Optional) Execution context (history of steps).
     * @param {string} [contextSpecification.originalUserTask] - (Optional) Original user task string.
     * @param {boolean} [contextSpecification.enableMegaContextCache=true] - If false, caching for this specific call is skipped.
     * @param {number|null} [contextSpecification.megaContextCacheTTLSeconds=null] - Time-to-live for the cache entry in seconds. If null, cache does not expire based on time.
     * @param {Function} tokenizerCompatibleWithLLM - A function that takes a string and returns its token count.
     * @returns {Promise<object>} An object: `{ success: Boolean, contextString?: String, tokenCount?: Number, error?: String, fromCache?: boolean }`.
     */
    async assembleMegaContext(taskStateDirPath, contextSpecification, tokenizerCompatibleWithLLM) {
        const {
            systemPrompt = null,
            includeTaskDefinition = false,
            uploadedFilePaths = [],
            maxLatestKeyFindings = 0,
            includeRawContentForReferencedFindings = true,
            chatHistory = [],
            maxTokenLimit,
            priorityOrder = ['systemPrompt', 'chatHistory', 'uploadedFilePaths', 'taskDefinition', 'keyFindings'],
            customPreamble = "Use the following information to answer the subsequent question or complete the task:\n--- BEGIN CONTEXT ---",
            customPostamble = "--- END CONTEXT ---",
            recordSeparator = "\n\n--- Next Record ---\n",
            findingSeparator = "\n---\n",
            currentProgressSummary, currentNextObjective, recentErrorsSummary, summarizedKeyFindingsText, overallExecutionSuccess,
            executionContext, originalUserTask,
            enableMegaContextCache = true,
            megaContextCacheTTLSeconds = null
        } = contextSpecification || {};

        if (typeof maxTokenLimit !== 'number' || maxTokenLimit <= 0) {
            return { success: false, error: "maxTokenLimit must be a positive number.", tokenCount: 0 };
        }
        if (typeof tokenizerCompatibleWithLLM !== 'function') {
            return { success: false, error: "tokenizerCompatibleWithLLM must be a function.", tokenCount: 0 };
        }

        let cacheKey, cacheDir, cacheFilePath;

        if (enableMegaContextCache) {
            // --- Cache Key Generation ---
            const cacheKeyData = {
                version: MEGA_CONTEXT_CACHE_VERSION,
                spec: {
                    systemPrompt, includeTaskDefinition, maxLatestKeyFindings, includeRawContentForReferencedFindings,
                    maxTokenLimit, priorityOrder, customPreamble, customPostamble, recordSeparator, findingSeparator,
                    currentProgressSummary, currentNextObjective, summarizedKeyFindingsText, overallExecutionSuccess,
                    originalUserTask
                },
                fileHashes: {}, keyFindingHashes: [], chatHistoryHashes: [], executionContextHash: null
            };

            if (includeTaskDefinition) {
                const tdPath = this.getMemoryFilePath(taskStateDirPath, 'task_definition.md');
                cacheKeyData.fileHashes['task_definition.md'] = await this._getFileContentHash(tdPath);
            }
            for (const relPath of uploadedFilePaths) {
                const fullPath = this.getMemoryFilePath(taskStateDirPath, relPath);
                cacheKeyData.fileHashes[relPath] = await this._getFileContentHash(fullPath);
            }
            if (maxLatestKeyFindings > 0 && typeof this.getLatestKeyFindings === 'function') {
                const findings = await this.getLatestKeyFindings(taskStateDirPath, maxLatestKeyFindings);
                for (const finding of findings) {
                    let findingDataToHash = finding.id || '';
                    if (typeof finding.data === 'string') findingDataToHash += `_str:${finding.data.substring(0,1000)}`;
                    else if (finding.data?.type === 'reference_to_raw_content' && finding.data.rawContentPath && includeRawContentForReferencedFindings) {
                        const rawPath = this.getMemoryFilePath(taskStateDirPath, finding.data.rawContentPath);
                        findingDataToHash += `_ref:${await this._getFileContentHash(rawPath)}`;
                    } else findingDataToHash += `_json:${JSON.stringify(finding.data)}`;
                    cacheKeyData.keyFindingHashes.push(crypto.createHash('sha256').update(findingDataToHash).digest('hex'));
                }
            }
            if (chatHistory?.length > 0) {
                chatHistory.forEach(msg => cacheKeyData.chatHistoryHashes.push(this._calculateObjectHash(msg)));
            }
            if (executionContext && Array.isArray(executionContext)) {
                cacheKeyData.executionContextHash = this._calculateObjectHash(executionContext);
            }

            cacheKey = this._calculateObjectHash(cacheKeyData);
            cacheDir = this._getMegaContextCachePath(taskStateDirPath);
            cacheFilePath = this._getCacheFilePath(cacheDir, cacheKey);

            // --- Cache Read Attempt ---
            try {
                const cachedData = JSON.parse(await fsp.readFile(cacheFilePath, 'utf8'));
                if (cachedData.contextString && typeof cachedData.tokenCount === 'number' && cachedData.timestamp) {
                    if (megaContextCacheTTLSeconds && (new Date().getTime() - new Date(cachedData.timestamp).getTime()) / 1000 > megaContextCacheTTLSeconds) {
                        console.log(`MemoryManager.assembleMegaContext: Cache expired for key ${cacheKey}. Regenerating.`);
                    } else {
                        console.log(`MemoryManager.assembleMegaContext: Cache hit for key ${cacheKey}. Returning cached data.`);
                        return { success: true, contextString: cachedData.contextString, tokenCount: cachedData.tokenCount, fromCache: true };
                    }
                }
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`MemoryManager.assembleMegaContext: Error reading cache file ${cacheFilePath}. Regenerating. Error: ${error.message}`);
            }
        } else {
            console.log("MemoryManager.assembleMegaContext: Caching is disabled. Assembling fresh context.");
        }

        const contextParts = [];
        let currentTokenCount = 0;
        const countTokens = (text) => {
            try { return tokenizerCompatibleWithLLM(text); }
            catch (e) { console.error("MemoryManager.assembleMegaContext: Tokenizer function failed.", e); throw new Error("Tokenizer function failed."); }
        };

        try {
            const addPartToContext = (partContent, isCritical = false) => {
                const partTokens = countTokens(partContent);
                if (partTokens <= remainingTokenBudget) {
                    contextParts.push(partContent); currentTokenCount += partTokens; remainingTokenBudget -= partTokens; return true;
                } else if (isCritical) throw new Error(`Critical context part too large (tokens: ${partTokens}, budget: ${remainingTokenBudget}).`);
                return false;
            };

            const preambleText = customPreamble + "\n\n";
            const postambleText = "\n\n" + customPostamble;
            let remainingTokenBudget = maxTokenLimit - countTokens(preambleText) - countTokens(postambleText);
            if (remainingTokenBudget < 0) return { success: false, error: "maxTokenLimit too small for pre/postamble."};

            for (const contentType of priorityOrder) {
                if (remainingTokenBudget <= 0) break;
                const getSeparator = () => (contextParts.length > 0 || (systemPrompt && contentType !== 'systemPrompt')) ? recordSeparator : "";

                switch (contentType) {
                    case 'systemPrompt': if (systemPrompt) addPartToContext(systemPrompt + "\n", true); break;
                    case 'chatHistory':
                        if (chatHistory?.length) for (let i = chatHistory.length - 1; i >= 0; i--) {
                            if (remainingTokenBudget <= 0) break;
                            if (!addPartToContext(getSeparator() + `${chatHistory[i].role}: ${chatHistory[i].content}`)) break;
                        } break;
                    case 'uploadedFilePaths':
                        if (uploadedFilePaths?.length) for (const filePath of uploadedFilePaths) {
                            if (remainingTokenBudget <= 0) break; try {
                                const content = await this.loadMemory(taskStateDirPath, filePath, { defaultValue: null });
                                if (content) addPartToContext(getSeparator() + `Document: ${path.basename(filePath)}\nContent:\n${content}`);
                            } catch (e) { console.warn(`Failed to load uploaded file ${filePath}: ${e.message}`); }
                        } break;
                    case 'taskDefinition':
                        if (includeTaskDefinition && remainingTokenBudget > 0) try {
                            const content = await this.loadMemory(taskStateDirPath, 'task_definition.md', { defaultValue: null });
                            if (content) addPartToContext(getSeparator() + `Task Definition:\n${content}`);
                        } catch (e) { console.warn(`Failed to load task_definition.md: ${e.message}`);}
                        break;
                    case 'originalUserTask': if (originalUserTask && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Original User Task:\n${originalUserTask}`); break;
                    case 'currentProgressSummary': if (currentProgressSummary && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Current Progress Summary:\n${currentProgressSummary}`); break;
                    case 'currentNextObjective': if (currentNextObjective && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Current Next Objective:\n${currentNextObjective}`); break;
                    case 'summarizedKeyFindingsText': if (summarizedKeyFindingsText && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Summarized Key Findings:\n${summarizedKeyFindingsText}`); break;
                    case 'recentErrorsSummary': if (recentErrorsSummary?.length && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Recent Errors Encountered:\n${JSON.stringify(recentErrorsSummary, null, 2)}`); break;
                    case 'overallExecutionSuccess': if (typeof overallExecutionSuccess === 'boolean' && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Overall Execution Success of Last Attempt: ${overallExecutionSuccess}`); break;
                    case 'executionContext': if (executionContext?.length && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Execution Context (History):\n${JSON.stringify(executionContext, null, 2)}`); break;
                    case 'keyFindings':
                        if (maxLatestKeyFindings > 0 && typeof this.getLatestKeyFindings === 'function') {
                            const findings = await this.getLatestKeyFindings(taskStateDirPath, maxLatestKeyFindings);
                            for (const finding of findings.reverse()) { if (remainingTokenBudget <= 0) break;
                                let findingContentText = "";
                                if (includeRawContentForReferencedFindings && finding.data?.type === 'reference_to_raw_content' && finding.data.rawContentPath) {
                                    try { findingContentText = await this.loadMemory(taskStateDirPath, finding.data.rawContentPath, {defaultValue:null}) || finding.data.preview || JSON.stringify(finding.data); }
                                    catch (e) { console.warn(`Failed to load raw content for finding ${finding.id || finding.data.rawContentPath}: ${e.message}`); findingContentText = finding.data.preview || JSON.stringify(finding.data); }
                                } else findingContentText = typeof finding.data === 'string' ? finding.data : (finding.data?.preview || JSON.stringify(finding.data));
                                if (!addPartToContext(getSeparator() + `Key Finding (ID: ${finding.id || 'N/A'}, Tool: ${finding.sourceToolName || 'N/A'}):${findingSeparator}${findingContentText}`)) break;
                            }
                        } break;
                }
            }

            let finalContextString = preambleText + contextParts.join("") + postambleText;
            const finalTokenCount = countTokens(finalContextString);

            if (finalTokenCount > maxTokenLimit) {
                console.warn(`MemoryManager.assembleMegaContext: Final context (tokens: ${finalTokenCount}) exceeds limit (${maxTokenLimit}).`);
                return { success: false, error: "Assembled context exceeds token limit.", tokenCount: finalTokenCount };
            }

            if (enableMegaContextCache && cacheKey && cacheDir && cacheFilePath) {
                try {
                    await fsp.mkdir(cacheDir, { recursive: true });
                    await fsp.writeFile(cacheFilePath, JSON.stringify({ contextString: finalContextString, tokenCount: finalTokenCount, timestamp: new Date().toISOString() }, null, 2), 'utf8');
                    console.log(`MemoryManager.assembleMegaContext: Saved to cache. Path: ${cacheFilePath}`);
                } catch (cacheWriteError) {
                    console.warn(`MemoryManager.assembleMegaContext: Error writing to cache ${cacheFilePath}: ${cacheWriteError.message}`);
                }
            }
            return { success: true, contextString: finalContextString, tokenCount: finalTokenCount, fromCache: false };
        } catch (error) {
            console.error("MemoryManager.assembleMegaContext: Critical error during context assembly.", error);
            return { success: false, error: error.message, tokenCount: currentTokenCount };
        }
    }

    /**
     * Adds a message to the chat history for a given task.
     * Chat history is stored in 'chat_history.json' within the task's memory bank.
     * @param {string} taskStateDirPath - The full path to the task's state directory.
     * @param {object} message - The message object to add.
     * @param {string} message.role - The role of the message sender (e.g., 'user', 'assistant').
     * @param {string} message.content - The content of the message.
     * @param {string} [message.timestamp] - Optional timestamp for the message (ISO string). Defaults to current time.
     * @returns {Promise<void>}
     * @throws {Error} If taskStateDirPath or message is invalid.
     */
    async addChatMessage(taskStateDirPath, message) {
        if (!message || typeof message.role !== 'string' || typeof message.content !== 'string') {
            throw new Error("Invalid message object. 'role' and 'content' are required strings.");
        }

        let history = await this.loadMemory(taskStateDirPath, CHAT_HISTORY_FILENAME, { isJson: true, defaultValue: [] });

        if (!Array.isArray(history)) {
            console.warn(`MemoryManager.addChatMessage: Chat history file for task ${taskStateDirPath} was corrupted or not an array. Resetting to empty history.`);
            history = [];
        }

        const newMessage = {
            role: message.role,
            content: message.content,
            timestamp: message.timestamp || new Date().toISOString()
        };
        history.push(newMessage);

        await this.overwriteMemory(taskStateDirPath, CHAT_HISTORY_FILENAME, history, { isJson: true });
    }

    /**
     * Retrieves the chat history for a given task.
     * @param {string} taskStateDirPath - The full path to the task's state directory.
     * @param {number} [limit] - Optional. If provided, returns only the last 'limit' messages.
     * @returns {Promise<Array<object>>} An array of chat message objects. Returns an empty array if history doesn't exist or is corrupted.
     */
    async getChatHistory(taskStateDirPath, limit = undefined) {
        let history = await this.loadMemory(taskStateDirPath, CHAT_HISTORY_FILENAME, { isJson: true, defaultValue: [] });

        if (!Array.isArray(history)) {
            console.warn(`MemoryManager.getChatHistory: Chat history file for task ${taskStateDirPath} was corrupted or not an array. Returning empty history.`);
            history = [];
        }

        if (limit !== undefined && typeof limit === 'number' && limit > 0) {
            return history.slice(-limit);
        }
        return history;
    }
}

module.exports = MemoryManager;
