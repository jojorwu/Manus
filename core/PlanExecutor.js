// core/PlanExecutor.js
const { v4: uuidv4 } = require('uuid');
const path = require('path'); // Added for workspace path construction
const fsp = require('fs').promises; // Added for mkdir
const { escapeRegExp } = require('../utils/localization'); // Import the escape function

const ReadWebpageTool = require('../tools/ReadWebpageTool');
const FileSystemTool = require('../tools/FileSystemTool'); // Added
const FileDownloaderTool = require('../tools/FileDownloaderTool'); // Added

class PlanExecutor {
    constructor(subTaskQueue, resultsQueue, aiService, memoryManager, tools = {}, savedTasksBaseDir) { // Changed llmService to aiService
        if (!memoryManager || typeof memoryManager.saveKeyFinding !== 'function') {
            throw new Error("PlanExecutor: memoryManager instance with saveKeyFinding method is required.");
        }
        this.subTaskQueue = subTaskQueue;
        this.resultsQueue = resultsQueue;
        this.aiService = aiService; // Changed llmService to aiService
        this.memoryManager = memoryManager;
        this.tools = tools;
        this.savedTasksBaseDir = savedTasksBaseDir; // Store this
        if (!this.savedTasksBaseDir) {
            // Fallback or error if not provided by Orchestrator, though it should be.
            console.warn("PlanExecutor: savedTasksBaseDir not provided, defaulting to './saved_tasks'. This may be incorrect.");
            this.savedTasksBaseDir = path.resolve('./saved_tasks');
        }
    }

    async _resolveOutputReferences(data, stepOutputs, currentStepIdForLog = '') {
        const referenceRegex = /^@{outputs\.([a-zA-Z0-9_.-]+)\.(result_data|processed_result_data)}$/; // Full string match

        if (typeof data === 'string') {
            const match = data.match(referenceRegex);
            if (match) {
                const sourceStepId = match[1];
                const requestedFieldName = match[2];

                // Security: Validate sourceStepId and requestedFieldName
                // sourceStepId should be an existing key in stepOutputs
                if (!Object.prototype.hasOwnProperty.call(stepOutputs, sourceStepId)) {
                    throw new Error(`Unresolved reference: Step ID '${sourceStepId}' not found in outputs (referenced by step ${currentStepIdForLog}).`);
                }
                const allowedFieldNames = ['result_data', 'processed_result_data'];
                if (!allowedFieldNames.includes(requestedFieldName)) {
                    throw new Error(`Unresolved reference: Invalid field name '${requestedFieldName}' for step '${sourceStepId}' (referenced by step ${currentStepIdForLog}).`);
                }

                // Strict check for COMPLETED status
                // eslint-disable-next-line security/detect-object-injection -- sourceStepId is validated by hasOwnProperty call above. Accessing .status property.
                if (stepOutputs[sourceStepId].status !== "COMPLETED") {
                // eslint-disable-next-line security/detect-object-injection -- sourceStepId is validated by hasOwnProperty call above. Accessing .status property for error message.
                     throw new Error(`Referenced step '${sourceStepId}' did not complete successfully. Status: ${stepOutputs[sourceStepId].status} (referenced by step ${currentStepIdForLog}). Cannot use its output.`);
                }

                let actualFieldName = requestedFieldName;
                // eslint-disable-next-line security/detect-object-injection -- sourceStepId is validated by hasOwnProperty, actualFieldName is from allowed list or checked with hasOwnProperty.
                let resolvedValue = stepOutputs[sourceStepId][actualFieldName];

                // Fallback logic for processed_result_data
                if (requestedFieldName === 'processed_result_data' && (resolvedValue === undefined || resolvedValue === null)) {
                    // Security: Use Object.prototype.hasOwnProperty.call to avoid prototype pollution.
                    if (Object.prototype.hasOwnProperty.call(stepOutputs[sourceStepId], 'result_data')) { // Check if result_data actually exists
                        console.warn(`PlanExecutor._resolveOutputReferences: Field 'processed_result_data' for step '${sourceStepId}' is null or undefined. Falling back to 'result_data' (referenced by step ${currentStepIdForLog}).`);
                        actualFieldName = 'result_data';
                        // eslint-disable-next-line security/detect-object-injection -- sourceStepId and actualFieldName (now 'result_data') are validated.
                        resolvedValue = stepOutputs[sourceStepId][actualFieldName];
                    } else {
                        // If even result_data doesn't exist (should be rare for completed steps), this is an issue.
                         console.warn(`PlanExecutor._resolveOutputReferences: Field 'processed_result_data' for step '${sourceStepId}' is null/undefined, and fallback 'result_data' also does not exist (referenced by step ${currentStepIdForLog}).`);
                        // Keep resolvedValue as is (null/undefined) or throw error based on strictness desired.
                        // For now, let it pass as null/undefined if both are missing.
                    }
                }

                // Check if the (potentially fallback) fieldName actually exists in the output
                // Security: Use Object.prototype.hasOwnProperty.call to avoid prototype pollution.
                // eslint-disable-next-line security/detect-object-injection -- sourceStepId is validated by hasOwnProperty. Using stepOutputs[sourceStepId] as context for hasOwnProperty check on actualFieldName.
                if (!Object.prototype.hasOwnProperty.call(stepOutputs[sourceStepId], actualFieldName)) {
                     throw new Error(`Unresolved reference: Field '${actualFieldName}' not found in output of step '${sourceStepId}' (referenced by step ${currentStepIdForLog}).`);
                }

                return resolvedValue;
            }
            return data; // Not a reference
        } else if (Array.isArray(data)) {
            // Use Promise.all for concurrent async resolution of array items
            const resolvedArray = await Promise.all(data.map(item => this._resolveOutputReferences(item, stepOutputs, currentStepIdForLog)));
            return resolvedArray;
        } else if (typeof data === 'object' && data !== null) {
            const newData = {};
            for (const key in data) {
                // eslint-disable-next-line security/detect-object-injection -- 'key' is from 'data' (part of sub_task_input from plan). 'newData' is a fresh, local object, limiting impact. Plan generation should ensure 'key' is not malicious (e.g., '__proto__').
                newData[key] = await this._resolveOutputReferences(data[key], stepOutputs, currentStepIdForLog);
            }
            return newData;
        }
        return data;
    }

