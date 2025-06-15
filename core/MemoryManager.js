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

    /**
     * Assembles a comprehensive context string from various sources within a specified token budget.
     * The context is built by adding parts in a defined priority order until the token limit is approached.
     *
     * @param {string} taskStateDirPath - The full path to the task's state directory.
     * @param {object} contextSpecification - Object detailing what to include in the context.
     * @param {string|null} [contextSpecification.systemPrompt=null] - System message for the LLM, prepended to the context.
     * @param {boolean} [contextSpecification.includeTaskDefinition=false] - Whether to load and include 'task_definition.md'.
     * @param {string[]} [contextSpecification.uploadedFilePaths=[]] - Array of paths to user-uploaded files (relative to the task's memory bank) to include.
     * @param {number} [contextSpecification.maxLatestKeyFindings=0] - How many recent key findings to include. Findings are processed newest first.
     * @param {boolean} [contextSpecification.includeRawContentForReferencedFindings=true] - If a key finding references raw content (e.g., a file path), attempt to load and include that raw content. If false or loading fails, uses finding's preview or data.
     * @param {object[]} [contextSpecification.chatHistory=[]] - Array of chat messages, e.g., `{role: 'user', content: '...'}`. Processed newest first.
     * @param {number} contextSpecification.maxTokenLimit - The absolute maximum number of tokens for the assembled context string (including preambles, postambles, separators).
     * @param {string[]} [contextSpecification.priorityOrder=['systemPrompt', 'chatHistory', 'uploadedFilePaths', 'taskDefinition', 'keyFindings']] - Order in which context parts are added. Processing stops if token budget is exceeded.
     * @param {string} [contextSpecification.customPreamble="Use the following information..."] - Text to prepend to the entire assembled context.
     * @param {string} [contextSpecification.customPostamble="--- END CONTEXT ---"] - Text to append to the entire assembled context.
     * @param {string} [contextSpecification.recordSeparator="\n\n--- Next Record ---\n"] - Separator used between major context records (e.g., between two different files, or a file and key findings section).
     * @param {string} [contextSpecification.findingSeparator="\n---\n"] - Separator used within a complex key finding if it has multiple parts (e.g., between ID/Tool info and its content).
     * @param {string} [contextSpecification.currentProgressSummary] - (Optional) For CWC updates, the current summary of progress.
     * @param {string} [contextSpecification.currentNextObjective] - (Optional) For CWC updates, the current next objective.
     * @param {object[]} [contextSpecification.recentErrorsSummary] - (Optional) For CWC updates, a summary of recent errors.
     * @param {string} [contextSpecification.summarizedKeyFindingsText] - (Optional) For CWC updates, pre-summarized key findings.
     * @param {boolean} [contextSpecification.overallExecutionSuccess] - (Optional) For CWC updates, the overall success status of the last execution.
     * @param {object[]} [contextSpecification.executionContext] - (Optional) For final synthesis, the execution context (history of steps).
     * @param {string} [contextSpecification.originalUserTask] - (Optional) For final synthesis, the original user task string.
     * @param {Function} tokenizerCompatibleWithLLM - A function that takes a string and returns the number of tokens it represents, compatible with the target LLM.
     * @returns {Promise<object>} An object: `{ success: Boolean, contextString?: String, tokenCount?: Number, error?: String }`.
     *                           `contextString` is the assembled context. `tokenCount` is its token length.
     *                           `error` is present if `success` is false.
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
            priorityOrder = ['systemPrompt', 'chatHistory', 'uploadedFilePaths', 'taskDefinition', 'keyFindings', /* other custom fields if they need specific placement */],
            customPreamble = "Use the following information to answer the subsequent question or complete the task:\n--- BEGIN CONTEXT ---",
            customPostamble = "--- END CONTEXT ---",
            recordSeparator = "\n\n--- Next Record ---\n",
            findingSeparator = "\n---\n",
            // Fields for CWC update / Synthesis (will be ignored if not in priorityOrder or handled specifically)
            currentProgressSummary, currentNextObjective, recentErrorsSummary, summarizedKeyFindingsText, overallExecutionSuccess,
            executionContext, originalUserTask
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
            // Helper function to add a part to context if budget allows
            const addPartToContext = (partContent, isCritical = false) => {
                const partTokens = countTokens(partContent);
                if (partTokens <= remainingTokenBudget) {
                    contextParts.push(partContent);
                    currentTokenCount += partTokens;
                    remainingTokenBudget -= partTokens;
                    return true;
                } else if (isCritical) {
                    // If a critical part is too large, assembly fails.
                    throw new Error(`Critical context part too large for token budget (tokens: ${partTokens}, budget: ${remainingTokenBudget}).`);
                }
                // console.warn(`MemoryManager.assembleMegaContext: Part too large for remaining budget (tokens: ${partTokens}, budget: ${remainingTokenBudget}). Skipping.`);
                return false;
            };

            // Account for preamble and postamble tokens first as they are fixed overhead.
            const preambleText = customPreamble + (contextParts.length > 0 || systemPrompt ? "\n\n" : ""); // Add newlines if it's not the very start
            const postambleText = (contextParts.length > 0 || systemPrompt ? "\n\n" : "") + customPostamble;
            const preambleTokens = countTokens(preambleText);
            const postambleTokens = countTokens(postambleText);
            let remainingTokenBudget = maxTokenLimit - (preambleTokens + postambleTokens);

            if (remainingTokenBudget < 0) {
                return { success: false, error: "maxTokenLimit is too small for preamble and postamble.", tokenCount: preambleTokens + postambleTokens, details: { preambleTokens, postambleTokens } };
            }

            // Iterate through the specified priority order to assemble the context
            for (const contentType of priorityOrder) {
                if (remainingTokenBudget <= 0) break; // Stop if no budget left

                // Determine the separator: use recordSeparator if contextParts already has items or if a systemPrompt was the first thing.
                // The first *actual content piece* after a potential system prompt should not have a preceding separator.
                const getSeparator = () => (contextParts.length > 0 || (systemPrompt && contextParts.length === 0 && contentType !== 'systemPrompt')) ? recordSeparator : "";

                switch (contentType) {
                    case 'systemPrompt':
                        if (systemPrompt && typeof systemPrompt === 'string') {
                            // System prompt is critical and doesn't use recordSeparator before it.
                            // It's usually handled by specific API params but here it's part of the string.
                            const partContent = systemPrompt; // No separator before system prompt itself
                            addPartToContext(partContent + "\n", true); // Add newline, consider critical
                        }
                        break;

                    case 'chatHistory':
                        if (chatHistory && chatHistory.length > 0) {
                            // Process from newest to oldest, trying to fit as many as possible
                            for (let i = chatHistory.length - 1; i >= 0; i--) {
                                if (remainingTokenBudget <= 0) break;
                                const message = chatHistory[i];
                                const formattedMessage = `${message.role}: ${message.content}`;
                                const partContent = getSeparator() + formattedMessage;
                                if (!addPartToContext(partContent)) break; // Stop if a message doesn't fit
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
                                        const partContent = getSeparator() + fullText;
                                        addPartToContext(partContent);
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
                                    const partContent = getSeparator() + fullText;
                                    addPartToContext(partContent);
                                }
                            } catch (e) {
                                console.warn(`MemoryManager.assembleMegaContext: Failed to load task_definition.md. Error: ${e.message}. Skipping.`);
                            }
                        }
                        break;

                    // Handling for additional context fields (e.g. for CWC update or Synthesis)
                    // These are simple string fields, so they are added directly.
                    // Their order is determined by `priorityOrder`.
                    case 'originalUserTask':
                        if (originalUserTask && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Original User Task:\n${originalUserTask}`);
                        break;
                    case 'currentProgressSummary':
                        if (currentProgressSummary && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Current Progress Summary:\n${currentProgressSummary}`);
                        break;
                    case 'currentNextObjective':
                        if (currentNextObjective && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Current Next Objective:\n${currentNextObjective}`);
                        break;
                    case 'summarizedKeyFindingsText':
                        if (summarizedKeyFindingsText && remainingTokenBudget > 0) addPartToContext(getSeparator() + `Summarized Key Findings:\n${summarizedKeyFindingsText}`);
                        break;
                    case 'recentErrorsSummary':
                        if (recentErrorsSummary && recentErrorsSummary.length > 0 && remainingTokenBudget > 0) {
                             addPartToContext(getSeparator() + `Recent Errors Encountered:\n${JSON.stringify(recentErrorsSummary, null, 2)}`);
                        }
                        break;
                    case 'overallExecutionSuccess':
                         if (typeof overallExecutionSuccess === 'boolean' && remainingTokenBudget > 0) {
                            addPartToContext(getSeparator() + `Overall Execution Success of Last Attempt: ${overallExecutionSuccess}`);
                         }
                        break;
                    case 'executionContext':
                        if (executionContext && executionContext.length > 0 && remainingTokenBudget > 0) {
                            // For execution context, might need to stringify or summarize if too large
                            // For now, simple stringification.
                            const execContextStr = JSON.stringify(executionContext, null, 2);
                            addPartToContext(getSeparator() + `Execution Context (History):\n${execContextStr}`);
                        }
                        break;

                    case 'keyFindings': // This remains for complex findings objects
                        if (maxLatestKeyFindings > 0) {
                            if (typeof this.getLatestKeyFindings !== 'function') {
                                console.warn("MemoryManager.assembleMegaContext: this.getLatestKeyFindings is not a function. Skipping key findings.");
                                break;
                            }
                            const findings = await this.getLatestKeyFindings(taskStateDirPath, maxLatestKeyFindings);
                            for (const finding of findings.reverse()) { // Process newest first
                                if (remainingTokenBudget <= 0) break;
                                let findingContentText = "";
                                // Attempt to load raw content if specified and applicable
                                if (includeRawContentForReferencedFindings && finding.data && finding.data.type === 'reference_to_raw_content' && finding.data.rawContentPath) {
                                    try {
                                        const rawC = await this.loadMemory(taskStateDirPath, finding.data.rawContentPath, { isJson: false, defaultValue: null });
                                        findingContentText = rawC || finding.data.preview || JSON.stringify(finding.data);
                                    } catch (e) {
                                        console.warn(`MemoryManager.assembleMegaContext: Failed to load raw content for finding ${finding.id || finding.data.rawContentPath}. Error: ${e.message}. Using preview.`);
                                        findingContentText = finding.data.preview || JSON.stringify(finding.data);
                                    }
                                } else if (typeof finding.data === 'string') { // If data is already a string
                                    findingContentText = finding.data;
                                } else if (finding.data && finding.data.preview) { // If data has a preview
                                    findingContentText = finding.data.preview;
                                } else { // Fallback to stringifying the data object
                                    findingContentText = JSON.stringify(finding.data);
                                }

                                const formattedFinding = `Key Finding (ID: ${finding.id || 'N/A'}, Tool: ${finding.sourceToolName || 'N/A'}):${findingSeparator}${findingContentText}`;
                                const partContent = getSeparator() + formattedFinding;
                                if (!addPartToContext(partContent)) break; // Stop if a finding doesn't fit
                            }
                        }
                        break;
                }
            }

            // Construct the final string
            let finalContextString = "";
            if (customPreamble) finalContextString += customPreamble;

            // Join context parts. If systemPrompt was the first and only part before others,
            // ensure there's a newline. If other parts exist, they already got separators.
            if (contextParts.length > 0) {
                if (finalContextString !== "" && !finalContextString.endsWith("\n")) {
                     finalContextString += "\n\n"; // Ensure separation from preamble if preamble didn't end with it
                }
                finalContextString += contextParts.join(""); // Separators are now part of partContent
            }

            if (customPostamble) {
                if (finalContextString !== "" && !finalContextString.endsWith("\n")) {
                    finalContextString += "\n\n"; // Ensure separation before postamble
                }
                finalContextString += customPostamble;
            }

            // Final token count check
            const finalTokenCount = countTokens(finalContextString);

            if (finalTokenCount > maxTokenLimit) {
                console.warn(`MemoryManager.assembleMegaContext: Final context string (tokens: ${finalTokenCount}) slightly exceeds maxTokenLimit (${maxTokenLimit}) despite budgeting. This may be due to separator logic or tokenization nuances. Consider a small buffer in maxTokenLimit if this is problematic.`);
                // Decide on handling: error out, or truncate (truncation is complex here as it might cut mid-record)
                // For now, let's return an error if it strictly exceeds.
                return { success: false, error: "Assembled context exceeds token limit after final construction. Budgeting might be too tight or separators miscounted.", tokenCount: finalTokenCount, details: { maxTokenLimit } };
            }

            return { success: true, contextString: finalContextString, tokenCount: finalTokenCount };

        } catch (error) {
            console.error("MemoryManager.assembleMegaContext: Critical error during context assembly.", error);
            return { success: false, error: error.message, tokenCount: currentTokenCount }; // currentTokenCount might be stale here
        }
    }
}

module.exports = MemoryManager;
