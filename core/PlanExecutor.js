// core/PlanExecutor.js
const { v4: uuidv4 } = require('uuid');
const path = require('path'); // Added for workspace path construction
const fsp = require('fs').promises; // Added for mkdir

const ReadWebpageTool = require('../tools/ReadWebpageTool');
const FileSystemTool = require('../tools/FileSystemTool'); // Added
const FileDownloaderTool = require('../tools/FileDownloaderTool'); // Added

class PlanExecutor {
    constructor(subTaskQueue, resultsQueue, llmService, tools = {}, savedTasksBaseDir) {
        this.subTaskQueue = subTaskQueue;
        this.resultsQueue = resultsQueue;
        this.llmService = llmService;
        this.tools = tools;
        this.savedTasksBaseDir = savedTasksBaseDir; // Store this
        if (!this.savedTasksBaseDir) {
            // Fallback or error if not provided by Orchestrator, though it should be.
            console.warn("PlanExecutor: savedTasksBaseDir not provided, defaulting to './saved_tasks'. This may be incorrect.");
            this.savedTasksBaseDir = path.resolve('./saved_tasks');
        }
    }

    _resolveOutputReferences(data, stepOutputs, currentStepIdForLog = '') {
        const referenceRegex = /^@{outputs\.([a-zA-Z0-9_.-]+)\.(result_data|processed_result_data)}$/; // Full string match

        if (typeof data === 'string') {
            const match = data.match(referenceRegex);
            if (match) {
                const sourceStepId = match[1];
                const fieldName = match[2];

                if (!stepOutputs[sourceStepId]) {
                    throw new Error(`Unresolved reference: Step ID '${sourceStepId}' not found in outputs (referenced by step ${currentStepIdForLog}).`);
                }
                if (stepOutputs[sourceStepId].status !== "COMPLETED") {
                    // Allow referencing outputs of FAILED steps if necessary for some specific recovery/logging tools,
                    // but typically one would expect to reference COMPLETED steps.
                    // For now, strict check for COMPLETED. This can be relaxed if a use case arises.
                     console.warn(`PlanExecutor._resolveOutputReferences: Referenced step '${sourceStepId}' did not complete successfully. Status: ${stepOutputs[sourceStepId].status} (referenced by step ${currentStepIdForLog}). Output might be null or incomplete.`);
                     // If strict failure is desired:
                     // throw new Error(`Unresolved reference: Referenced step '${sourceStepId}' did not complete successfully. Status: ${stepOutputs[sourceStepId].status} (referenced by step ${currentStepIdForLog}).`);
                }
                if (!(fieldName in stepOutputs[sourceStepId])) {
                    // This case should ideally not happen if stepOutputs always populates both fields (even if null/undefined)
                    throw new Error(`Unresolved reference: Field '${fieldName}' not found in output of step '${sourceStepId}' (referenced by step ${currentStepIdForLog}).`);
                }

                // If fieldName is 'processed_result_data' and it's undefined or null, fallback to 'result_data'
                let resolvedValue = stepOutputs[sourceStepId][fieldName];
                if (fieldName === 'processed_result_data' && (resolvedValue === undefined || resolvedValue === null)) {
                    resolvedValue = stepOutputs[sourceStepId]['result_data'];
                }

                // If the entire string is a reference, return the resolved value directly (could be an object/array)
                return resolvedValue;
            }
            return data; // Not a reference or not a full-string reference
        } else if (Array.isArray(data)) {
            return data.map(item => this._resolveOutputReferences(item, stepOutputs, currentStepIdForLog));
        } else if (typeof data === 'object' && data !== null) {
            const newData = {};
            for (const key in data) {
                newData[key] = this._resolveOutputReferences(data[key], stepOutputs, currentStepIdForLog);
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
                const summary = await this.llmService(summarizationPrompt);
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
    async _handleExploreSearchResults(sub_task_id, subTaskDefinition, resolvedSubTaskInput, executionContext, parentTaskId) {
        console.log(`PlanExecutor: Handling special step ExploreSearchResults: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id}, StepID: ${subTaskDefinition.stepId})`);

        // Use resolvedSubTaskInput for logic, but subTaskDefinition.sub_task_input for returning in context
        const originalSubTaskInput = subTaskDefinition.sub_task_input;

        let previousSearchResults = null;
        // previous_step_output or specific stepId reference should be resolved by _resolveOutputReferences
        // If ExploreSearchResults relies on implicit last WebSearchTool output, this logic needs adjustment
        // For now, assuming 'previousSearchResults' might be directly provided via resolvedSubTaskInput if the plan uses output referencing
        // or we keep the existing logic if it's implicitly the last WebSearchTool result.
        // Let's assume for now that specific search results are passed in via resolvedSubTaskInput if needed.
        // If not, this part needs to be smarter or the plan more explicit.
        // For this iteration, we'll keep the existing implicit search for previous WebSearchTool if not directly provided.
        // A more robust way would be for the plan to *always* reference the search results explicitly.

        const searchResultsInput = resolvedSubTaskInput?.searchResults; // Example: plan could specify @{outputs.search_step.result_data}

        if (searchResultsInput && Array.isArray(searchResultsInput)) {
            previousSearchResults = searchResultsInput;
        } else {
            // Fallback to existing implicit search if not explicitly provided
            for (let k = executionContext.length - 1; k >= 0; k--) {
                const potentialResults = executionContext[k].processed_result_data || executionContext[k].raw_result_data;
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
            console.warn(`PlanExecutor.ExploreSearchResults (StepID: ${subTaskDefinition.stepId}): No valid search results found from previous steps or resolved input.`);
            return {
                sub_task_id: sub_task_id,
                stepId: subTaskDefinition.stepId, // Ensure stepId is returned
                narrative_step: subTaskDefinition.narrative_step,
                tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator",
                sub_task_input: originalSubTaskInput, // Return original input
                status: "COMPLETED", // Or FAILED if this is critical
                result_data: "No search results available to explore or results format was incompatible.",
                error_details: null // Or an error if considered a failure
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
                error_details: null
            };
        }

        let aggregatedContent = "";
        const webpageReader = this.tools.ReadWebpageTool || new ReadWebpageTool();

        for (const url of linksToRead) {
            try {
                console.log(`PlanExecutor._handleExploreSearchResults: Reading URL - ${url} for SubTaskID: ${sub_task_id}`);
                const readResult = await webpageReader.execute({ url });
                if (readResult.error) {
                    aggregatedContent += `Error reading ${url}: ${readResult.error}\n---\n`;
                } else if (readResult.result) {
                    aggregatedContent += `Content from ${url}:\n${readResult.result}\n---\n`;
                }
            } catch (e) {
                aggregatedContent += `Exception while reading ${url}: ${e.message}\n---\n`;
            }
        }
        return {
            sub_task_id: sub_task_id,
            stepId: subTaskDefinition.stepId,
            narrative_step: subTaskDefinition.narrative_step,
            tool_name: "ExploreSearchResults",
            assigned_agent_role: "Orchestrator",
            sub_task_input: originalSubTaskInput, // Return original input
            status: "COMPLETED",
            result_data: aggregatedContent || "No content could be fetched from the explored pages.",
            error_details: null
        };
    }

    // Signature updated to accept resolvedSubTaskInput
    async _handleGeminiStepExecutor(sub_task_id, subTaskDefinition, resolvedSubTaskInput, executionContext, parentTaskId) {
        console.log(`PlanExecutor: Handling special step GeminiStepExecutor: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id}, StepID: ${subTaskDefinition.stepId})`);

        // Use resolvedSubTaskInput for logic, but subTaskDefinition.sub_task_input for returning in context
        const originalSubTaskInput = subTaskDefinition.sub_task_input;
        let promptInput = resolvedSubTaskInput?.prompt || "";
        const promptTemplate = resolvedSubTaskInput?.prompt_template; // Note: templates themselves are not resolved by _resolveOutputReferences
        const promptParams = resolvedSubTaskInput?.prompt_params || {}; // These param values *would* have been resolved

        if (promptTemplate) {
            promptInput = promptTemplate;
            // Params are already resolved if they were references.
            // If prompt_params contains "{previous_step_output}", this specific string needs to be handled here.
            // This is a deviation from pure @{outputs...} but might be a pre-existing convention.
            for (const key in promptParams) {
                const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
                let valueToInject = promptParams[key];
                if (valueToInject === "{previous_step_output}") { // Handle legacy placeholder
                    if (executionContext.length > 0) {
                         // This implicitly takes output from the very last step in executionContext, not necessarily a specific stepId.
                         // For more precise control, @{outputs.SOURCE_STEP_ID.FIELD} should be used in the template directly.
                        const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                        valueToInject = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
                    } else {
                        valueToInject = "No data from previous steps.";
                    }
                }
                promptInput = promptInput.replace(placeholder, String(valueToInject)); // Ensure valueToInject is a string
            }
             // Fallback for {{previous_step_output}} if not in prompt_params but directly in template
            if (promptInput.includes("{{previous_step_output}}")) {
                if (executionContext.length > 0) {
                    const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput));
                } else {
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), "No data from previous steps.");
                }
            }
        } else if (!promptInput && resolvedSubTaskInput?.data_from_previous_step === true) { // Legacy support
             if (executionContext.length > 0) {
                const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                promptInput = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
            } else {
                promptInput = "No data from previous steps to use as prompt.";
            }
        }
        // If promptInput is still empty after all this (e.g. only `prompt` field was expected but was empty), it's an issue.
        if (typeof promptInput !== 'string' || !promptInput.trim()) {
             return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "FAILED", error_details: { message: "Prompt is empty or invalid for GeminiStepExecutor after resolving inputs." } };
        }

