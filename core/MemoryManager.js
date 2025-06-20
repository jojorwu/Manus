// core/MemoryManager.js
const fsp = require('fs').promises;
// const fs = require('fs'); // Removed as unused
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const MEMORY_BANK_DIR_NAME = 'memory_bank';
const MEGA_CONTEXT_CACHE_DIR_NAME = 'mega_context_cache';
const MEGA_CONTEXT_CACHE_VERSION = 'mcc-v1';
const CHAT_HISTORY_FILENAME = 'chat_messages.json';
const KEY_FINDINGS_FILENAME = 'key_findings.jsonl';

class MemoryManager {
    /**
     * @param {import('events').EventEmitter} [eventEmitter] - Optional event emitter instance.
     */
    constructor(eventEmitter = null) { // Modified to accept eventEmitter
        this.eventEmitter = eventEmitter;
    }

    _calculateObjectHash(obj) {
        const orderedObj = {};
        // Security: Ensure only own properties are accessed to prevent prototype pollution.
        Object.keys(obj).sort().forEach(key => {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                // eslint-disable-next-line security/detect-object-injection -- 'key' is from Object.keys(obj) and validated with hasOwnProperty. orderedObj is a fresh local object.
                orderedObj[key] = obj[key];
            }
        });
        const str = JSON.stringify(orderedObj);
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    async _getFileContentHash(filePath) {
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath in this internal method is expected to be pre-validated if from untrusted source. Currently unused.
            const content = await fsp.readFile(filePath, 'utf8');
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
            if (error.code === 'ENOENT') return `FILE_NOT_FOUND:${path.basename(filePath)}`;
            console.warn(`MemoryManager: Error reading file ${filePath} for hashing: ${error.message}`);
            return `ERROR_READING_FILE:${path.basename(filePath)}`;
        }
    }

    _getTaskMemoryBankPath(taskDirPath) {
        if (!taskDirPath || typeof taskDirPath !== 'string' || taskDirPath.trim() === '') {
            throw new Error("MemoryManager: taskDirPath must be a non-empty string.");
        }
        return path.join(taskDirPath, MEMORY_BANK_DIR_NAME);
    }

    _getMegaContextCachePath(taskDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskDirPath);
        return path.join(memoryBankPath, MEGA_CONTEXT_CACHE_DIR_NAME);
    }

    _getCacheFilePath(cacheDir, cacheKey) {
        return path.join(cacheDir, `${cacheKey.substring(0, 32)}.json`);
    }

    getMemoryFilePath(taskDirPath, memoryCategoryFileName) {
        if (!memoryCategoryFileName || typeof memoryCategoryFileName !== 'string' || memoryCategoryFileName.trim() === '') {
             throw new Error("MemoryManager: memoryCategoryFileName must be a non-empty string.");
        }
        // Sanitize memoryCategoryFileName to prevent path traversal or use of unsafe characters.
        // This is a basic sanitization; more complex rules might be needed depending on expected inputs.
        // It aims to allow typical filenames, including those with extensions and subdirectories (e.g., 'uploaded_files/image.png').
        const sanitizedFileName = memoryCategoryFileName
            .split('/') // Split by directory separator
            .map(part => part.replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 255)) // Sanitize each part
            .join('/'); // Rejoin

        if (sanitizedFileName !== memoryCategoryFileName) {
            console.warn(`MemoryManager: memoryCategoryFileName was sanitized from "${memoryCategoryFileName}" to "${sanitizedFileName}".`);
        }

        const memoryBankPath = this._getTaskMemoryBankPath(taskDirPath);
        const finalPath = path.join(memoryBankPath, sanitizedFileName);

        // Final check to ensure the path does not escape the memoryBankPath
        if (!finalPath.startsWith(memoryBankPath)) {
            throw new Error(`MemoryManager: Invalid memoryCategoryFileName "${memoryCategoryFileName}" results in path traversal attempt.`);
        }
        return finalPath;
    }

    async initializeTaskMemory(taskDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskDirPath);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- memoryBankPath is derived from system-controlled taskDirPath.
        await fsp.mkdir(memoryBankPath, { recursive: true });
        const chatHistoryPath = this.getMemoryFilePath(taskDirPath, CHAT_HISTORY_FILENAME);
        try {
            await fsp.access(chatHistoryPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.overwriteMemory(taskDirPath, CHAT_HISTORY_FILENAME, [], { isJson: true });
            } else {
                throw error;
            }
        }
    }

    async loadMemory(taskDirPath, memoryCategoryFileName, options = {}) {
        const { isJson = false, defaultValue = null } = options;
        const filePath = this.getMemoryFilePath(taskDirPath, memoryCategoryFileName);
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is pre-sanitized by this.getMemoryFilePath().
            const content = await fsp.readFile(filePath, 'utf8');
            return isJson ? JSON.parse(content) : content;
        } catch (error) {
            const filePathForLog = filePath || path.join(this._getTaskMemoryBankPath(taskDirPath), memoryCategoryFileName); // На случай если filePath не успел определиться
            if (error.code === 'ENOENT') {
                // console.warn(`MemoryManager.loadMemory: File not found '${filePathForLog}'. Returning default value.`); // Можно добавить, если нужно часто видеть
                return defaultValue;
            } else if (['EACCES', 'EPERM'].includes(error.code)) {
                console.error(`MemoryManager.loadMemory: Permission denied for file '${filePathForLog}'. Code: ${error.code}. Returning default value.`);
                return defaultValue;
            } else if (error.code === 'ENOSPC') {
                console.error(`MemoryManager.loadMemory: No space left on device for file '${filePathForLog}'. Code: ${error.code}. Returning default value.`);
                return defaultValue;
            } else if (error.code === 'EMFILE') {
                console.error(`MemoryManager.loadMemory: Too many open files when trying to access '${filePathForLog}'. Code: ${error.code}. Returning default value.`);
                return defaultValue;
            } else if (error.code === 'EIO') {
                console.error(`MemoryManager.loadMemory: I/O error accessing file '${filePathForLog}'. Code: ${error.code}. Returning default value.`);
                return defaultValue;
            }
            // Для остальных ошибок - пробрасываем дальше
            console.error(`MemoryManager.loadMemory: Unhandled FS error for file '${filePathForLog}'. Code: ${error.code || 'N/A'}. Rethrowing.`);
            throw error;
        }
    }

    async overwriteMemory(taskDirPath, memoryCategoryFileName, newContent, options = {}) {
        const { isJson = false } = options;
        if (newContent === undefined) return;

        const memoryBankPath = this._getTaskMemoryBankPath(taskDirPath);
        const filePath = this.getMemoryFilePath(taskDirPath, memoryCategoryFileName); // Define filePath before try block

        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- memoryBankPath is derived from system-controlled taskDirPath.
            await fsp.mkdir(memoryBankPath, { recursive: true });
            const contentToWrite = isJson ? JSON.stringify(newContent, null, 2) : String(newContent);
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is pre-sanitized by this.getMemoryFilePath().
            await fsp.writeFile(filePath, contentToWrite, 'utf8');
        } catch (error) {
            const filePathForLog = filePath || path.join(this._getTaskMemoryBankPath(taskDirPath), memoryCategoryFileName);
            let errorMessage = `MemoryManager.overwriteMemory: Failed to write to file '${filePathForLog}'.`;

            if (error.code === 'EACCES' || error.code === 'EPERM') {
                errorMessage += ` Permission denied. Code: ${error.code}.`;
            } else if (error.code === 'ENOSPC') {
                errorMessage += ` No space left on device. Code: ${error.code}.`;
            } else if (error.code === 'EMFILE') {
                errorMessage += ` Too many open files. Code: ${error.code}.`;
            } else if (error.code === 'EIO') {
                errorMessage += ` I/O error. Code: ${error.code}.`;
            } else {
                errorMessage += ` Unhandled FS error. Code: ${error.code || 'N/A'}.`;
            }
            // Логируем оригинальную ошибку для полной трассировки
            console.error(errorMessage, error);
            // Пробрасываем новую ошибку с более контекстным сообщением
            throw new Error(errorMessage);
        }
    }

    async addChatMessage(taskDirPath, messageData) {
        if (!taskDirPath) throw new Error("taskDirPath is required.");
        if (!messageData || !messageData.senderId || !messageData.content || typeof messageData.content.text !== 'string') {
            throw new Error("Invalid messageData: senderId and content.text are required.");
        }
        await this.initializeTaskMemory(taskDirPath);
        let history = await this.loadMemory(taskDirPath, CHAT_HISTORY_FILENAME, { isJson: true, defaultValue: [] });
        if (!Array.isArray(history)) {
            console.warn(`MemoryManager.addChatMessage: Chat history for ${taskDirPath} was not an array. Resetting.`);
            history = [];
        }
        let role = messageData.role;
        if (!role) {
            if (messageData.senderId.toLowerCase().includes('agent') || messageData.senderId.toLowerCase().includes('bot')) role = 'assistant';
            else if (messageData.senderId.toLowerCase() === 'system') role = 'system';
            else role = 'user';
        }
        const taskIdFromPath = path.basename(taskDirPath).replace('task_', '');
        const newMessage = {
            id: `msg_${uuidv4()}`,
            taskId: messageData.taskId || taskIdFromPath,
            sender: { id: messageData.senderId, role: role },
            timestamp: new Date().toISOString(),
            content: messageData.content,
            clientMessageId: messageData.clientMessageId,
            relatedToMessageId: messageData.relatedToMessageId,
        };
        history.push(newMessage);
        await this.overwriteMemory(taskDirPath, CHAT_HISTORY_FILENAME, history, { isJson: true });

        // Emit event after successful save
        if (this.eventEmitter) {
            this.eventEmitter.emit('newMessage', newMessage);
        }
        return newMessage;
    }

    async getChatHistory(taskDirPath, options = {}) {
        // ... (no changes to this method's logic from previous version)
        const { since_timestamp, limit, sort_order = 'asc' } = options;
        if (!taskDirPath) { return []; }
        let history = await this.loadMemory(taskDirPath, CHAT_HISTORY_FILENAME, { isJson: true, defaultValue: [] });
        if (!Array.isArray(history)) { return []; }
        if (since_timestamp) {
            try { const sinceDate = new Date(since_timestamp); history = history.filter(msg => new Date(msg.timestamp) > sinceDate); }
            catch (e) { console.warn(`MM.getChatHistory: Invalid since_timestamp '${since_timestamp}'.`); }
        }
        history.sort((a, b) => { const dateA = new Date(a.timestamp); const dateB = new Date(b.timestamp); return sort_order === 'asc' ? dateA - dateB : dateB - dateA; });
        if (limit !== undefined) { const numLimit = parseInt(limit, 10); if (!isNaN(numLimit) && numLimit > 0) { history = sort_order === 'asc' ? history.slice(-numLimit) : history.slice(0, numLimit); }}
        return history;
    }

    _getSummaryFilePath(originalMemoryFilePath) { /* ... no change ... */
        const dir = path.dirname(originalMemoryFilePath);
        const filename = path.basename(originalMemoryFilePath);
        const parts = filename.split('.');
        const ext = parts.length > 1 ? '.' + parts.pop() : '';
        const base = parts.join('.');
        return path.join(dir, `${base}_summary${ext}`);
    }
    _getSummaryMetaFilePath(summaryFilePath) { /* ... no change ... */
        const dir = path.dirname(summaryFilePath);
        const filename = path.basename(summaryFilePath);
        return path.join(dir, `${filename}.meta.json`);
    }
    async getSummarizedMemory(taskDirPath, memoryCategoryFileName, aiService, summarizationOptions = {}) { /* ... no change ... */
        const { maxOriginalLength = 3000, promptTemplate = "Summarize this text concisely, focusing on key information: {text_to_summarize}", llmParams = {}, cacheSummary = true, forceSummarize = false, defaultValue = null } = summarizationOptions;
        const originalFilePath = this.getMemoryFilePath(taskDirPath, memoryCategoryFileName);
        let originalContent;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- originalFilePath is pre-sanitized by this.getMemoryFilePath().
        try { originalContent = await fsp.readFile(originalFilePath, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return defaultValue; throw error; }
        const currentOriginalHash = this._calculateHash(originalContent);
        if (!currentOriginalHash) throw new Error("MM: Could not hash original content.");
        const summaryFilePath = this._getSummaryFilePath(originalFilePath);
        const summaryMetaFilePath = this._getSummaryMetaFilePath(summaryFilePath);
        if (!forceSummarize && originalContent.length <= maxOriginalLength) return originalContent;
        if (cacheSummary && !forceSummarize) {
            try {
                // eslint-disable-next-line security/detect-non-literal-fs-filename -- summaryMetaFilePath is derived from a sanitized path.
                const metaContent = JSON.parse(await fsp.readFile(summaryMetaFilePath, 'utf8'));
                if (metaContent.originalContentHash === currentOriginalHash) {
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- summaryFilePath is derived from a sanitized path.
                    return await fsp.readFile(summaryFilePath, 'utf8');
                }
            }
            catch (error) { if (error.code !== 'ENOENT') console.warn(`MM: Error checking summary cache for '${memoryCategoryFileName}': ${error.message}.`); }
        }
        if (!aiService || typeof aiService.generateText !== 'function') throw new Error("aiService with generateText method is required for summarization.");
        const prompt = promptTemplate.replace('{text_to_summarize}', originalContent.substring(0, maxOriginalLength * 2));
        const effectiveLlmParams = { model: (llmParams.model) || (aiService.baseConfig?.summarizationModel) || 'gpt-3.5-turbo', ...llmParams };
        try {
            const summaryContent = await aiService.generateText(prompt, effectiveLlmParams);
            if (cacheSummary) {
                try { await this.overwriteMemory(taskDirPath, path.basename(summaryFilePath), summaryContent); await this.overwriteMemory(taskDirPath, path.basename(summaryMetaFilePath), { originalContentHash: currentOriginalHash, summaryGeneratedTimestamp: new Date().toISOString() }, { isJson: true }); }
                catch (writeError) { console.error(`MM: Failed to cache summary for '${memoryCategoryFileName}': ${writeError.message}`); }
            }
            return summaryContent;
        } catch (llmError) { throw new Error(`Failed to summarize '${memoryCategoryFileName}': ${llmError.message}`); }
    }
    async assembleMegaContext(taskDirPath, contextSpecification, tokenizerCompatibleWithLLM) { /* ... no change ... */
        const { systemPrompt = null, includeTaskDefinition = false, uploadedFilePaths = [], maxLatestKeyFindings = 0, keyFindingsRelevanceQuery = null, /* includeRawContentForReferencedFindings = true, */ chatHistory = [], maxTokenLimit, priorityOrder = ['systemPrompt', 'chatHistory', 'uploadedFilePaths', 'taskDefinition', 'keyFindings'], customPreamble = "Use the following information context:\n--- BEGIN CONTEXT ---", customPostamble = "--- END CONTEXT ---", recordSeparator = "\n\n--- Next Record ---\n", findingSeparator = "\n---\n", /* currentProgressSummary, currentNextObjective, recentErrorsSummary, summarizedKeyFindingsText, overallExecutionSuccess, executionContext, */ originalUserTask, enableMegaContextCache = true, megaContextCacheTTLSeconds = null } = contextSpecification || {};
        if (typeof maxTokenLimit !== 'number' || maxTokenLimit <= 0) return { success: false, error: "maxTokenLimit must be a positive number."};
        if (typeof tokenizerCompatibleWithLLM !== 'function') return { success: false, error: "tokenizerCompatibleWithLLM must be a function."};
        let cacheKey, cacheDir, cacheFilePath;
        if (enableMegaContextCache) {
            const cacheKeyData = { version: MEGA_CONTEXT_CACHE_VERSION, spec: { systemPrompt, maxTokenLimit, priorityOrder } };
            cacheKey = this._calculateObjectHash(cacheKeyData); cacheDir = this._getMegaContextCachePath(taskDirPath); cacheFilePath = this._getCacheFilePath(cacheDir, cacheKey);
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheFilePath is derived from a hash and system paths.
            try { const cachedData = JSON.parse(await fsp.readFile(cacheFilePath, 'utf8')); if (cachedData.contextString && typeof cachedData.tokenCount === 'number' && cachedData.timestamp) { if (!megaContextCacheTTLSeconds || (new Date().getTime() - new Date(cachedData.timestamp).getTime()) / 1000 <= megaContextCacheTTLSeconds) { return { success: true, contextString: cachedData.contextString, tokenCount: cachedData.tokenCount, fromCache: true }; } } }
            catch (error) { if (error.code !== 'ENOENT') console.warn(`MM.assembleMegaContext: Error reading cache: ${error.message}`); }
        }
        const contextParts = []; let currentTokenCount = 0; const countTokens = (text) => text ? tokenizerCompatibleWithLLM(text) : 0;
        const addPartToContext = (partContent, isCritical = false) => { if (!partContent || typeof partContent !== 'string' || !partContent.trim()) return true; const partTokens = countTokens(partContent); if (currentTokenCount + partTokens <= remainingTokenBudget) { contextParts.push(partContent); currentTokenCount += partTokens; return true; } else if (isCritical) throw new Error(`Critical context part too large: ${partContent.substring(0,50)}...`); return false; };
        let remainingTokenBudget = maxTokenLimit - countTokens(customPreamble) - countTokens(customPostamble) - countTokens(recordSeparator)*(priorityOrder.length-1);

        // Security: Define allowed content types to prevent injection if priorityOrder is manipulated.
        const allowedContentTypes = new Set(['systemPrompt', 'originalUserTask', 'currentWorkingContext', 'taskDefinition', 'chatHistory', 'uploadedFilePaths', 'keyFindings']);

        for (const contentType of priorityOrder) {
            if (!allowedContentTypes.has(contentType)) {
                console.warn(`MemoryManager.assembleMegaContext: Skipping disallowed contentType "${contentType}" in priorityOrder.`);
                continue;
            }
            if (remainingTokenBudget <= 0) break;
            let contentToAdd = "";
            switch (contentType) {
                 case 'systemPrompt': if (systemPrompt) contentToAdd = systemPrompt; break;
                 case 'originalUserTask': if(originalUserTask) contentToAdd = `Original User Task:\n${originalUserTask}`; break;
                 // Ensure contextSpecification itself is not from untrusted source or validate its keys if necessary.
                 // Assuming contextSpecification.currentWorkingContext is safe for now.
                 case 'currentWorkingContext': if(contextSpecification && Object.prototype.hasOwnProperty.call(contextSpecification, 'currentWorkingContext') && contextSpecification.currentWorkingContext) contentToAdd = `Current Working Context:\n${contextSpecification.currentWorkingContext}`; break;
                 case 'taskDefinition': if (includeTaskDefinition) contentToAdd = await this.loadMemory(taskDirPath, 'task_definition.md', {defaultValue: ''}); if (contentToAdd) contentToAdd = `Task Definition:\n${contentToAdd}`; break;
                 case 'chatHistory': if (chatHistory?.length) contentToAdd = "Chat History (newest first):\n" + chatHistory.map(m => `${m.role}: ${m.content}`).join('\n---\n'); break;
                 case 'uploadedFilePaths': if (uploadedFilePaths?.length) { let filesContent = ""; for (const relPath of uploadedFilePaths) { try { filesContent += `Document: ${path.basename(relPath)}\nContent:\n${await this.loadMemory(taskDirPath, relPath, {defaultValue: '(empty)'})}\n\n`; } catch(e){ console.warn(`Failed to load uploaded file ${relPath}`); }} contentToAdd = filesContent.trim(); } break;
                 case 'keyFindings': if (maxLatestKeyFindings > 0 && typeof this.getLatestKeyFindings === 'function') { const findings = await this.getLatestKeyFindings(taskDirPath, maxLatestKeyFindings, keyFindingsRelevanceQuery); if (findings?.length) contentToAdd = "Key Findings:\n" + findings.map(f => `${f.sourceStepNarrative}: ${JSON.stringify(f.data)}`).join(findingSeparator); } break;
            }
            if (!addPartToContext(contentToAdd, contentType === 'systemPrompt')) break;
        }
        let finalContextString = customPreamble + "\n" + contextParts.join(recordSeparator) + "\n" + customPostamble;
        const finalTokenCount = countTokens(finalContextString);
        if (finalTokenCount > maxTokenLimit) return { success: false, error: "Assembled context exceeds token limit.", tokenCount: finalTokenCount };
        if (enableMegaContextCache && cacheKey && cacheFilePath) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is derived from system paths.
            try { await fsp.mkdir(cacheDir, { recursive: true });
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheFilePath is derived from a hash and system paths.
            await fsp.writeFile(cacheFilePath, JSON.stringify({ contextString: finalContextString, tokenCount: finalTokenCount, timestamp: new Date().toISOString() }, null, 2), 'utf8'); } catch (cacheWriteError) { console.warn(`MM.assembleMegaContext: Error writing to cache: ${cacheWriteError.message}`); }}
        return { success: true, contextString: finalContextString, tokenCount: finalTokenCount, fromCache: false };
    }
    async getLatestKeyFindings(taskDirPath, limit = 5, relevanceQuery = null) {
        if (!taskDirPath) {
            console.warn("MemoryManager.getLatestKeyFindings: taskDirPath is required.");
            return [];
        }
        try {
            const filePath = this.getMemoryFilePath(taskDirPath, KEY_FINDINGS_FILENAME);
            let fileContent;
            try {
                fileContent = await fsp.readFile(filePath, 'utf8');
            } catch (readError) {
                if (readError.code === 'ENOENT') {
                    return []; // No findings file yet
                }
                throw readError; // Other read errors should be propagated or logged
            }

            if (!fileContent.trim()) {
                return [];
            }

            const lines = fileContent.trim().split('\n');
            let findings = [];
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    findings.push(JSON.parse(line));
                } catch (parseError) {
                    console.warn(`MemoryManager.getLatestKeyFindings: Skipping corrupted line in ${filePath}: ${parseError.message}`);
                }
            }

            // Filter by relevanceQuery if provided
            if (relevanceQuery && typeof relevanceQuery === 'string' && relevanceQuery.trim() !== "") {
                const query = relevanceQuery.toLowerCase();
                findings = findings.filter(finding => {
                    const narrativeMatch = finding.sourceStepNarrative && finding.sourceStepNarrative.toLowerCase().includes(query);
                    let dataMatch = false;
                    if (finding.data) {
                        try {
                            const dataString = (typeof finding.data === 'string') ? finding.data : JSON.stringify(finding.data);
                            dataMatch = dataString.toLowerCase().includes(query);
                        } catch (e) { /* ignore stringify errors for filtering */ }
                    }
                    return narrativeMatch || dataMatch;
                });
            }

            // Sort by timestamp (descending - newest first)
            findings.sort((a, b) => {
                const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return timeB - timeA;
            });

            return findings.slice(0, limit);

        } catch (error) {
            console.error(`MemoryManager.getLatestKeyFindings: Failed to get key findings for task ${taskDirPath}`, error);
            return []; // Return empty on error to prevent breaking callers
        }
    }

    async saveKeyFinding(taskDirPath, keyFinding) {
        if (!taskDirPath || !keyFinding) {
            console.error("MemoryManager.saveKeyFinding: taskDirPath and keyFinding are required.");
            return;
        }
        try {
            const filePath = this.getMemoryFilePath(taskDirPath, KEY_FINDINGS_FILENAME);
            // Ensure directory exists (getMemoryFilePath ensures the base memory_bank,
            // but if KEY_FINDINGS_FILENAME implies subdirs, this is safer)
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            const findingJsonString = JSON.stringify(keyFinding);
            await fsp.appendFile(filePath, findingJsonString + '\n', 'utf8');
        } catch (error) {
            console.error(`MemoryManager.saveKeyFinding: Failed to save key finding for task ${taskDirPath}`, error);
            // Do not re-throw, as saving a key finding might be non-critical for plan execution flow
        }
    }

    async loadGeminiCachedContentMap(taskDirPath) {
        return this.loadMemory(taskDirPath, 'gemini_cached_content_map.json', { isJson: true, defaultValue: {} });
    }
    async saveGeminiCachedContentMap(taskDirPath, mapData) {
        await this.overwriteMemory(taskDirPath, 'gemini_cached_content_map.json', mapData, { isJson: true });
    }
}
module.exports = MemoryManager;