    _createJournalEntry(type, message, details = {}, source = "PlanExecutor") {
        return {
            timestamp: new Date().toISOString(),
            type,
            source,
            message,
            details
        };
    }

    async _summarizeStepData(dataToSummarize, userTaskString, narrativeStep, subTaskId, parentTaskId) { // Removed journalEntries
        const MAX_DATA_LENGTH = 1000;
        let dataString;

        if (typeof dataToSummarize === 'string') {
            dataString = dataToSummarize;
        } else {
            try {
                dataString = JSON.stringify(dataToSummarize);
            } catch (e) {
                console.warn(`PlanExecutor.summarizeDataWithLLM: Could not stringify data for step "${narrativeStep}". Using raw data type. Error: ${e.message}`);
                return dataToSummarize; // Return original data if stringification fails
            }
        }

        if (dataString.length > MAX_DATA_LENGTH) {
            // Journaling for summarization START/SUCCESS/FAILURE will be handled in executePlan
            console.log(`PlanExecutor._summarizeStepData: Data for step "${narrativeStep}" (SubTaskID: ${subTaskId}) is too long (${dataString.length} chars), attempting summarization.`);
            const summarizationPrompt = `The original user task was: "${userTaskString}".
A step in the execution plan, described as "${narrativeStep}", produced the following data:
---
${dataString.substring(0, MAX_DATA_LENGTH)}... (data truncated for this prompt if originally longer)
---
Please summarize this data concisely, keeping in mind its relevance to the original user task and the step description. The summary should be a string, suitable for inclusion as context for a final answer synthesis. Focus on extracting key information and outcomes. Provide only the summary text.`;
            try {
                // const summary = await this.llmService(summarizationPrompt); // OLD
                const summary = await this.aiService.generateText(summarizationPrompt, { model: (this.aiService.baseConfig && this.aiService.baseConfig.summarizationModel) || 'gpt-3.5-turbo' }); // NEW
                if (typeof summary === 'string' && summary.trim() !== "") {
                    console.log(`PlanExecutor._summarizeStepData: Summarization successful for step "${narrativeStep}" (SubTaskID: ${subTaskId}).`);
                    return summary;
                } else {
                    console.warn(`PlanExecutor._summarizeStepData: LLM returned empty or non-string summary for step "${narrativeStep}" (SubTaskID: ${subTaskId}). Original data (or its beginning) will be used.`);
                    return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long and summarization failed)" : "");
                }
            } catch (error) {
                console.error(`PlanExecutor._summarizeStepData: Error during summarization for step "${narrativeStep}" (SubTaskID: ${subTaskId}): ${error.message}`);
                // Return original (truncated) data in case of error, actual error logging will be in executePlan
                return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long, summarization error occurred)" : "");
            }
        }
        return dataToSummarize;
    }

    // Signature updated to accept resolvedSubTaskInput
    async _handleExploreSearchResults(sub_task_id, subTaskDefinition, resolvedSubTaskInput, executionContext) { // eslint-disable-line no-unused-vars
        console.log(`PlanExecutor: Handling special step ExploreSearchResults: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id}, StepID: ${subTaskDefinition.stepId})`);

        const originalSubTaskInput = subTaskDefinition.sub_task_input;
        const pageProcessingErrors = []; // Initialize array for partial errors

        let previousSearchResults = null;
        const searchResultsInput = resolvedSubTaskInput?.searchResults;

        if (searchResultsInput && Array.isArray(searchResultsInput)) {
            previousSearchResults = searchResultsInput;
        } else {
            for (let k = executionContext.length - 1; k >= 0; k--) {
                // eslint-disable-next-line security/detect-object-injection -- k is a controlled integer index. Accessing known properties.
                const potentialResults = executionContext[k].processed_result_data || executionContext[k].raw_result_data;
                // eslint-disable-next-line security/detect-object-injection -- k is a controlled integer index. Accessing known properties.
                if (executionContext[k].tool_name === "WebSearchTool" && executionContext[k].status === "COMPLETED" && potentialResults) {
                    if (Array.isArray(potentialResults)) {
                        previousSearchResults = potentialResults;
                    } else if (typeof potentialResults === 'object' && Array.isArray(potentialResults.result)) {
                        previousSearchResults = potentialResults.result;
                    }
                    break;
                }
            }
        }

        if (!previousSearchResults || !Array.isArray(previousSearchResults) || previousSearchResults.length === 0) {
            console.warn(`PlanExecutor.ExploreSearchResults (StepID: ${subTaskDefinition.stepId}): No valid search results found.`);
            return {
                sub_task_id: sub_task_id,
                stepId: subTaskDefinition.stepId,
                narrative_step: subTaskDefinition.narrative_step,
                tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator",
                sub_task_input: originalSubTaskInput,
                status: "COMPLETED",
                result_data: "No search results available to explore or results format was incompatible.",
                partial_errors: pageProcessingErrors,
                error_details: { message: "No valid search results found to explore." }
            };
        }

        const pagesToExplore = resolvedSubTaskInput?.pagesToExplore || 2;
        const linksToRead = previousSearchResults.slice(0, pagesToExplore)
            .map(item => item && item.link)
            .filter(link => typeof link === 'string' && link.trim() !== '');

        if (linksToRead.length === 0) {
            return {
                sub_task_id: sub_task_id,
                stepId: subTaskDefinition.stepId,
                narrative_step: subTaskDefinition.narrative_step,
                tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator",
                sub_task_input: originalSubTaskInput,
                status: "COMPLETED",
                result_data: "No valid links found in search results to explore.",
                partial_errors: pageProcessingErrors,
                error_details: { message: "No valid links found in search results to explore." }
            };
        }

        let aggregatedContent = "";
        const webpageReader = this.tools.ReadWebpageTool || new ReadWebpageTool();

        for (const url of linksToRead) {
            try {
                console.log(`PlanExecutor._handleExploreSearchResults: Reading URL - ${url} for SubTaskID: ${sub_task_id}, StepID: ${subTaskDefinition.stepId}`);
                const readResult = await webpageReader.execute({ url });
                if (readResult.error) {
                    const errorDetail = { url: url, errorMessage: readResult.error };
                    pageProcessingErrors.push(errorDetail);
                    aggregatedContent += `Error reading ${url}: ${readResult.error}\n---\n`;
                } else if (readResult.result) {
                    aggregatedContent += `Content from ${url}:\n${readResult.result}\n---\n`;
                }
            } catch (e) {
                const errorDetail = { url: url, errorMessage: e.message };
                pageProcessingErrors.push(errorDetail);
                aggregatedContent += `Exception while reading ${url}: ${e.message}\n---\n`;
            }
        }

        const finalErrorDetails = pageProcessingErrors.length > 0
            ? { message: `Encountered ${pageProcessingErrors.length} error(s) while processing URLs. See partial_errors for details.` }
            : null;

        return {
            sub_task_id: sub_task_id,
            stepId: subTaskDefinition.stepId,
            narrative_step: subTaskDefinition.narrative_step,
            tool_name: "ExploreSearchResults",
            assigned_agent_role: "Orchestrator",
            sub_task_input: originalSubTaskInput,
            status: "COMPLETED", // Step itself completed, even if some pages failed
            result_data: aggregatedContent.trim() || "No content could be fetched from the explored pages.",
            partial_errors: pageProcessingErrors,
            error_details: finalErrorDetails
        };
    }

    // Signature updated to accept resolvedSubTaskInput, method renamed
    async _handleLLMStepExecutor(sub_task_id, subTaskDefinition, resolvedSubTaskInput, executionContext) { // eslint-disable-line no-unused-vars
        console.log(`PlanExecutor: Handling special step LLMStepExecutor: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id}, StepID: ${subTaskDefinition.stepId})`);

        const originalSubTaskInput = subTaskDefinition.sub_task_input;
        let promptInput = resolvedSubTaskInput?.prompt; // Can be string or array (for chat)
        const promptTemplate = resolvedSubTaskInput?.prompt_template;
        const promptParams = resolvedSubTaskInput?.prompt_params || {};
        const messages = resolvedSubTaskInput?.messages; // For direct chat message input

        if (messages && Array.isArray(messages)) {
            promptInput = messages; // Use messages array directly if provided
        } else if (promptTemplate) {
            promptInput = promptTemplate;
            for (const key in promptParams) {
                // Security: Ensure only own properties of promptParams are accessed.
                if (Object.prototype.hasOwnProperty.call(promptParams, key)) {
                    const sanitizedKey = escapeRegExp(key); // Sanitize key for RegExp
                    const placeholder = new RegExp(`{{\\s*${sanitizedKey}\\s*}}`, 'g'); // eslint-disable-line security/detect-non-literal-regexp
                    // eslint-disable-next-line security/detect-object-injection -- 'key' is from 'promptParams' own properties, checked by hasOwnProperty. Value used for template filling.
                    let valueToInject = promptParams[key];
                    if (valueToInject === "{previous_step_output}") {
                        if (executionContext.length > 0) {
                        // eslint-disable-next-line security/detect-object-injection -- executionContext is an array, accessing last element with known properties.
                        const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                        valueToInject = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
                    } else {
                        valueToInject = "No data from previous steps.";
                    }
                }
                promptInput = promptInput.replace(placeholder, String(valueToInject));
              } // Closing for: if (Object.prototype.hasOwnProperty.call(promptParams, key))
            } // Closing for: for (const key in promptParams)

            // Fallback for {{previous_step_output}} should be applied after all other placeholders are processed
            if (promptInput.includes("{{previous_step_output}}")) {
                if (executionContext.length > 0) {
                    const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput));
                } else { // This else is for the inner if (executionContext.length > 0)
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), "No data from previous steps.");
                }
            }
        } // Closing for: else if (promptTemplate)
        // This else if correctly follows the `else if (promptTemplate)`
        else if (typeof promptInput !== 'string' && !Array.isArray(promptInput)) {
             promptInput = "";
        }

        // Legacy support for data_from_previous_step if no other prompt/message source
        if ((!promptInput || (typeof promptInput === 'string' && !promptInput.trim())) &&
            !Array.isArray(promptInput) &&
            resolvedSubTaskInput?.data_from_previous_step === true) {
            if (executionContext.length > 0) {
                // eslint-disable-next-line security/detect-object-injection -- executionContext is an array, accessing last element with known properties.
                const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                promptInput = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
            } else {
                promptInput = "No data from previous steps to use as prompt.";
            }
        }

        if ((typeof promptInput === 'string' && !promptInput.trim()) || (Array.isArray(promptInput) && promptInput.length === 0)) {
             return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "LLMStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "FAILED", error_details: { message: "Prompt or messages are empty or invalid for LLMStepExecutor after resolving inputs." } };
        }

        try {
            let resultData;
            const stepModel = resolvedSubTaskInput?.model || (this.aiService.baseConfig && this.aiService.baseConfig.defaultLLMStepModel) || 'gpt-3.5-turbo';
            const stepParams = { model: stepModel };
            // eslint-disable-next-line security/detect-object-injection -- resolvedSubTaskInput is from plan data, accessing known 'temperature' property for assignment.
            if (resolvedSubTaskInput?.temperature !== undefined) stepParams.temperature = resolvedSubTaskInput.temperature;
            // eslint-disable-next-line security/detect-object-injection -- resolvedSubTaskInput is from plan data, accessing known 'maxTokens' property for assignment.
            if (resolvedSubTaskInput?.maxTokens !== undefined) stepParams.maxTokens = resolvedSubTaskInput.maxTokens;

            if (Array.isArray(promptInput)) {
                const isValidMessages = promptInput.every(m => typeof m.role === 'string' && typeof m.content === 'string');
                if (!isValidMessages) throw new Error("Invalid message structure for LLMStepExecutor with chat input. Each message must have role and content as strings.");
                resultData = await this.aiService.completeChat(promptInput, stepParams);
            } else if (typeof promptInput === 'string') {
                resultData = await this.aiService.generateText(promptInput, stepParams);
            } else {
                throw new Error("Invalid promptInput type for LLMStepExecutor. Must be a string or an array of chat messages.");
            }
            return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "LLMStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "COMPLETED", result_data: resultData, error_details: null };
        } catch (e) {
            return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "LLMStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "FAILED", error_details: { message: e.message } };
        }
    }

    async _processSubTask(subTaskDefinition, parentTaskId, stepOutputs, journalEntries, stageIndex, executionContext) {
        const stepNarrative = subTaskDefinition.narrative_step;
        const stepId = subTaskDefinition.stepId;
        let resolvedSubTaskInput;

        try {
            const originalInputCopy = JSON.parse(JSON.stringify(subTaskDefinition.sub_task_input));
            resolvedSubTaskInput = await this._resolveOutputReferences(originalInputCopy, stepOutputs, stepId);
        } catch (resolutionError) {
            console.error(`PlanExecutor: Error resolving output references for stepId '${stepId}': ${resolutionError.message}`);
            journalEntries.push(this._createJournalEntry(
                "EXECUTION_STEP_PREPARATION_FAILED",
                `Failed to resolve output references for step: ${stepNarrative} (StepID: ${stepId})`,
                { parentTaskId, stageIndex, stepId, narrativeStep: stepNarrative, error: resolutionError.message }
            ));
            return Promise.resolve({ // Return a resolved promise with FAILED status
                sub_task_id: uuidv4(),
                stepId: stepId,
                narrative_step: stepNarrative,
                tool_name: subTaskDefinition.tool_name,
                assigned_agent_role: subTaskDefinition.assigned_agent_role,
                sub_task_input: subTaskDefinition.sub_task_input,
                status: "FAILED",
                error_details: { message: `Output reference resolution failed: ${resolutionError.message}` }
            });
        }

        const subTaskInputForLog = { ...subTaskDefinition.sub_task_input };

        if (subTaskDefinition.assigned_agent_role === "Orchestrator") {
            const sub_task_id_for_orchestrator_step = uuidv4();
            journalEntries.push(this._createJournalEntry(
                "EXECUTION_STEP_ORCHESTRATOR_START",
                `Orchestrator starting special step: ${stepNarrative} (StepID: ${stepId})`,
                { parentTaskId, stageIndex, subTaskId: sub_task_id_for_orchestrator_step, stepId, narrativeStep: stepNarrative, toolName: subTaskDefinition.tool_name, subTaskInput: subTaskInputForLog }
            ));
            if (subTaskDefinition.tool_name === "ExploreSearchResults") {
                return this._handleExploreSearchResults(sub_task_id_for_orchestrator_step, subTaskDefinition, resolvedSubTaskInput, executionContext);
            } else if (subTaskDefinition.tool_name === "LLMStepExecutor") {
                return this._handleLLMStepExecutor(sub_task_id_for_orchestrator_step, subTaskDefinition, resolvedSubTaskInput, executionContext);
            } else if (subTaskDefinition.tool_name === "FileSystemTool" || subTaskDefinition.tool_name === "FileDownloaderTool") {
                return (async () => {
                    let tool;
                    const taskWorkspaceDir = path.join(this.savedTasksBaseDir, parentTaskId, 'workspace');
                    try {
                        await fsp.mkdir(taskWorkspaceDir, { recursive: true });
                        if (subTaskDefinition.tool_name === "FileSystemTool") {
                            tool = new FileSystemTool(taskWorkspaceDir);
                        } else {
                            tool = new FileDownloaderTool(taskWorkspaceDir);
                        }
                        const operation = resolvedSubTaskInput.operation;
                        const opParams = resolvedSubTaskInput.params;
                        const allowedOperations = Object.getOwnPropertyNames(Object.getPrototypeOf(tool)).filter(prop => typeof tool[prop] === 'function' && !prop.startsWith('_') && prop !== 'constructor');
                        if (typeof tool[operation] !== 'function' || !allowedOperations.includes(operation) ) {
                            throw new Error(`Operation '${operation}' not found or not allowed on tool '${subTaskDefinition.tool_name}'.`);
                        }
                        const toolResult = await tool[operation](opParams);
                        return {
                            sub_task_id: sub_task_id_for_orchestrator_step,
                            stepId: stepId,
                            narrative_step: stepNarrative,
                            tool_name: subTaskDefinition.tool_name,
                            assigned_agent_role: "Orchestrator",
                            sub_task_input: subTaskDefinition.sub_task_input,
                            status: toolResult.error ? "FAILED" : "COMPLETED",
                            result_data: toolResult.result,
                            error_details: toolResult.error ? { message: toolResult.error } : null
                        };
                    } catch (err) {
                        console.error(`PlanExecutor: Error executing Orchestrator tool ${subTaskDefinition.tool_name}, operation ${resolvedSubTaskInput.operation} (StepID: ${stepId}): ${err.message}`);
                        return {
                            sub_task_id: sub_task_id_for_orchestrator_step,
                            stepId: stepId,
                            narrative_step: stepNarrative,
                            tool_name: subTaskDefinition.tool_name,
                            assigned_agent_role: "Orchestrator",
                            sub_task_input: subTaskDefinition.sub_task_input,
                            status: "FAILED",
                            error_details: { message: err.message }
                        };
                    }
                })();
            } else {
                 console.error(`PlanExecutor: Unknown tool '${subTaskDefinition.tool_name}' for Orchestrator role. Step: "${stepNarrative}" (StepID: ${stepId})`);
                 return Promise.resolve({
                    sub_task_id: sub_task_id_for_orchestrator_step,
                    stepId: stepId,
                    narrative_step: stepNarrative,
                    tool_name: subTaskDefinition.tool_name,
                    assigned_agent_role: "Orchestrator",
                    sub_task_input: subTaskDefinition.sub_task_input,
                    status: "FAILED",
                    error_details: { message: `Unknown Orchestrator tool: ${subTaskDefinition.tool_name}` }
                });
            }
        } else {
            const sub_task_id = uuidv4();
            const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: resolvedSubTaskInput, narrative_step: stepNarrative, stepId: stepId };
            journalEntries.push(this._createJournalEntry(
                "EXECUTION_STEP_DISPATCHED",
                `Dispatching step: ${stepNarrative} (SubTaskID: ${sub_task_id}, StepID: ${stepId}) to agent ${taskMessage.assigned_agent_role}`,
                { parentTaskId, stageIndex, subTaskId: sub_task_id, stepId, narrativeStep: stepNarrative, toolName: taskMessage.tool_name, agentRole: taskMessage.assigned_agent_role, subTaskInputForLog }
            ));
            this.subTaskQueue.enqueueTask(taskMessage);
            console.log(`PlanExecutor: Dispatched sub-task ${sub_task_id} (StepID: ${stepId}) for role ${taskMessage.assigned_agent_role} - Step: "${stepNarrative}" for Stage ${stageIndex}`);
            return new Promise((resolve) => {
                this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                    const resultDetails = { parentTaskId, stageIndex, subTaskId: sub_task_id, narrativeStep: stepNarrative };
                    if (error) {
                        journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_ERROR", `Error or timeout for SubTaskID: ${sub_task_id}`, { ...resultDetails, error: error.message }));
                        console.error(`PlanExecutor: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${stageIndex}):`, error.message);
                        resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: error.message } });
                    } else if (resultMsg) {
                        const resultDataPreview = typeof resultMsg.result_data === 'string' ? resultMsg.result_data.substring(0,100) + '...' : String(resultMsg.result_data);
                        journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_RECEIVED", `Result received for SubTaskID: ${sub_task_id}, Status: ${resultMsg.status}`, { ...resultDetails, status: resultMsg.status, agentRole: resultMsg.worker_agent_role, resultDataPreview, errorDetails: resultMsg.error_details }));
                        if (resultMsg.sub_task_id === sub_task_id) {
                            console.log(`PlanExecutor: Received result for sub_task_id ${sub_task_id} (Stage ${stageIndex}). Status: ${resultMsg.status}`);
                            resolve({
                                sub_task_id,
                                stepId: taskMessage.stepId,
                                narrative_step: stepNarrative,
                                tool_name: taskMessage.tool_name,
                                sub_task_input: subTaskDefinition.sub_task_input,
                                assigned_agent_role: taskMessage.assigned_agent_role,
                                status: resultMsg.status,
                                result_data: resultMsg.result_data,
                                error_details: resultMsg.error_details
                            });
                        } else {
                            const errorMessage = `Critical - Mismatched sub_task_id. Expected ${sub_task_id}, got ${resultMsg.sub_task_id} (StepID: ${taskMessage.stepId})`;
                            journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_ERROR", errorMessage, { ...resultDetails, stepId: taskMessage.stepId, expectedSubTaskId: sub_task_id, receivedSubTaskId: resultMsg.sub_task_id }));
                            console.error(`PlanExecutor: ${errorMessage} for parent_task_id ${parentTaskId} (Stage ${stageIndex}).`);
                            resolve({
                                sub_task_id,
                                stepId: taskMessage.stepId,
                                narrative_step: stepNarrative,
                                tool_name: taskMessage.tool_name,
                                sub_task_input: subTaskDefinition.sub_task_input,
                                assigned_agent_role: taskMessage.assigned_agent_role,
                                status: "FAILED",
                                error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage }
                            });
                        }
                    }
                }, sub_task_id);
            });
        }
    }

    async _executeStage(stageIndex, currentStageTaskDefinitions, parentTaskId, userTaskString, stepOutputs, journalEntries, executionContext, collectedKeyFindings, collectedErrors) {
        journalEntries.push(this._createJournalEntry(
            "EXECUTION_STAGE_START",
            `Starting Stage ${stageIndex}/${currentStageTaskDefinitions.length}`, // Note: This length might be off if planStages.length was intended
            { parentTaskId, stageIndex, stageTaskCount: currentStageTaskDefinitions.length }
        ));
        console.log(`PlanExecutor: Starting Stage ${stageIndex} with ${currentStageTaskDefinitions.length} sub-task(s).`);

        const stageSubTaskPromises = [];
        for (const subTaskDefinition of currentStageTaskDefinitions) {
            stageSubTaskPromises.push(this._processSubTask(subTaskDefinition, parentTaskId, stepOutputs, journalEntries, stageIndex, executionContext));
        }

        const stageResults = await Promise.all(stageSubTaskPromises);
        const stageContextEntriesForCurrentStage = [];
        let firstFailedStepErrorDetailsInStage = null;
        let stageFailed = false;

        for (let j = 0; j < stageResults.length; j++) {
            const resultOfSubTask = stageResults[j];
            const originalSubTaskDef = currentStageTaskDefinitions[j];
            const subTaskIdForResult = resultOfSubTask.sub_task_id;
            const stepIdForResult = resultOfSubTask.stepId || originalSubTaskDef.stepId;
            let processedData = resultOfSubTask.result_data;
            const summarizationLogDetails = { parentTaskId, stageIndex, subTaskId: subTaskIdForResult, stepId: stepIdForResult, narrativeStep: resultOfSubTask.narrative_step };

            if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                (resultOfSubTask.assigned_agent_role !== "Orchestrator" ||
                 (resultOfSubTask.assigned_agent_role === "Orchestrator" && originalSubTaskDef.tool_name === "ExploreSearchResults"))) {
                journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_START", `Summarizing data for step: ${resultOfSubTask.narrative_step} (StepID: ${stepIdForResult})`, summarizationLogDetails));
                const originalDataForPreview = resultOfSubTask.result_data;
                try {
                    const summary = await this._summarizeStepData(resultOfSubTask.result_data, userTaskString, resultOfSubTask.narrative_step, subTaskIdForResult, parentTaskId);
                    if (summary !== resultOfSubTask.result_data) {
                         journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_SUCCESS", `Successfully summarized data for step: ${resultOfSubTask.narrative_step} (StepID: ${stepIdForResult})`, { ...summarizationLogDetails, summarizedDataPreview: String(summary).substring(0,100) + "..."}));
                    }
                    processedData = summary;
                } catch (summarizationError) {
                    journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_FAILED", `Summarization failed for step: ${resultOfSubTask.narrative_step} (StepID: ${stepIdForResult})`, { ...summarizationLogDetails, errorMessage: summarizationError.message }));
                    console.error(`PlanExecutor: Error during _summarizeStepData call for SubTaskID ${subTaskIdForResult} (StepID: ${stepIdForResult}): ${summarizationError.message}`);
                    processedData = originalDataForPreview;
                }
            }

            const contextEntry = {
                stepId: stepIdForResult,
                narrative_step: resultOfSubTask.narrative_step || originalSubTaskDef.narrative_step,
                assigned_agent_role: resultOfSubTask.assigned_agent_role || originalSubTaskDef.assigned_agent_role,
                tool_name: resultOfSubTask.tool_name || originalSubTaskDef.tool_name,
                sub_task_input: originalSubTaskDef.sub_task_input,
                status: resultOfSubTask.status,
                processed_result_data: processedData,
                raw_result_data: resultOfSubTask.result_data,
                error_details: resultOfSubTask.error_details,
                sub_task_id: subTaskIdForResult
            };
            stageContextEntriesForCurrentStage.push(contextEntry);

            if (contextEntry.stepId) {
                stepOutputs[contextEntry.stepId] = {
                    status: contextEntry.status,
                    result_data: contextEntry.raw_result_data,
                    processed_result_data: contextEntry.processed_result_data,
                    error_details: contextEntry.error_details
                };
            }

            if (contextEntry.tool_name === "ExploreSearchResults" && resultOfSubTask.partial_errors && resultOfSubTask.partial_errors.length > 0) {
                journalEntries.push(this._createJournalEntry(
                    "EXECUTION_STEP_PARTIAL_ERRORS",
                    `Step '${contextEntry.narrative_step}' (Tool: ${contextEntry.tool_name}, StepID: ${contextEntry.stepId}) completed with ${resultOfSubTask.partial_errors.length} partial error(s) while processing URLs.`,
                    { parentTaskId, stageIndex, subTaskId: contextEntry.sub_task_id, stepId: contextEntry.stepId, partialErrorCount: resultOfSubTask.partial_errors.length, errors: resultOfSubTask.partial_errors }
                ));
                for (const partialErr of resultOfSubTask.partial_errors) {
                    collectedErrors.push({
                        errorId: uuidv4(),
                        sourceStepNarrative: `${contextEntry.narrative_step} (processing URL: ${partialErr.url || 'Unknown URL'})`,
                        sourceToolName: contextEntry.tool_name,
                        errorMessage: partialErr.errorMessage,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            const logDetails = { parentTaskId, stageIndex, subTaskId: contextEntry.sub_task_id, stepId: contextEntry.stepId, narrativeStep: contextEntry.narrative_step, toolName: contextEntry.tool_name, agentRole: contextEntry.assigned_agent_role };
            const dataPreviewForLog = contextEntry.processed_result_data !== undefined ? contextEntry.processed_result_data : contextEntry.raw_result_data;

            if (contextEntry.status === "COMPLETED") {
                journalEntries.push(this._createJournalEntry("EXECUTION_STEP_COMPLETED", `Step completed: ${contextEntry.narrative_step}`, { ...logDetails, processedResultDataPreview: String(dataPreviewForLog).substring(0, 100) + "..." }));
                const findingData = contextEntry.processed_result_data || contextEntry.raw_result_data;
                if (findingData || (typeof findingData === 'boolean' || typeof findingData === 'number')) {
                    let dataToStore = findingData;
                    const MAX_FINDING_DATA_LENGTH = 500;
                    if (typeof findingData === 'string' && findingData.length > MAX_FINDING_DATA_LENGTH) {
                        dataToStore = findingData.substring(0, MAX_FINDING_DATA_LENGTH) + "...";
                    }
                    collectedKeyFindings.push({
                        findingId: uuidv4(),
                        sourceStepNarrative: contextEntry.narrative_step,
                        sourceToolName: contextEntry.tool_name,
                        data: dataToStore,
                        timestamp: new Date().toISOString()
                    });
                    if (this.memoryManager) {
                        try {
                            // parentTaskId доступен в _executeStage как параметр
                            await this.memoryManager.saveKeyFinding(parentTaskId, keyFinding);
                        } catch (saveError) {
                            console.error(`PlanExecutor._executeStage: Failed to save key finding for task ${parentTaskId}, step ${contextEntry.stepId}. Error: ${saveError.message}`);
                            // Не прерываем выполнение плана из-за ошибки сохранения находки
                        }
                    }
                }
            } else if (contextEntry.status === "FAILED") {
                journalEntries.push(this._createJournalEntry("EXECUTION_STEP_FAILED", `Step failed: ${contextEntry.narrative_step}`, { ...logDetails, errorDetails: contextEntry.error_details }));
                if (!firstFailedStepErrorDetailsInStage) {
                    firstFailedStepErrorDetailsInStage = { // Directly assign the whole object as per new structure
                        sub_task_id: contextEntry.sub_task_id,
                        stepId: contextEntry.stepId,
                        narrative_step: contextEntry.narrative_step,
                        tool_name: contextEntry.tool_name,
                        assigned_agent_role: contextEntry.assigned_agent_role,
                        sub_task_input: contextEntry.sub_task_input,
                        error_details: contextEntry.error_details || { message: "Unknown error in failed step." }
                    };
                }
                if (contextEntry.error_details) {
                    collectedErrors.push({
                        errorId: uuidv4(),
                        sourceStepNarrative: contextEntry.narrative_step,
                        sourceToolName: contextEntry.tool_name,
                        errorMessage: contextEntry.error_details.message || JSON.stringify(contextEntry.error_details),
                        timestamp: new Date().toISOString()
                    });
                }
                stageFailed = true; // Mark stage as failed
            }
        }

        // Determine stage success based on entries processed in this stage
        for (const entry of stageContextEntriesForCurrentStage) {
            if (entry.status === "FAILED") {
                stageFailed = true;
                break;
            }
        }

        return { stageSuccess: !stageFailed, stageContextEntries: stageContextEntriesForCurrentStage, failedStepDetails: firstFailedStepErrorDetailsInStage };
    }

    async executePlan(planStages, parentTaskId, userTaskString) {
        const stepOutputs = {}; // Initialize stepOutputs map
        const journalEntries = [];
        const executionContext = []; // This will accumulate all stageContextEntries
        const collectedKeyFindings = [];
        const collectedErrors = [];
        let overallSuccess = true;
        // finalAnswerOutput and finalAnswerWasSynthesized are removed from here
        let failedStepDetails = null; // This will hold the details of the first failed step in any stage

        journalEntries.push(this._createJournalEntry(
            "PLAN_EXECUTION_START",
            `Starting execution of plan for ParentTaskID: ${parentTaskId}`,
            { parentTaskId, stageCount: planStages.length }
        ));

        for (let i = 0; i < planStages.length; i++) {
            const currentStageTaskDefinitions = planStages[i];
            const stageIndex = i + 1;

            // Call the new _executeStage method
            const stageResult = await this._executeStage(
                stageIndex,
                currentStageTaskDefinitions,
                parentTaskId,
                userTaskString,
                stepOutputs,      // Mutated
                journalEntries,   // Mutated
                executionContext, // Passed for context, not directly mutated by _executeStage for its main list
                collectedKeyFindings, // Mutated
                collectedErrors     // Mutated
            );

            // Append results from the executed stage to the overall executionContext
            if (stageResult.stageContextEntries) {
                executionContext.push(...stageResult.stageContextEntries);
            }

            if (!stageResult.stageSuccess) {
                overallSuccess = false;
                failedStepDetails = stageResult.failedStepDetails; // Capture details of the first failed step
                const reason = failedStepDetails ?
                               `Step ${failedStepDetails.stepId || failedStepDetails.sub_task_id} ("${failedStepDetails.narrative_step}") failed: ${failedStepDetails.error_details.message || 'Unknown error'}` :
                               "A step in the stage failed.";
                journalEntries.push(this._createJournalEntry("EXECUTION_STAGE_FAILED", `Stage ${stageIndex} failed. Reason: ${reason}. Halting plan execution.`, { parentTaskId, stageIndex, reason: failedStepDetails }));
                console.error(`PlanExecutor: Stage ${stageIndex} failed. Halting further stages.`);
                break; // Halt plan execution
            } else {
                journalEntries.push(this._createJournalEntry("EXECUTION_STAGE_COMPLETED", `Stage ${stageIndex} completed successfully.`, { parentTaskId, stageIndex }));
                console.log(`PlanExecutor: Stage ${stageIndex} completed successfully.`);
            }
        }

        journalEntries.push(this._createJournalEntry(
            overallSuccess ? "PLAN_EXECUTION_COMPLETED" : "PLAN_EXECUTION_FAILED",
            `Execution of plan for ParentTaskID: ${parentTaskId} finished. Success: ${overallSuccess}`,
            { parentTaskId, overallSuccess }
        ));
        console.log(`PlanExecutor: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);

        let finalAnswerResult = { finalAnswerOutput: null, finalAnswerWasSynthesized: false };
        if (overallSuccess) {
            finalAnswerResult = this._extractFinalAnswer(executionContext, journalEntries, parentTaskId);
        }

        return {
            success: overallSuccess,
            executionContext,
            journalEntries,
            updatesForWorkingContext: {
                keyFindings: collectedKeyFindings,
                errorsEncountered: collectedErrors
            },
            finalAnswer: finalAnswerResult.finalAnswerOutput,
            finalAnswerSynthesized: finalAnswerResult.finalAnswerWasSynthesized,
            failedStepDetails: failedStepDetails // Add the new field here
        };
    }

    _extractFinalAnswer(executionContext, journalEntries, parentTaskId) {
        let finalAnswerOutput = null;
        let finalAnswerWasSynthesized = false;

        if (executionContext.length > 0) {
            const lastStepContext = executionContext[executionContext.length - 1];
            if (lastStepContext.status === "COMPLETED" &&
                lastStepContext.assigned_agent_role === "Orchestrator" &&
                lastStepContext.tool_name === "LLMStepExecutor" &&
                lastStepContext.sub_task_input &&
                lastStepContext.sub_task_input.isFinalAnswer === true) {

                finalAnswerOutput = lastStepContext.processed_result_data || lastStepContext.raw_result_data;
                finalAnswerWasSynthesized = true;

                journalEntries.push(this._createJournalEntry(
                    "PLAN_EXECUTOR_FINAL_ANSWER_IDENTIFIED",
                    "Final answer was marked as synthesized by PlanExecutor within a plan step.",
                    {
                        parentTaskId,
                        stepNarrative: lastStepContext.narrative_step,
                        subTaskId: lastStepContext.sub_task_id,
                        stepId: lastStepContext.stepId
                    }
                ));
                console.log(`PlanExecutor: Final answer identified as pre-synthesized by step: "${lastStepContext.narrative_step}" (StepID: ${lastStepContext.stepId})`);
            }
        }
        return { finalAnswerOutput, finalAnswerWasSynthesized };
    }
}

module.exports = PlanExecutor;
