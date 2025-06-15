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
            recordSeparator = "\n\n--- Next Record ---\n", // Separator between distinct items like files or findings
            findingSeparator = "\n---\n" // Separator for fields within a single complex finding
        } = contextSpecification || {};

        if (typeof maxTokenLimit !== 'number' || maxTokenLimit <= 0) {
            return { success: false, error: "maxTokenLimit must be a positive number.", tokenCount: 0 };
        }
        if (typeof tokenizerCompatibleWithLLM !== 'function') {
            return { success: false, error: "tokenizerCompatibleWithLLM must be a function.", tokenCount: 0 };
        }

        const contextParts = [];
        let currentTokenCount = 0;

        const countTokens = (text) => {
            try {
                return tokenizerCompatibleWithLLM(text);
            } catch (e) {
                console.error("MemoryManager.assembleMegaContext: Tokenizer function failed.", e);
                throw new Error("Tokenizer function failed during context assembly."); // Propagate to be caught by main try-catch
            }
        };

        try {
            // Account for preamble and postamble tokens first
            const preambleTokens = countTokens(customPreamble + "\n\n"); // Add newlines for separation
            const postambleTokens = countTokens("\n\n" + customPostamble); // Add newlines for separation
            let remainingTokenBudget = maxTokenLimit - (preambleTokens + postambleTokens);

            if (remainingTokenBudget < 0) {
                return { success: false, error: "maxTokenLimit is too small for preamble and postamble.", tokenCount: preambleTokens + postambleTokens, details: { preambleTokens, postambleTokens } };
            }

            for (const contentType of priorityOrder) {
                if (remainingTokenBudget <= 0) break;

                switch (contentType) {
                    case 'systemPrompt':
                        if (systemPrompt && typeof systemPrompt === 'string') {
                            const partTokens = countTokens(systemPrompt + "\n"); // Assume it needs a newline after
                            if (partTokens <= remainingTokenBudget) {
                                contextParts.push(systemPrompt);
                                currentTokenCount += partTokens;
                                remainingTokenBudget -= partTokens;
                            } else {
                                console.warn("MemoryManager.assembleMegaContext: System prompt too large for remaining budget. Skipping.");
                            }
                        }
                        break;

                    case 'chatHistory':
                        if (chatHistory && chatHistory.length > 0) {
                            // Assuming newest messages are more relevant if truncation happens. Process from newest to oldest.
                            for (let i = chatHistory.length - 1; i >= 0; i--) {
                                const message = chatHistory[i];
                                const formattedMessage = `${message.role}: ${message.content}`;
                                const partSeparator = (contextParts.length > 0 || systemPrompt) ? recordSeparator : ""; // Add separator if not the first actual content
                                const partTokens = countTokens(partSeparator + formattedMessage);

                                if (partTokens <= remainingTokenBudget) {
                                    contextParts.push(partSeparator + formattedMessage);
                                    currentTokenCount += partTokens;
                                    remainingTokenBudget -= partTokens;
                                } else {
                                    break; // Stop adding chat history if budget exceeded
                                }
                            }
                        }
                        break;

                    case 'uploadedFilePaths':
                        if (uploadedFilePaths && uploadedFilePaths.length > 0) {
                            for (const filePath of uploadedFilePaths) {
                                if (remainingTokenBudget <= 0) break;
                                try {
                                    const content = await this.loadMemory(taskStateDirPath, filePath, { isJson: false, defaultValue: null });
                                    if (content) {
                                        const fileName = path.basename(filePath);
                                        const header = `Document: ${fileName}\nContent:\n`;
                                        const fullText = header + content;
                                        const partSeparator = (contextParts.length > 0 || systemPrompt) ? recordSeparator : "";
                                        const partTokens = countTokens(partSeparator + fullText);

                                        if (partTokens <= remainingTokenBudget) {
                                            contextParts.push(partSeparator + fullText);
                                            currentTokenCount += partTokens;
                                            remainingTokenBudget -= partTokens;
                                        } else {
                                             console.warn(`MemoryManager.assembleMegaContext: Document ${fileName} (tokens: ${partTokens}) too large for remaining budget (${remainingTokenBudget}). Skipping.`);
                                        }
                                    }
                                } catch (e) {
                                    console.warn(`MemoryManager.assembleMegaContext: Failed to load uploaded file ${filePath}. Error: ${e.message}. Skipping.`);
                                }
                            }
                        }
                        break;

                    case 'taskDefinition':
                        if (includeTaskDefinition) {
                            if (remainingTokenBudget <= 0) break;
                            try {
                                const content = await this.loadMemory(taskStateDirPath, 'task_definition.md', { isJson: false, defaultValue: null });
                                if (content) {
                                    const header = "Task Definition:\n";
                                    const fullText = header + content;
                                    const partSeparator = (contextParts.length > 0 || systemPrompt) ? recordSeparator : "";
                                    const partTokens = countTokens(partSeparator + fullText);
                                    if (partTokens <= remainingTokenBudget) {
                                        contextParts.push(partSeparator + fullText);
                                        currentTokenCount += partTokens;
                                        remainingTokenBudget -= partTokens;
                                    } else {
                                        console.warn(`MemoryManager.assembleMegaContext: Task definition too large for remaining budget. Skipping.`);
                                    }
                                }
                            } catch (e) {
                                console.warn(`MemoryManager.assembleMegaContext: Failed to load task_definition.md. Error: ${e.message}. Skipping.`);
                            }
                        }
                        break;

                    case 'keyFindings':
                        if (maxLatestKeyFindings > 0) {
                             // Assuming getLatestKeyFindings is implemented from a previous subtask
                            if (typeof this.getLatestKeyFindings !== 'function') {
                                console.warn("MemoryManager.assembleMegaContext: this.getLatestKeyFindings is not a function. Skipping key findings.");
                                break;
                            }
                            const findings = await this.getLatestKeyFindings(taskStateDirPath, maxLatestKeyFindings);
                            for (const finding of findings.reverse()) { // Process newest first
                                if (remainingTokenBudget <= 0) break;
                                let findingContent = "";
                                if (includeRawContentForReferencedFindings && finding.data && finding.data.type === 'reference_to_raw_content' && finding.data.rawContentPath) {
                                    try {
                                        const rawC = await this.loadMemory(taskStateDirPath, finding.data.rawContentPath, { isJson: false, defaultValue: null });
                                        findingContent = rawC || finding.data.preview || JSON.stringify(finding.data);
                                    } catch (e) {
                                        console.warn(`MemoryManager.assembleMegaContext: Failed to load raw content for finding ${finding.id || finding.data.rawContentPath}. Error: ${e.message}. Using preview.`);
                                        findingContent = finding.data.preview || JSON.stringify(finding.data);
                                    }
                                } else if (typeof finding.data === 'string') {
                                    findingContent = finding.data;
                                } else if (finding.data && finding.data.preview) {
                                    findingContent = finding.data.preview;
                                } else {
                                    findingContent = JSON.stringify(finding.data);
                                }

                                const formattedFinding = `Key Finding (ID: ${finding.id || 'N/A'}, Tool: ${finding.sourceToolName || 'N/A'}):${findingSeparator}${findingContent}`;
                                const partSeparator = (contextParts.length > 0 || systemPrompt) ? recordSeparator : "";
                                const partTokens = countTokens(partSeparator + formattedFinding);

                                if (partTokens <= remainingTokenBudget) {
                                    contextParts.push(partSeparator + formattedFinding);
                                    currentTokenCount += partTokens;
                                    remainingTokenBudget -= partTokens;
                                } else {
                                     console.warn(`MemoryManager.assembleMegaContext: Finding ID ${finding.id || 'N/A'} too large for budget. Skipping subsequent findings.`);
                                    break;
                                }
                            }
                        }
                        break;
                }
            }

            let finalContextString = contextParts.join("\n\n"); // Join major parts with double newline
            finalContextString = customPreamble + "\n\n" + finalContextString + "\n\n" + customPostamble;

            const finalTokenCount = countTokens(finalContextString);

            if (finalTokenCount > maxTokenLimit) {
                // This should ideally not happen if budgeting is correct, but as a safeguard:
                console.warn(`MemoryManager.assembleMegaContext: Final context string (tokens: ${finalTokenCount}) exceeds maxTokenLimit (${maxTokenLimit}) even after checks. This might indicate an issue with separator/preamble token accounting or very tight limits.`);
                // For now, returning an error. Could implement more sophisticated truncation here.
                return { success: false, error: "Assembled context exceeds token limit after final construction.", tokenCount: finalTokenCount, details: { maxTokenLimit } };
            }

            return { success: true, contextString: finalContextString, tokenCount: finalTokenCount };

        } catch (error) {
            console.error("MemoryManager.assembleMegaContext: Critical error during context assembly.", error);
            return { success: false, error: error.message, tokenCount: currentTokenCount };
        }
    }
}

module.exports = MemoryManager;