        try {
            const resultData = await this.llmService(promptInput);
            return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "COMPLETED", result_data: resultData, error_details: null };
        } catch (e) {
            return { sub_task_id: sub_task_id, stepId: subTaskDefinition.stepId, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: originalSubTaskInput, status: "FAILED", error_details: { message: e.message } };
        }
    }

    async executePlan(planStages, parentTaskId, userTaskString) {
        const stepOutputs = {}; // Initialize stepOutputs map
        const journalEntries = [];
        const executionContext = [];
        const collectedKeyFindings = [];
        const collectedErrors = [];
        let overallSuccess = true;
        let finalAnswerOutput = null;
        let finalAnswerWasSynthesized = false;
        let failedStepDetails = null; // Initialize failedStepDetails

        journalEntries.push(this._createJournalEntry(
            "PLAN_EXECUTION_START",
            `Starting execution of plan for ParentTaskID: ${parentTaskId}`,
            { parentTaskId, stageCount: planStages.length }
        ));

        for (let i = 0; i < planStages.length; i++) {
            const currentStageTaskDefinitions = planStages[i];
            const stageIndex = i + 1;
            journalEntries.push(this._createJournalEntry(
                "EXECUTION_STAGE_START",
                `Starting Stage ${stageIndex}/${planStages.length}`,
                { parentTaskId, stageIndex, stageTaskCount: currentStageTaskDefinitions.length }
            ));
            console.log(`PlanExecutor: Starting Stage ${stageIndex}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`);

            const stageSubTaskPromises = [];

            for (const subTaskDefinition of currentStageTaskDefinitions) {
                const stepNarrative = subTaskDefinition.narrative_step;
                const stepId = subTaskDefinition.stepId; // Essential for logging and output tracking

                let resolvedSubTaskInput;
                try {
                    // Deep copy original input before resolving, to keep original for contextEntry
                    const originalInputCopy = JSON.parse(JSON.stringify(subTaskDefinition.sub_task_input));
                    resolvedSubTaskInput = this._resolveOutputReferences(originalInputCopy, stepOutputs, stepId);
                } catch (resolutionError) {
                    console.error(`PlanExecutor: Error resolving output references for stepId '${stepId}': ${resolutionError.message}`);
                    journalEntries.push(this._createJournalEntry(
                        "EXECUTION_STEP_PREPARATION_FAILED",
                        `Failed to resolve output references for step: ${stepNarrative} (StepID: ${stepId})`,
                        { parentTaskId, stageIndex, stepId, narrativeStep: stepNarrative, error: resolutionError.message }
                    ));
                    stageSubTaskPromises.push(Promise.resolve({
                        sub_task_id: uuidv4(), // Generate a sub_task_id for this failure point
                        stepId: stepId,
                        narrative_step: stepNarrative,
                        tool_name: subTaskDefinition.tool_name,
                        assigned_agent_role: subTaskDefinition.assigned_agent_role,
                        sub_task_input: subTaskDefinition.sub_task_input, // original input
                        status: "FAILED",
                        error_details: { message: `Output reference resolution failed: ${resolutionError.message}` }
                    }));
                    continue; // Skip to next task in stage
                }

                // subTaskInputForLog should ideally be the resolved one for better debugging of what the tool *actually* received.
                // However, the original with @-references is also useful. For now, log original.
                const subTaskInputForLog = { ...subTaskDefinition.sub_task_input };


                if (subTaskDefinition.assigned_agent_role === "Orchestrator") {
                    const sub_task_id_for_orchestrator_step = uuidv4();
                    journalEntries.push(this._createJournalEntry(
                        "EXECUTION_STEP_ORCHESTRATOR_START",
                        `Orchestrator starting special step: ${stepNarrative} (StepID: ${stepId})`,
                        { parentTaskId, stageIndex, subTaskId: sub_task_id_for_orchestrator_step, stepId, narrativeStep: stepNarrative, toolName: subTaskDefinition.tool_name, subTaskInput: subTaskInputForLog }
                    ));
                    if (subTaskDefinition.tool_name === "ExploreSearchResults") {
                        // Pass resolvedSubTaskInput and subTaskDefinition
                        stageSubTaskPromises.push(this._handleExploreSearchResults(sub_task_id_for_orchestrator_step, subTaskDefinition, resolvedSubTaskInput, executionContext, parentTaskId));
                    } else if (subTaskDefinition.tool_name === "GeminiStepExecutor") {
                        // Pass resolvedSubTaskInput and subTaskDefinition
                        stageSubTaskPromises.push(this._handleGeminiStepExecutor(sub_task_id_for_orchestrator_step, subTaskDefinition, resolvedSubTaskInput, executionContext, parentTaskId));
                    } else if (subTaskDefinition.tool_name === "FileSystemTool" || subTaskDefinition.tool_name === "FileDownloaderTool") {
                        const toolPromise = (async () => {
                            let tool;
                            const taskWorkspaceDir = path.join(this.savedTasksBaseDir, parentTaskId, 'workspace');
                            try {
                                await fsp.mkdir(taskWorkspaceDir, { recursive: true });
                                if (subTaskDefinition.tool_name === "FileSystemTool") {
                                    tool = new FileSystemTool(taskWorkspaceDir);
                                } else {
                                    tool = new FileDownloaderTool(taskWorkspaceDir);
                                }
                                // Use resolvedSubTaskInput for operations
                                const operation = resolvedSubTaskInput.operation;
                                const opParams = resolvedSubTaskInput.params;

                                if (typeof tool[operation] !== 'function') {
                                    throw new Error(`Operation '${operation}' not found on tool '${subTaskDefinition.tool_name}'.`);
                                }

                                const toolResult = await tool[operation](opParams);
                                return {
                                    sub_task_id: sub_task_id_for_orchestrator_step,
                                    stepId: stepId,
                                    narrative_step: stepNarrative,
                                    tool_name: subTaskDefinition.tool_name,
                                    assigned_agent_role: "Orchestrator",
                                    sub_task_input: subTaskDefinition.sub_task_input, // original input
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
                                    sub_task_input: subTaskDefinition.sub_task_input, // original input
                                    status: "FAILED",
                                    error_details: { message: err.message }
                                };
                            }
                        })();
                        stageSubTaskPromises.push(toolPromise);
                    } else {
                         console.error(`PlanExecutor: Unknown tool '${subTaskDefinition.tool_name}' for Orchestrator role. Step: "${stepNarrative}" (StepID: ${stepId})`);
                         stageSubTaskPromises.push(Promise.resolve({
                            sub_task_id: sub_task_id_for_orchestrator_step,
                            stepId: stepId,
                            narrative_step: stepNarrative,
                            tool_name: subTaskDefinition.tool_name,
                            assigned_agent_role: "Orchestrator",
                            sub_task_input: subTaskDefinition.sub_task_input, // original input
                            status: "FAILED",
                            error_details: { message: `Unknown Orchestrator tool: ${subTaskDefinition.tool_name}` }
                        }));
                    }
                } else {
                    const sub_task_id = uuidv4();
                    // Use resolvedSubTaskInput for the task message
                    const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: resolvedSubTaskInput, narrative_step: stepNarrative, stepId: stepId };

                    journalEntries.push(this._createJournalEntry(
                        "EXECUTION_STEP_DISPATCHED",
                        `Dispatching step: ${stepNarrative} (SubTaskID: ${sub_task_id}, StepID: ${stepId}) to agent ${taskMessage.assigned_agent_role}`,
                        { parentTaskId, stageIndex, subTaskId: sub_task_id, stepId, narrativeStep: stepNarrative, toolName: taskMessage.tool_name, agentRole: taskMessage.assigned_agent_role, subTaskInputForLog }
                    ));
                    this.subTaskQueue.enqueueTask(taskMessage);
                    console.log(`PlanExecutor: Dispatched sub-task ${sub_task_id} (StepID: ${stepId}) for role ${taskMessage.assigned_agent_role} - Step: "${stepNarrative}" for Stage ${stageIndex}`);

                    const subTaskPromise = new Promise((resolve) => {
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
                        stepId: taskMessage.stepId, // Ensure stepId is part of the resolved object
                        narrative_step: stepNarrative,
                        tool_name: taskMessage.tool_name,
                        sub_task_input: subTaskDefinition.sub_task_input, // original input for context
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
                    stageSubTaskPromises.push(subTaskPromise);
                }
            }

            const stageResults = await Promise.all(stageSubTaskPromises);
            const stageContextEntries = [];
            let firstFailedStepErrorDetails = null;

            for (let j = 0; j < stageResults.length; j++) {
                const resultOfSubTask = stageResults[j]; // This now includes stepId
                const originalSubTaskDef = currentStageTaskDefinitions[j]; // This is the definition from the plan

                const subTaskIdForResult = resultOfSubTask.sub_task_id;
                const stepIdForResult = resultOfSubTask.stepId || originalSubTaskDef.stepId; // Prefer stepId from result if available (e.g. for internally generated failures)

                let processedData = resultOfSubTask.result_data;
                const summarizationLogDetails = { parentTaskId, stageIndex, subTaskId: subTaskIdForResult, stepId: stepIdForResult, narrativeStep: resultOfSubTask.narrative_step };

                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                    (resultOfSubTask.assigned_agent_role !== "Orchestrator" ||
                     (resultOfSubTask.assigned_agent_role === "Orchestrator" && subTaskDefinition.tool_name === "ExploreSearchResults"))) { // Only summarize for worker agents or ExploreSearchResults
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
                    stepId: stepIdForResult, // Ensure stepId is in contextEntry
                    narrative_step: resultOfSubTask.narrative_step || originalSubTaskDef.narrative_step,
                    assigned_agent_role: resultOfSubTask.assigned_agent_role || originalSubTaskDef.assigned_agent_role,
                    tool_name: resultOfSubTask.tool_name || originalSubTaskDef.tool_name,
                    sub_task_input: originalSubTaskDef.sub_task_input, // Always store the original input with @-references
                    status: resultOfSubTask.status,
                    processed_result_data: processedData,
                    raw_result_data: resultOfSubTask.result_data,
                    error_details: resultOfSubTask.error_details,
                    sub_task_id: subTaskIdForResult
                };
                stageContextEntries.push(contextEntry);

                // Populate stepOutputs for reference resolution
                if (contextEntry.stepId) {
                    stepOutputs[contextEntry.stepId] = {
                        status: contextEntry.status,
                        result_data: contextEntry.raw_result_data,
                        processed_result_data: contextEntry.processed_result_data,
                        error_details: contextEntry.error_details
                    };
                }


                const logDetails = { parentTaskId, stageIndex, subTaskId: contextEntry.sub_task_id, stepId: contextEntry.stepId, narrativeStep: contextEntry.narrative_step, toolName: contextEntry.tool_name, agentRole: contextEntry.assigned_agent_role };
                const dataPreviewForLog = contextEntry.processed_result_data !== undefined ? contextEntry.processed_result_data : contextEntry.raw_result_data;

                if (contextEntry.status === "COMPLETED") {
                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_COMPLETED", `Step completed: ${contextEntry.narrative_step}`, { ...logDetails, processedResultDataPreview: String(dataPreviewForLog).substring(0, 100) + "..." }));

                    // Collect Key Finding for CurrentWorkingContext
                    const findingData = contextEntry.processed_result_data || contextEntry.raw_result_data;
                    if (findingData || (typeof findingData === 'boolean' || typeof findingData === 'number')) { // Ensure data is not null/undefined, allow boolean/numbers
                        let dataToStore = findingData;
                        const MAX_FINDING_DATA_LENGTH = 500;
                        if (typeof findingData === 'string' && findingData.length > MAX_FINDING_DATA_LENGTH) {
                            dataToStore = findingData.substring(0, MAX_FINDING_DATA_LENGTH) + "...";
                        } else if (typeof findingData === 'object') {
                            // Optionally stringify and truncate objects if they can be very large
                            // For now, keeping small objects as is.
                            // dataToStore = JSON.stringify(findingData);
                            // if (dataToStore.length > MAX_FINDING_DATA_LENGTH) dataToStore = dataToStore.substring(0, MAX_FINDING_DATA_LENGTH) + "...";
                        }
                        const keyFinding = {
                            findingId: uuidv4(),
                            sourceStepNarrative: contextEntry.narrative_step,
                            sourceToolName: contextEntry.tool_name,
                            data: dataToStore,
                            timestamp: new Date().toISOString()
                        };
                        collectedKeyFindings.push(keyFinding);
                    }

                } else if (contextEntry.status === "FAILED") {
                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_FAILED", `Step failed: ${contextEntry.narrative_step}`, { ...logDetails, errorDetails: contextEntry.error_details }));
                    if (!firstFailedStepErrorDetails) { // This is the first failure in the stage that we're processing
                        firstFailedStepErrorDetails = contextEntry.error_details || { message: "Unknown error in failed step." };
                        // Populate failedStepDetails with comprehensive information
                        failedStepDetails = {
                            sub_task_id: contextEntry.sub_task_id,
                            stepId: contextEntry.stepId, // Add stepId here
                            narrative_step: contextEntry.narrative_step,
                            tool_name: contextEntry.tool_name,
                            assigned_agent_role: contextEntry.assigned_agent_role,
                            sub_task_input: contextEntry.sub_task_input,
                            error_details: contextEntry.error_details
                        };
                        // Ensure sub_task_id is part of firstFailedStepErrorDetails if it was missing before, for compatibility with existing logging
                        if (!firstFailedStepErrorDetails.sub_task_id && contextEntry.sub_task_id) { // This sub_task_id is the uuid for the execution instance
                            firstFailedStepErrorDetails.sub_task_id = contextEntry.sub_task_id;
                        }
                         // Add stepId to firstFailedStepErrorDetails as well for consistency if needed elsewhere
                        if (!firstFailedStepErrorDetails.stepId && contextEntry.stepId) {
                            firstFailedStepErrorDetails.stepId = contextEntry.stepId;
                        }
                    }
                    // Collect Error for CurrentWorkingContext
                    if (contextEntry.error_details) {
                        const encounteredError = {
                            errorId: uuidv4(), // Add an ID for errors as well
                            sourceStepNarrative: contextEntry.narrative_step,
                            sourceToolName: contextEntry.tool_name,
                            errorMessage: contextEntry.error_details.message || JSON.stringify(contextEntry.error_details),
                            timestamp: new Date().toISOString()
                        };
                        collectedErrors.push(encounteredError);
                    }
                }
            }
            executionContext.push(...stageContextEntries);

            let stageFailed = false;
            for (const entry of stageContextEntries) {
                if (entry.status === "FAILED") {
                    console.error(`PlanExecutor: Sub-task ${entry.sub_task_id} ("${entry.narrative_step}") failed in Stage ${stageIndex}. Halting further stages.`);
                    overallSuccess = false;
                    stageFailed = true;
                    break;
                }
            }

            if (stageFailed) {
                const reason = firstFailedStepErrorDetails ?
                               `Step ${firstFailedStepErrorDetails.sub_task_id || originalSubTaskDef.sub_task_id} ("${firstFailedStepErrorDetails.narrative_step || originalSubTaskDef.narrative_step}") failed: ${firstFailedStepErrorDetails.message || 'Unknown error'}` :
                               "A step in the stage failed.";
                journalEntries.push(this._createJournalEntry("EXECUTION_STAGE_FAILED", `Stage ${stageIndex} failed. Reason: ${reason}. Halting plan execution.`, { parentTaskId, stageIndex, reason: firstFailedStepErrorDetails }));
                break;
            } else {
                journalEntries.push(this._createJournalEntry("EXECUTION_STAGE_COMPLETED", `Stage ${stageIndex} completed successfully.`, { parentTaskId, stageIndex }));
            }
            console.log(`PlanExecutor: Stage ${stageIndex} completed successfully.`);
        }

        journalEntries.push(this._createJournalEntry(
            overallSuccess ? "PLAN_EXECUTION_COMPLETED" : "PLAN_EXECUTION_FAILED",
            `Execution of plan for ParentTaskID: ${parentTaskId} finished. Success: ${overallSuccess}`,
            { parentTaskId, overallSuccess }
        ));
        console.log(`PlanExecutor: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);

        // Check for pre-synthesized final answer
        if (overallSuccess && executionContext.length > 0) {
            const lastStepContext = executionContext[executionContext.length - 1];
            if (lastStepContext.status === "COMPLETED" &&
                lastStepContext.assigned_agent_role === "Orchestrator" &&
                lastStepContext.tool_name === "GeminiStepExecutor" &&
                lastStepContext.sub_task_input && // original sub_task_input
                lastStepContext.sub_task_input.isFinalAnswer === true) { // Check on original input

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

        return {
            success: overallSuccess,
            executionContext,
            journalEntries,
            updatesForWorkingContext: {
                keyFindings: collectedKeyFindings,
                errorsEncountered: collectedErrors
            },
            finalAnswer: finalAnswerOutput,
            finalAnswerSynthesized: finalAnswerWasSynthesized,
            failedStepDetails: failedStepDetails // Add the new field here
        };
    }
}

module.exports = PlanExecutor;
