// core/MemoryManager.js
const { t } = require('../utils/localization');
const fsp = require('fs').promises;
const fs = require('fs'); // For sync operations if needed (e.g. existsSync, though fsp.access is better for async checks)
const path = require('path');
const crypto = require('crypto'); // Added for hashing

const MEMORY_BANK_DIR_NAME = 'memory_bank';
const MEMORY_COLLECTION_TYPE_JSONL = 'jsonl';
const DEFAULT_COLLECTION_TYPE = MEMORY_COLLECTION_TYPE_JSONL;

class MemoryManager {
    constructor() {
        // Constructor might be used for configuration in the future
    }

    _getTaskMemoryBankPath(taskStateDirPath) {
        if (!taskStateDirPath || typeof taskStateDirPath !== 'string' || taskStateDirPath.trim() === '') {
            // It's critical that taskStateDirPath is valid.
            const errMsg = "MemoryManager: taskStateDirPath (полный путь к каталогу состояния задачи) должен быть непустой строкой.";
            console.error(t('MM_ERR_TASK_STATE_DIR_PATH_REQUIRED_CONSOLE', { componentName: 'MemoryManager', message: errMsg })); // Though direct throw is more common
            throw new Error(errMsg);
        }
        return path.join(taskStateDirPath, MEMORY_BANK_DIR_NAME);
    }

