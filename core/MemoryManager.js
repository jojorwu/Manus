// core/MemoryManager.js
const fsp = require('fs').promises;
const fs = require('fs'); // For sync operations if needed (e.g. existsSync, though fsp.access is better for async checks)
const path = require('path');
const crypto = require('crypto'); // Added for hashing

const MEMORY_BANK_DIR_NAME = 'memory_bank';

class MemoryManager {
    constructor() {
        // Constructor might be used for configuration in the future
    }

    _getTaskMemoryBankPath(taskStateDirPath) {
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            // It's critical that taskStateDirPath is valid.
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
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath); // Will throw if taskStateDirPath is invalid
        return path.join(memoryBankPath, memoryCategoryFileName);
    }

    async initializeTaskMemory(taskStateDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        try {
            await fsp.mkdir(memoryBankPath, { recursive: true });
            // console.log(`MemoryManager: Initialized memory bank for task at ${memoryBankPath}`); // Using t() function later
        } catch (error) {
            // console.error(`MemoryManager: Error initializing memory bank at ${memoryBankPath}:`, error);
            // Log with t() later
            throw error;
        }
    }

    async getSummarizedRecords(taskStateDirPath, recordInputs, aiService, summarizationOptions = {}) {
        // 1. Input Validation
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            throw new Error("MemoryManager.getSummarizedRecords: taskStateDirPath must be a non-empty string.");
        }
        if (!Array.isArray(recordInputs) || recordInputs.some(item => {
            if (!item || typeof item.id !== 'string' || item.id.trim() === '' || !item.type) {
                return true;
            }
            if (item.type === 'path' && (typeof item.path !== 'string' || item.path.trim() === '')) {
                return true;
            }
            if (item.type === 'content' && typeof item.content !== 'string') { // Allow empty string content
                return true;
            }
            if (item.type !== 'path' && item.type !== 'content') {
                return true;
            }
            return false;
        })) {
            throw new Error("MemoryManager.getSummarizedRecords: recordInputs must be an array of objects, each with id, type ('path' or 'content'), and corresponding 'path' or 'content'.");
        }
        if (!aiService || typeof aiService.generateText !== 'function') {
            throw new Error("MemoryManager.getSummarizedRecords: aiService is required and must have a generateText method.");
        }

        const {
            promptTemplate = "Summarize the following collection of records into a single, coherent overview:\n\n{combined_content}\n\nOverall Summary:",
            recordSeparator = "\n\n--- Record: {identifier} ---\n",
            maxCombinedLength = 75000,
            individualSummarizationOptions = {},
            llmParams = {},
            ttlSeconds = null // For cache TTL
        } = summarizationOptions;

        // --- Caching Logic Start ---
        const cacheSubDir = 'batch_summaries_cache';
        let recordInfoForCacheKey = [];

        // Create a sorted list of record inputs by id for stable cache key generation
        const sortedRecordInputsForCacheKey = [...recordInputs].sort((a, b) => a.id.localeCompare(b.id));

        for (const recordInput of sortedRecordInputsForCacheKey) {
            let contentHash;
            if (recordInput.type === 'path') {
                const content = await this.loadMemory(taskStateDirPath, recordInput.path, { isJson: false, defaultValue: null });
                contentHash = content !== null ? this._calculateHash(content) : "FILE_NOT_FOUND_HASH";
            } else { // type === 'content'
                contentHash = this._calculateHash(recordInput.content);
            }
            recordInfoForCacheKey.push({ id: recordInput.id, contentHash });
        }

        const relevantOptionsForCache = {
            promptTemplate,
            recordSeparator,
            maxCombinedLength,
            individualPrompt: individualSummarizationOptions.promptTemplate, // Only include key parts
            individualMaxOriginalLength: individualSummarizationOptions.maxOriginalLength,
            model: llmParams.model, // Only include key parts
            temperature: llmParams.temperature,
            // ttlSeconds from main options is used for cache *retrieval*, not part of key that defines the content itself
        };
        const optionsString = this._stableStringify(relevantOptionsForCache);
        const optionsHash = this._calculateHash(optionsString);

        const combinedInfoForCacheKey = this._stableStringify(recordInfoForCacheKey) + ":" + optionsHash;
        const cacheKey = this._calculateHash(combinedInfoForCacheKey);

        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        const cacheDirPath = path.join(memoryBankPath, cacheSubDir);
        const cacheFilePath = path.join(cacheDirPath, cacheKey + '.json');

        try {
            const cachedDataString = await fsp.readFile(cacheFilePath, 'utf8');
            const cachedData = JSON.parse(cachedDataString);
            if (cachedData && cachedData.summary) {
                if (ttlSeconds !== null && typeof cachedData.timestamp === 'string') {
                    const cacheTimestamp = new Date(cachedData.timestamp).getTime();
                    if (Date.now() > cacheTimestamp + (ttlSeconds * 1000)) {
                        console.log(`MemoryManager.getSummarizedRecords: Cache expired for key ${cacheKey}.`);
                    } else {
                        console.log(`MemoryManager.getSummarizedRecords: Cache hit for key ${cacheKey}.`);
                        return cachedData.summary;
                    }
                } else if (ttlSeconds === null) { // No TTL, cache is valid if it exists
                    console.log(`MemoryManager.getSummarizedRecords: Cache hit (no TTL) for key ${cacheKey}.`);
                    return cachedData.summary;
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`MemoryManager.getSummarizedRecords: Error reading cache file ${cacheFilePath}. Error: ${error.message}`);
            }
        }
        // --- Caching Logic End: Cache Miss or Invalid/Expired ---

        // 2. Load Content
        const loadedContents = [];
        let totalRawContentLength = 0;

        for (const recordInput of recordInputs) { // Iterate original recordInputs to preserve order for main logic
            let contentToProcess = null;
            let originalPathForSummarization = null; // Only if type is 'path'

            try {
                if (recordInput.type === 'path') {
                    originalPathForSummarization = recordInput.path;
                    contentToProcess = await this.loadMemory(taskStateDirPath, recordInput.path, { isJson: false, defaultValue: null });
                } else { // type === 'content'
                    contentToProcess = recordInput.content;
                }

                if (contentToProcess !== null) {
                    loadedContents.push({
                        id: recordInput.id,
                        content: contentToProcess,
                        originalType: recordInput.type, // Keep track of original type
                        originalPath: originalPathForSummarization // Store path if applicable
                    });
                    totalRawContentLength += contentToProcess.length;
                } else {
                    console.warn(`MemoryManager.getSummarizedRecords: Content not found or empty for record id: ${recordInput.id} (type: ${recordInput.type}${recordInput.type === 'path' ? ', path: ' + recordInput.path : ''})`);
                }
            } catch (error) {
                console.error(`MemoryManager.getSummarizedRecords: Error processing record id: ${recordInput.id}: ${error.message}`);
            }
        }

        if (loadedContents.length === 0) {
            return "No content found for the provided record inputs to summarize.";
        }

        // 3. Prepare Combined Content for LLM
        let finalCombinedContentString = "";

        if (totalRawContentLength < maxCombinedLength) {
            console.log(`MemoryManager.getSummarizedRecords: Combining full content of ${loadedContents.length} records (total length: ${totalRawContentLength}).`);
            finalCombinedContentString = loadedContents.map(record => {
                return recordSeparator.replace('{identifier}', record.id) + record.content;
            }).join('');
        } else {
            console.log(`MemoryManager.getSummarizedRecords: Total raw content length ${totalRawContentLength} exceeds maxCombinedLength ${maxCombinedLength}. Summarizing records individually.`);
            const individualSummaries = [];
            for (const record of loadedContents) {
                try {
                    let summary;
                    const individualOpts = {
                        promptTemplate: "Summarize this text concisely: {text_to_summarize}",
                        ...(individualSummarizationOptions || {})
                    };

                    if (record.originalType === 'path') {
                        summary = await this.getSummarizedMemory(taskStateDirPath, record.originalPath, aiService, individualOpts);
                    } else { // 'content'
                        // Check if content itself needs summarization based on a length threshold
                        const maxIndivLength = individualOpts.maxOriginalLength || 3000; // Default similar to getSummarizedMemory
                        if (record.content.length <= maxIndivLength && !individualOpts.forceSummarize) {
                             summary = record.content;
                        } else {
                            const prompt = (individualOpts.customPromptTemplate || individualOpts.promptTemplate).replace('{text_to_summarize}', record.content);
                            summary = await aiService.generateText(prompt, individualOpts.llmParams || {});
                        }
                    }
                    individualSummaries.push({ id: record.id, content: summary });
                } catch (error) {
                    console.error(`MemoryManager.getSummarizedRecords: Error summarizing individual record ${record.id}: ${error.message}. Using raw content as fallback if short, or placeholder.`);
                    const fallbackMaxLength = individualSummarizationOptions?.maxOriginalLength || 3000;
                    if (record.content.length < fallbackMaxLength) {
                        individualSummaries.push({ id: record.id, content: record.content });
                    } else {
                        individualSummaries.push({ id: record.id, content: `[Content of record ${record.id} was too long and individual summarization failed]`});
                    }
                }
            }
            finalCombinedContentString = individualSummaries.map(record => {
                return recordSeparator.replace('{identifier}', record.id) + record.content;
            }).join('');
        }

        // 4. Final Batch Summarization (remains largely the same)
        const finalPrompt = promptTemplate.replace('{combined_content}', finalCombinedContentString);

        let overallSummary;
        try {
            console.log(`MemoryManager.getSummarizedRecords: Performing final batch summarization.`);
            overallSummary = await aiService.generateText(finalPrompt, llmParams);
        } catch (error) {
            console.error(`MemoryManager.getSummarizedRecords: Error during final batch summarization: ${error.message}`);
            throw new Error(`Failed to generate overall summary: ${error.message}`);
        }

        // --- Cache Write Logic ---
        try {
            await fsp.mkdir(cacheDirPath, { recursive: true });
            const dataToCache = {
                summary: overallSummary,
                timestamp: new Date().toISOString(),
                sourceRecordInputs: recordInputs, // Store original recordInputs
                optionsUsed: relevantOptionsForCache,
                cacheKeyUsed: cacheKey
            };
            await fsp.writeFile(cacheFilePath, this._stableStringify(dataToCache), 'utf8');
            console.log(`MemoryManager.getSummarizedRecords: Saved new summary to cache for key ${cacheKey}.`);
        } catch (error) {
            console.error(`MemoryManager.getSummarizedRecords: Failed to write to cache file ${cacheFilePath}. Error: ${error.message}`);
        }

        return overallSummary;
    }

    _stableStringify(obj) { // Keep this helper method
        const allKeys = new Set();
        JSON.stringify(obj, (key, value) => {
            if (typeof value !== 'function') { // Functions can't be reliably stringified/compared
                allKeys.add(key);
            }
            return value;
        });
        return JSON.stringify(obj, Array.from(allKeys).sort());
    }

    async saveRawContent(taskStateDirPath, content, sourceIdentifier, customMetadata = {}) {
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            throw new Error("MemoryManager.saveRawContent: taskStateDirPath must be a non-empty string.");
        }
        if (typeof content !== 'string') { // Assuming content should be a string
            throw new Error("MemoryManager.saveRawContent: content must be a string.");
        }
        if (!sourceIdentifier || typeof sourceIdentifier !== 'string' || sourceIdentifier.trim() === '') {
            throw new Error("MemoryManager.saveRawContent: sourceIdentifier must be a non-empty string.");
        }

        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            const rawContentDir = path.join(memoryBankPath, 'raw_content');
            await fsp.mkdir(rawContentDir, { recursive: true });

            const sourceIdentifierHash = this._calculateHash(sourceIdentifier);
            if (!sourceIdentifierHash) {
                 throw new Error("MemoryManager.saveRawContent: Could not calculate hash for sourceIdentifier.");
            }

            const contentFileName = `raw_${sourceIdentifierHash}.dat`;
            const metadataFileName = `raw_${sourceIdentifierHash}.meta.json`;

            // Relative paths for the return value and metadata storage
            const relativeContentPath = path.join('raw_content', contentFileName);
            const relativeMetadataPath = path.join('raw_content', metadataFileName);

            // Absolute paths for file operations
            const absoluteContentPath = path.join(rawContentDir, contentFileName);
            const absoluteMetadataPath = path.join(rawContentDir, metadataFileName);

            // Save the raw content
            // Using fsp.writeFile directly as overwriteMemory expects a memoryCategoryFileName relative to memoryBankPath
            await fsp.writeFile(absoluteContentPath, content, 'utf8');

            // Create and save metadata
            const contentHash = this._calculateHash(content);
            if (!contentHash) {
                throw new Error("MemoryManager.saveRawContent: Could not calculate hash for content.");
            }

            const metadata = {
                sourceIdentifier,
                savedTimestamp: new Date().toISOString(),
                contentHash,
                customMetadata,
                contentFilePath: relativeContentPath
            };

            // Use fsp.writeFile for metadata as well, ensuring JSON stringification
            await fsp.writeFile(absoluteMetadataPath, JSON.stringify(metadata, null, 2), 'utf8');

            return {
                contentPath: relativeContentPath,
                metadataPath: relativeMetadataPath
            };

        } catch (error) {
            console.error(`MemoryManager.saveRawContent: Error saving raw content for source '${sourceIdentifier}':`, error);
            throw error; // Re-throw the error after logging
        }
    }

    async loadMemory(taskStateDirPath, memoryCategoryFileName, options = {}) {
        const { isJson = false, defaultValue = null } = options;
        let filePath;
        try {
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            const content = await fsp.readFile(filePath, 'utf8');
            // console.log(`MemoryManager: Loaded memory '${memoryCategoryFileName}'.`); // Use t()
            return isJson ? JSON.parse(content) : content;
        } catch (error) {
            if (error.code === 'ENOENT') {
                // console.log(`MemoryManager: Memory file '${filePath || memoryCategoryFileName}' not found. Returning default value.`); // Use t()
                return defaultValue;
            }
            // console.error(`MemoryManager: Error loading memory from ${filePath || memoryCategoryFileName}:`, error); // Use t()
            throw error;
        }
    }

    async appendToMemory(taskStateDirPath, memoryCategoryFileName, contentToAppend) {
        if (contentToAppend === undefined || contentToAppend === null) {
            // console.warn("MemoryManager: appendToMemory called with null or undefined content. Skipping append."); // Use t()
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            await fsp.appendFile(filePath, String(contentToAppend) + '\n', 'utf8');
            // console.log(`MemoryManager: Appended to memory '${memoryCategoryFileName}'.`); // Use t()
        } catch (error) {
            // console.error(`MemoryManager: Error appending to memory ${filePath || memoryCategoryFileName}:`, error); // Use t()
            throw error;
        }
    }

    async overwriteMemory(taskStateDirPath, memoryCategoryFileName, newContent, options = {}) {
        const { isJson = false } = options;
        if (newContent === undefined) { // Allow null to be written (e.g. for JSON)
            // console.warn("MemoryManager: overwriteMemory called with undefined newContent. Skipping overwrite."); // Use t()
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);

            const contentToWrite = isJson ? JSON.stringify(newContent, null, 2) : String(newContent);

            await fsp.writeFile(filePath, contentToWrite, 'utf8');
            // console.log(`MemoryManager: Overwritten memory '${memoryCategoryFileName}'.`); // Use t()
        } catch (error) {
            // console.error(`MemoryManager: Error overwriting memory ${filePath || memoryCategoryFileName}:`, error); // Use t()
            throw error;
        }
    }

    async getCachedOrFetch(taskStateDirPath, cacheCategory, cacheKey, fetchFunction, options = {}) {
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            throw new Error("MemoryManager.getCachedOrFetch: taskStateDirPath must be a non-empty string.");
        }
        if (!cacheCategory || typeof cacheCategory !== 'string' || cacheCategory.trim() === '') {
            throw new Error("MemoryManager.getCachedOrFetch: cacheCategory must be a non-empty string.");
        }
        if (!cacheKey || typeof cacheKey !== 'string' || cacheKey.trim() === '') {
            throw new Error("MemoryManager.getCachedOrFetch: cacheKey must be a non-empty string.");
        }
        if (typeof fetchFunction !== 'function') {
            throw new Error("MemoryManager.getCachedOrFetch: fetchFunction must be a function.");
        }

        const {
            isJson = true,
            ttlSeconds = null,
            cacheSubDir = 'cache'
        } = options;

        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        const cacheDirPath = path.join(memoryBankPath, cacheSubDir, cacheCategory);

        const sanitizedCacheKey = cacheKey.replace(/[^a-zA-Z0-9_.-]/g, '_');

        const dataFileName = sanitizedCacheKey + (isJson ? '.json' : '.dat');
        const metadataFileName = dataFileName + '.meta.json';

        const dataFilePath = path.join(cacheDirPath, dataFileName);
        const metadataFilePath = path.join(cacheDirPath, metadataFileName);

        let metadata;
        try {
            const metadataContent = await fsp.readFile(metadataFilePath, 'utf8');
            metadata = JSON.parse(metadataContent);

            if (ttlSeconds !== null && typeof metadata.timestamp === 'string') {
                const cacheTimestamp = new Date(metadata.timestamp).getTime();
                const now = Date.now();
                if (now > cacheTimestamp + (ttlSeconds * 1000)) {
                    console.log(`MemoryManager.getCachedOrFetch: Cache expired for ${cacheCategory}/${cacheKey}.`);
                    metadata = null;
                }
            } else if (ttlSeconds !== null && typeof metadata.timestamp !== 'string') {
                // Invalid timestamp in metadata, treat as miss for TTL'd entries
                console.warn(`MemoryManager.getCachedOrFetch: Invalid timestamp in metadata for ${cacheCategory}/${cacheKey}. Treating as cache miss.`);
                metadata = null;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`MemoryManager.getCachedOrFetch: Error reading metadata for ${cacheCategory}/${cacheKey}. Will fetch fresh. Error: ${error.message}`);
            }
            metadata = null;
        }

        if (metadata) {
            try {
                const cachedDataContent = await fsp.readFile(dataFilePath, 'utf8');
                console.log(`MemoryManager.getCachedOrFetch: Cache hit for ${cacheCategory}/${cacheKey}.`);
                return isJson ? JSON.parse(cachedDataContent) : cachedDataContent;
            } catch (error) {
                console.warn(`MemoryManager.getCachedOrFetch: Error reading cached data for ${cacheCategory}/${cacheKey} despite valid metadata. Will fetch fresh. Error: ${error.message}`);
            }
        }

        console.log(`MemoryManager.getCachedOrFetch: Cache miss or invalid for ${cacheCategory}/${cacheKey}. Fetching fresh data.`);
        const freshData = await fetchFunction();

        try {
            await fsp.mkdir(cacheDirPath, { recursive: true });
            const contentToCache = isJson ? JSON.stringify(freshData, null, 2) : String(freshData);
            await fsp.writeFile(dataFilePath, contentToCache, 'utf8');

            const newMetadata = {
                timestamp: new Date().toISOString(),
                cacheKey: cacheKey, // Store the original, non-sanitized cacheKey
                category: cacheCategory,
                ttlSeconds: ttlSeconds,
                isJson: isJson,
                dataFileName: dataFileName // For reference
            };
            await fsp.writeFile(metadataFilePath, JSON.stringify(newMetadata, null, 2), 'utf8');
            console.log(`MemoryManager.getCachedOrFetch: Cached fresh data for ${cacheCategory}/${cacheKey}.`);
        } catch (error) {
            console.error(`MemoryManager.getCachedOrFetch: Failed to write cache for ${cacheCategory}/${cacheKey}. Error: ${error.message}`);
        }

        return freshData;
    }

    _calculateHash(content) {
        if (typeof content !== 'string') {
            // console.warn("MemoryManager:_calculateHash: Content is not a string, cannot calculate hash."); // use t()
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
            customPromptTemplate, // Added customPromptTemplate
            promptTemplate: defaultPromptTemplate = "Summarize this text concisely, focusing on key information: {text_to_summarize}", // Renamed to avoid conflict
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
            if (error.code === 'ENOENT') {
                return defaultValue;
            }
            throw error;
        }

        const currentOriginalHash = this._calculateHash(originalContent);
        if (!currentOriginalHash) {
            throw new Error("MemoryManager: Could not calculate hash for original content.");
        }

        const summaryFilePath = this._getSummaryFilePath(originalFilePath);
        const summaryMetaFilePath = this._getSummaryMetaFilePath(summaryFilePath);

        if (!forceSummarize && originalContent.length <= maxOriginalLength) {
            return originalContent;
        }

        if (cacheSummary && !forceSummarize) {
            try {
                const metaContentString = await fsp.readFile(summaryMetaFilePath, 'utf8');
                const metaContent = JSON.parse(metaContentString);
                if (metaContent.originalContentHash === currentOriginalHash) {
                    // console.log(`MemoryManager: Found valid cached summary for '${memoryCategoryFileName}' based on hash.`); // use t()
                    return await fsp.readFile(summaryFilePath, 'utf8');
                } else {
                    // console.log(`MemoryManager: Hash mismatch for cached summary of '${memoryCategoryFileName}'. Will regenerate.`); // use t()
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    // console.warn(`MemoryManager: Error checking summary cache for '${memoryCategoryFileName}': ${error.message}. Will attempt to regenerate.`); // use t()
                }
            }
        }

        // console.log(`MemoryManager: Summarizing content of '${memoryCategoryFileName}'...`); // use t()
        if (!aiService || typeof aiService.generateText !== 'function') {
            throw new Error("aiService is required for summarization and must have a generateText method.");
        }

        // Determine the prompt template to use
        const chosenPromptTemplate = (customPromptTemplate && typeof customPromptTemplate === 'string' && customPromptTemplate.trim() !== '')
            ? customPromptTemplate
            : defaultPromptTemplate;

        const prompt = chosenPromptTemplate.replace('{text_to_summarize}', originalContent);

        const effectiveLlmParams = {
            model: (llmParams && llmParams.model) || (aiService.baseConfig && aiService.baseConfig.summarizationModel) || 'gpt-3.5-turbo',
            ...llmParams
        };

        try {
            const summaryContent = await aiService.generateText(prompt, effectiveLlmParams);

            if (cacheSummary) {
                try {
                    await this.overwriteMemory(taskStateDirPath, path.basename(summaryFilePath), summaryContent);

                    const metaData = {
                        originalContentHash: currentOriginalHash,
                        summaryGeneratedTimestamp: new Date().toISOString()
                    };
                    await this.overwriteMemory(taskStateDirPath, path.basename(summaryMetaFilePath), metaData, { isJson: true });
                    // console.log(`MemoryManager: Saved new summary and meta for '${memoryCategoryFileName}'.`); // use t()
                } catch (writeError) {
                    // console.error(`MemoryManager: Failed to cache summary or meta for '${memoryCategoryFileName}': ${writeError.message}`); // use t()
                }
            }
            return summaryContent;
        } catch (llmError) {
            // console.error(`MemoryManager: Error summarizing content for '${memoryCategoryFileName}': ${llmError.message}`); // use t()
            throw new Error(`Failed to summarize '${memoryCategoryFileName}': ${llmError.message}`);
        }
    }

    _getSummaryMetaFilePath(summaryFilePath) { // Added helper method
        return `${summaryFilePath}.meta.json`;
    }
}

module.exports = MemoryManager;