    getMemoryFilePath(taskStateDirPath, memoryCategoryFileName) {
        if (!memoryCategoryFileName || typeof memoryCategoryFileName !== 'string' || memoryCategoryFileName.trim() === '') {
             const errMsg = "MemoryManager: memoryCategoryFileName должен быть непустой строкой.";
             console.error(t('MM_ERR_FILENAME_REQUIRED_CONSOLE', { componentName: 'MemoryManager', message: errMsg })); // Though direct throw is more common
             throw new Error(errMsg);
        }
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath); // Will throw if taskStateDirPath is invalid
        return path.join(memoryBankPath, memoryCategoryFileName);
    }

    async initializeTaskMemory(taskStateDirPath) {
        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        try {
            await fsp.mkdir(memoryBankPath, { recursive: true });
            console.log(t('MM_LOG_INIT_BANK', { componentName: 'MemoryManager', path: memoryBankPath }));
        } catch (error) {
            console.error(t('MM_ERR_INIT_BANK', { componentName: 'MemoryManager', path: memoryBankPath }), error);
            throw error;
        }
    }

    async loadMemory(taskStateDirPath, memoryCategoryFileName, options = {}) {
        const { isJson = false, defaultValue = null } = options;
        let filePath;
        try {
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            const content = await fsp.readFile(filePath, 'utf8');
            console.log(t('MM_LOG_LOADED_MEM', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
            return isJson ? JSON.parse(content) : content;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(t('MM_LOG_MEM_NOT_FOUND', { componentName: 'MemoryManager', filePath: filePath || memoryCategoryFileName }));
                return defaultValue;
            }
            console.error(t('MM_ERR_LOAD_MEM', { componentName: 'MemoryManager', filePath: filePath || memoryCategoryFileName }), error);
            throw error;
        }
    }

    async appendToMemory(taskStateDirPath, memoryCategoryFileName, contentToAppend) {
        if (contentToAppend === undefined || contentToAppend === null) {
            console.warn(t('MM_WARN_APPEND_NULL_CONTENT', { componentName: 'MemoryManager' }));
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
            await fsp.appendFile(filePath, String(contentToAppend) + '\n', 'utf8');
            console.log(t('MM_LOG_APPENDED_MEM', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
        } catch (error) {
            console.error(t('MM_ERR_APPEND_MEM', { componentName: 'MemoryManager', filePath: filePath || memoryCategoryFileName }), error);
            throw error;
        }
    }

    async overwriteMemory(taskStateDirPath, memoryCategoryFileName, newContent, options = {}) {
        const { isJson = false } = options;
        if (newContent === undefined) { // Allow null to be written (e.g. for JSON)
            console.warn(t('MM_WARN_OVERWRITE_UNDEFINED_CONTENT', { componentName: 'MemoryManager' }));
            return;
        }
        let filePath;
        try {
            const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
            await fsp.mkdir(memoryBankPath, { recursive: true });
            filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);

            const contentToWrite = isJson ? JSON.stringify(newContent, null, 2) : String(newContent);

            await fsp.writeFile(filePath, contentToWrite, 'utf8');
            console.log(t('MM_LOG_OVERWRITTEN_MEM', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
        } catch (error) {
            console.error(t('MM_ERR_OVERWRITE_MEM', { componentName: 'MemoryManager', filePath: filePath || memoryCategoryFileName }), error);
            throw error;
        }
    }

    _calculateHash(content) {
        if (typeof content !== 'string') {
            console.warn(t('MM_WARN_HASH_NON_STRING', { componentName: 'MemoryManager' }));
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
            if (error.code === 'ENOENT') {
                return defaultValue;
            }
            throw error;
        }

        const currentOriginalHash = this._calculateHash(originalContent);
        if (!currentOriginalHash) {
            throw new Error("MemoryManager: Не удалось вычислить хэш для исходного содержимого.");
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
                    console.log(t('MM_LOG_CACHE_HIT', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
                    return await fsp.readFile(summaryFilePath, 'utf8');
                } else {
                    console.log(t('MM_LOG_CACHE_HASH_MISMATCH', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.warn(t('MM_WARN_CACHE_CHECK_ERROR', { componentName: 'MemoryManager', fileName: memoryCategoryFileName, message: error.message }));
                }
            }
        }

        console.log(t('MM_LOG_SUMMARIZING', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
        if (!aiService || typeof aiService.generateText !== 'function') {
            throw new Error("MemoryManager: Для суммирования требуется aiService с методом generateText.");
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

                    const metaData = {
                        originalContentHash: currentOriginalHash,
                        summaryGeneratedTimestamp: new Date().toISOString()
                    };
                    await this.overwriteMemory(taskStateDirPath, path.basename(summaryMetaFilePath), metaData, { isJson: true });
                    console.log(t('MM_LOG_SAVED_SUMMARY', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
                } catch (writeError) {
                    console.error(t('MM_ERR_CACHE_SUMMARY_WRITE', { componentName: 'MemoryManager', fileName: memoryCategoryFileName, message: writeError.message }));
                }
            }
            return summaryContent;
        } catch (llmError) {
            console.error(t('MM_ERR_SUMMARIZING_CONTENT', { componentName: 'MemoryManager', fileName: memoryCategoryFileName, message: llmError.message }));
            throw new Error(`MemoryManager: Не удалось суммировать '${memoryCategoryFileName}': ${llmError.message}`);
        }
    }

    _getSummaryMetaFilePath(summaryFilePath) { // Added helper method
        return `${summaryFilePath}.meta.json`;
    }

    async addMemoryRecord(taskStateDirPath, memoryCategoryFileName, recordObject, options = {}) {
        const {
            collectionType = DEFAULT_COLLECTION_TYPE,
            deduplicateIdField = null // e.g., 'id' or 'url'
        } = options;

        if (!recordObject || typeof recordObject !== 'object') {
            console.warn(t('MM_WARN_ADD_RECORD_INVALID_OBJECT', { componentName: 'MemoryManager' }));
            return; // Or throw error
        }
        if (deduplicateIdField && !(deduplicateIdField in recordObject)) {
            console.warn(t('MM_WARN_ADD_RECORD_DEDUP_FIELD_MISSING', { componentName: 'MemoryManager', field: deduplicateIdField }));
            // Proceed without deduplication or throw error? For now, proceed.
        }

        const memoryBankPath = this._getTaskMemoryBankPath(taskStateDirPath);
        await fsp.mkdir(memoryBankPath, { recursive: true });
        const filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);

        if (collectionType === MEMORY_COLLECTION_TYPE_JSONL) {
            if (deduplicateIdField && recordObject[deduplicateIdField]) {
                try {
                    // Initial simple scan for deduplication. This can be slow for large files.
                    const existingRecords = await this.loadMemoryRecords(taskStateDirPath, memoryCategoryFileName, { collectionType });
                    if (existingRecords && existingRecords.some(rec => rec[deduplicateIdField] === recordObject[deduplicateIdField])) {
                        console.log(t('MM_LOG_ADD_RECORD_DUPLICATE_SKIPPED', { componentName: 'MemoryManager', field: deduplicateIdField, id: recordObject[deduplicateIdField] }));
                        return; // Skip adding duplicate
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') { // ENOENT is fine (file doesn't exist yet)
                        console.warn(t('MM_WARN_ADD_RECORD_DEDUP_READ_ERROR', { componentName: 'MemoryManager', message: err.message }));
                        // Proceed with append despite error in checking duplicates for now
                    }
                }
            }

            const recordString = JSON.stringify(recordObject);
            await fsp.appendFile(filePath, recordString + '\n', 'utf8');
            console.log(t('MM_LOG_ADD_RECORD_SUCCESS', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
        } else {
            console.error(t('MM_ERR_ADD_RECORD_UNSUPPORTED_COLLECTION_TYPE', { componentName: 'MemoryManager', type: collectionType }));
            // Or throw new Error(...)
        }
    }

    async loadMemoryRecords(taskStateDirPath, memoryCategoryFileName, options = {}) {
        const {
            collectionType = DEFAULT_COLLECTION_TYPE,
            filterFunction = null,
            limit = null,
            offset = 0 // Default offset to 0
        } = options;

        const filePath = this.getMemoryFilePath(taskStateDirPath, memoryCategoryFileName);
        let records = [];

        if (collectionType === MEMORY_COLLECTION_TYPE_JSONL) {
            try {
                const fileContent = await fsp.readFile(filePath, 'utf8');
                const lines = fileContent.split('\n').filter(line => line.trim() !== ''); // Get non-empty lines

                for (const line of lines) {
                    try {
                        const record = JSON.parse(line);
                        records.push(record);
                    } catch (parseError) {
                        console.warn(t('MM_WARN_LOAD_RECORDS_PARSE_ERROR', { componentName: 'MemoryManager', filePath, line, message: parseError.message }));
                        // Skip corrupted line
                    }
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(t('MM_LOG_LOAD_RECORDS_FILE_NOT_FOUND', { componentName: 'MemoryManager', filePath }));
                    return []; // Return empty array if file not found
                }
                console.error(t('MM_ERR_LOAD_RECORDS_READ_ERROR', { componentName: 'MemoryManager', filePath, message: error.message }));
                throw error; // Re-throw other errors
            }

            if (filterFunction) {
                records = records.filter(filterFunction);
            }

            // Apply offset and limit
            const startIndex = offset;
            const endIndex = limit ? startIndex + limit : records.length;
            records = records.slice(startIndex, endIndex);

            console.log(t('MM_LOG_LOAD_RECORDS_SUCCESS', { componentName: 'MemoryManager', count: records.length, fileName: memoryCategoryFileName }));
            return records;

        } else {
            console.error(t('MM_ERR_LOAD_RECORDS_UNSUPPORTED_COLLECTION_TYPE', { componentName: 'MemoryManager', type: collectionType }));
            throw new Error(t('MM_ERR_LOAD_RECORDS_UNSUPPORTED_COLLECTION_TYPE_THROW', { type: collectionType }));
        }
    }

    async getRecentMemoryRecords(taskStateDirPath, memoryCategoryFileName, options = {}) {
        const {
            count = 10, // Default to fetching 10 recent records
            collectionType = DEFAULT_COLLECTION_TYPE // Use the same default as loadMemoryRecords
        } = options;

        if (collectionType === MEMORY_COLLECTION_TYPE_JSONL) {
            // For JSONL, we need to read all records and then take the last 'count' records.
            // This is because we don't know the total number of records without reading the file.
            // More advanced implementations might read the file in reverse, but that's complex.
            try {
                const allRecords = await this.loadMemoryRecords(taskStateDirPath, memoryCategoryFileName, { collectionType });
                const recentRecords = allRecords.slice(-count); // Get the last 'count' elements
                console.log(t('MM_LOG_GET_RECENT_SUCCESS', {
                    componentName: 'MemoryManager',
                    count: recentRecords.length,
                    requestedCount: count,
                    fileName: memoryCategoryFileName
                }));
                return recentRecords;
            } catch (error) {
                // Errors from loadMemoryRecords (e.g., file not found if it returns null/throws) should propagate.
                // loadMemoryRecords already logs errors, so just rethrow or handle specific cases if needed.
                console.error(t('MM_ERR_GET_RECENT_FAILED', {
                    componentName: 'MemoryManager',
                    fileName: memoryCategoryFileName,
                    message: error.message
                }));
                throw error;
            }
        } else {
            const errorMessage = t('MM_ERR_GET_RECENT_UNSUPPORTED_TYPE_THROW', {
                componentName: 'MemoryManager', // Not used in direct throw, but good for t() consistency
                type: collectionType
            });
            console.error(t('MM_ERR_GET_RECENT_UNSUPPORTED_TYPE', { // For console
                componentName: 'MemoryManager',
                type: collectionType
            }));
            throw new Error(errorMessage);
        }
    }

    async getSummarizedRecords(taskStateDirPath, memoryCategoryFileName, aiService, options = {}) {
        const {
            recordFilter = null, // Function to filter records
            promptTemplateForRecord = "Summarize this record concisely: {recordContent}", // Prompt for individual record
            maxRecordsToProcess = null, // Max records to fetch and process for summarization
            llmParams = {}, // LLM params for summarization calls
            // collectionType is implicitly jsonl for now as per loadMemoryRecords default
        } = options;

        if (!aiService || typeof aiService.generateText !== 'function') {
            const errMsg = t('MM_ERR_SUMMARIZE_RECORDS_AISERVICE_INVALID_THROW', { componentName: 'MemoryManager' });
            console.error(t('MM_ERR_SUMMARIZE_RECORDS_AISERVICE_INVALID', { componentName: 'MemoryManager' }));
            throw new Error(errMsg);
        }

        let recordsToSummarize;
        try {
            // Load records, applying filter if provided. Limit applied after filtering for now.
            recordsToSummarize = await this.loadMemoryRecords(taskStateDirPath, memoryCategoryFileName, {
                filterFunction: recordFilter
            });
        } catch (error) {
            console.error(t('MM_ERR_SUMMARIZE_RECORDS_LOAD_FAILED', { componentName: 'MemoryManager', fileName: memoryCategoryFileName, message: error.message }));
            throw error; // Rethrow if loading records fails
        }

        if (!recordsToSummarize || recordsToSummarize.length === 0) {
            console.log(t('MM_LOG_SUMMARIZE_RECORDS_NO_RECORDS', { componentName: 'MemoryManager', fileName: memoryCategoryFileName }));
            return []; // No records to summarize
        }

        if (maxRecordsToProcess && recordsToSummarize.length > maxRecordsToProcess) {
            recordsToSummarize = recordsToSummarize.slice(0, maxRecordsToProcess);
            console.log(t('MM_LOG_SUMMARIZE_RECORDS_LIMITED', { componentName: 'MemoryManager', count: maxRecordsToProcess, fileName: memoryCategoryFileName }));
        }

        const summarizedResults = [];
        const effectiveLlmParams = {
            model: (llmParams && llmParams.model) || (aiService.baseConfig && aiService.baseConfig.summarizationModel) || 'gpt-3.5-turbo',
            ...llmParams
        };

        for (const record of recordsToSummarize) {
            // For now, we assume the 'record' is an object and we'll stringify it for the prompt.
            // A more sophisticated approach might select specific fields or use a more structured prompt.
            const recordContentString = typeof record === 'string' ? record : JSON.stringify(record, null, 2);
            const prompt = promptTemplateForRecord.replace('{recordContent}', recordContentString);

            try {
                console.log(t('MM_LOG_SUMMARIZING_SINGLE_RECORD', { componentName: 'MemoryManager', recordId: record.id || 'N/A' }));
                const summaryText = await aiService.generateText(prompt, effectiveLlmParams);
                summarizedResults.push({ originalRecord: record, summary: summaryText });
            } catch (error) {
                console.error(t('MM_ERR_SUMMARIZING_SINGLE_RECORD_FAILED', { componentName: 'MemoryManager', recordId: record.id || 'N/A', message: error.message }));
                summarizedResults.push({ originalRecord: record, summary: null, error: error.message }); // Include error in result
            }
        }

        console.log(t('MM_LOG_SUMMARIZE_RECORDS_COMPLETED', { componentName: 'MemoryManager', count: summarizedResults.length, fileName: memoryCategoryFileName }));
        return summarizedResults;
    }
}

module.exports = MemoryManager;
