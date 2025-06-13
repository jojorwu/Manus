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

    async _handleExploreSearchResults(sub_task_id, subTaskDefinition, executionContext, parentTaskId) {
        console.log(`PlanExecutor: Handling special step ExploreSearchResults: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id})`);
        let previousSearchResults = null;
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

        if (!previousSearchResults || !Array.isArray(previousSearchResults) || previousSearchResults.length === 0) {
            console.warn("PlanExecutor.ExploreSearchResults: No valid search results found from previous steps or results are not an array.");
            return {
                sub_task_id: sub_task_id,
                narrative_step: subTaskDefinition.narrative_step,
                tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator",
                sub_task_input: subTaskDefinition.sub_task_input,
                status: "COMPLETED",
                result_data: "No search results available to explore or results format was incompatible.",
                error_details: null
            };
        }

        const pagesToExplore = subTaskDefinition.sub_task_input?.pagesToExplore || 2;
        const linksToRead = previousSearchResults.slice(0, pagesToExplore)
            .map(item => item && item.link)
            .filter(link => typeof link === 'string' && link.trim() !== '');

        if (linksToRead.length === 0) {
            return { sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED", result_data: "No valid links found in search results to explore.", error_details: null };
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
            narrative_step: subTaskDefinition.narrative_step,
            tool_name: "ExploreSearchResults",
            assigned_agent_role: "Orchestrator",
            sub_task_input: subTaskDefinition.sub_task_input,
            status: "COMPLETED",
            result_data: aggregatedContent || "No content could be fetched from the explored pages.",
            error_details: null
        };
    }

    async _handleGeminiStepExecutor(sub_task_id, subTaskDefinition, executionContext, parentTaskId) {
        console.log(`PlanExecutor: Handling special step GeminiStepExecutor: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id})`);
        let promptInput = subTaskDefinition.sub_task_input?.prompt || "";
        const promptTemplate = subTaskDefinition.sub_task_input?.prompt_template;
        const promptParams = subTaskDefinition.sub_task_input?.prompt_params || {};

        if (promptTemplate) {
            promptInput = promptTemplate;
            for (const key in promptParams) {
                const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
                let valueToInject = promptParams[key];
                if (valueToInject === "{previous_step_output}") {
                    if (executionContext.length > 0) {
                        const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                        valueToInject = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
                    } else {
                        valueToInject = "No data from previous steps.";
                    }
                }
                promptInput = promptInput.replace(placeholder, valueToInject);
            }
            if (promptInput.includes("{{previous_step_output}}")) { // Fallback for simple template
                 if (executionContext.length > 0) {
                    const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput));
                } else {
                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), "No data from previous steps.");
                }
            }
        } else if (!promptInput && subTaskDefinition.sub_task_input?.data_from_previous_step === true) {
             if (executionContext.length > 0) {
                const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                promptInput = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
            } else {
                promptInput = "No data from previous steps to use as prompt.";
            }
        }

        if (!promptInput) {
            return { sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "FAILED", error_details: { message: "Prompt is empty for GeminiStepExecutor." } };
        }

        try {
            const resultData = await this.llmService(promptInput);
            return { sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED", result_data: resultData, error_details: null };
        } catch (e) {
            return { sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "FAILED", error_details: { message: e.message } };
        }
    }

    async executePlan(planStages, parentTaskId, userTaskString) {
        const journalEntries = [];
        const executionContext = [];
        const collectedKeyFindings = [];
        const collectedErrors = [];
        let overallSuccess = true;
        let finalAnswerOutput = null;
        let finalAnswerWasSynthesized = false;

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
                const subTaskInputForLog = { ...subTaskDefinition.sub_task_input };

                if (subTaskDefinition.assigned_agent_role === "Orchestrator") {
                    const sub_task_id_for_orchestrator_step = uuidv4();
                    journalEntries.push(this._createJournalEntry(
                        "EXECUTION_STEP_ORCHESTRATOR_START",
                        `Orchestrator starting special step: ${stepNarrative}`,
                        { parentTaskId, stageIndex, subTaskId: sub_task_id_for_orchestrator_step, narrativeStep: stepNarrative, toolName: subTaskDefinition.tool_name, subTaskInput: subTaskInputForLog }
                    ));
                    if (subTaskDefinition.tool_name === "ExploreSearchResults") {
                        stageSubTaskPromises.push(this._handleExploreSearchResults(sub_task_id_for_orchestrator_step, subTaskDefinition, executionContext, parentTaskId));
                    } else if (subTaskDefinition.tool_name === "GeminiStepExecutor") {
                        stageSubTaskPromises.push(this._handleGeminiStepExecutor(sub_task_id_for_orchestrator_step, subTaskDefinition, executionContext, parentTaskId));
                    } else if (subTaskDefinition.tool_name === "FileSystemTool" || subTaskDefinition.tool_name === "FileDownloaderTool") {
                        const toolPromise = (async () => {
                            let tool;
                            // Construct task-specific workspace path. Example: <savedTasksBaseDir>/<parentTaskId>/workspace
                            const taskWorkspaceDir = path.join(this.savedTasksBaseDir, parentTaskId, 'workspace');
                            try {
                                await fsp.mkdir(taskWorkspaceDir, { recursive: true });

                                if (subTaskDefinition.tool_name === "FileSystemTool") {
                                    tool = new FileSystemTool(taskWorkspaceDir);
                                } else { // FileDownloaderTool
                                    tool = new FileDownloaderTool(taskWorkspaceDir);
                                }

                                const operation = subTaskDefinition.sub_task_input.operation;
                                const opParams = subTaskDefinition.sub_task_input.params;

                                if (typeof tool[operation] !== 'function') {
                                    throw new Error(`Operation '${operation}' not found on tool '${subTaskDefinition.tool_name}'.`);
                                }

                                const toolResult = await tool[operation](opParams);

                                return {
                                    sub_task_id: sub_task_id_for_orchestrator_step,
                                    narrative_step: stepNarrative,
                                    tool_name: subTaskDefinition.tool_name,
                                    assigned_agent_role: "Orchestrator",
                                    sub_task_input: subTaskDefinition.sub_task_input,
                                    status: toolResult.error ? "FAILED" : "COMPLETED",
                                    result_data: toolResult.result,
                                    error_details: toolResult.error ? { message: toolResult.error } : null
                                };
                            } catch (err) {
                                console.error(`PlanExecutor: Error executing Orchestrator tool ${subTaskDefinition.tool_name}, operation ${subTaskDefinition.sub_task_input.operation}: ${err.message}`);
                                return {
                                    sub_task_id: sub_task_id_for_orchestrator_step,
                                    narrative_step: stepNarrative,
                                    tool_name: subTaskDefinition.tool_name,
                                    assigned_agent_role: "Orchestrator",
                                    sub_task_input: subTaskDefinition.sub_task_input,
                                    status: "FAILED",
                                    error_details: { message: err.message }
                                };
                            }
                        })();
                        stageSubTaskPromises.push(toolPromise);
                    } else {
                        // Unknown Orchestrator tool
                         console.error(`PlanExecutor: Unknown tool '${subTaskDefinition.tool_name}' for Orchestrator role. Step: "${stepNarrative}"`);
                         stageSubTaskPromises.push(Promise.resolve({
                            sub_task_id: sub_task_id_for_orchestrator_step,
                            narrative_step: stepNarrative,
                            tool_name: subTaskDefinition.tool_name,
                            assigned_agent_role: "Orchestrator",
                            sub_task_input: subTaskDefinition.sub_task_input,
                            status: "FAILED",
                            error_details: { message: `Unknown Orchestrator tool: ${subTaskDefinition.tool_name}` }
                        }));
                    }
                } else {
                    const sub_task_id = uuidv4();
                    const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: stepNarrative };

                    journalEntries.push(this._createJournalEntry(
                        "EXECUTION_STEP_DISPATCHED",
                        `Dispatching step: ${stepNarrative} (SubTaskID: ${sub_task_id}) to agent ${taskMessage.assigned_agent_role}`,
                        { parentTaskId, stageIndex, subTaskId: sub_task_id, narrativeStep: stepNarrative, toolName: taskMessage.tool_name, agentRole: taskMessage.assigned_agent_role, subTaskInput: subTaskInputForLog }
                    ));
                    this.subTaskQueue.enqueueTask(taskMessage);
                    console.log(`PlanExecutor: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${stepNarrative}" for Stage ${stageIndex}`);

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
                                    resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details });
                                } else {
                                    const errorMessage = `Critical - Mismatched sub_task_id. Expected ${sub_task_id}, got ${resultMsg.sub_task_id}`;
                                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_ERROR", errorMessage, { ...resultDetails, expectedSubTaskId: sub_task_id, receivedSubTaskId: resultMsg.sub_task_id }));
                                    console.error(`PlanExecutor: ${errorMessage} for parent_task_id ${parentTaskId} (Stage ${stageIndex}).`);
                                    resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage } });
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
                const resultOfSubTask = stageResults[j];
                const originalSubTaskDef = currentStageTaskDefinitions[j];
                // Use sub_task_id from resultOfSubTask as it's now passed to/returned by orchestrator steps too
                const subTaskIdForResult = resultOfSubTask.sub_task_id;

                let processedData = resultOfSubTask.result_data;
                const summarizationLogDetails = { parentTaskId, stageIndex, subTaskId: subTaskIdForResult, narrativeStep: resultOfSubTask.narrative_step };

                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                    resultOfSubTask.assigned_agent_role !== "Orchestrator") {
                    journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_START", `Summarizing data for step: ${resultOfSubTask.narrative_step}`, summarizationLogDetails));
                    const originalDataForPreview = resultOfSubTask.result_data; // Keep original for preview if summarization fails
                    try {
                        // Call _summarizeStepData without journalEntries param
                        const summary = await this._summarizeStepData(resultOfSubTask.result_data, userTaskString, resultOfSubTask.narrative_step, subTaskIdForResult, parentTaskId);
                        if (summary !== resultOfSubTask.result_data) {
                             journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_SUCCESS", `Successfully summarized data for step: ${resultOfSubTask.narrative_step}`, { ...summarizationLogDetails, summarizedDataPreview: String(summary).substring(0,100) + "..."}));
                        }
                        processedData = summary;
                    } catch (summarizationError) {
                        journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_FAILED", `Summarization failed for step: ${resultOfSubTask.narrative_step}`, { ...summarizationLogDetails, errorMessage: summarizationError.message }));
                         console.error(`PlanExecutor: Error during _summarizeStepData call for SubTaskID ${subTaskIdForResult}: ${summarizationError.message}`);
                        processedData = originalDataForPreview; // Use original data if summarization threw an error
                    }
                }

                const contextEntry = {
                    narrative_step: resultOfSubTask.narrative_step || originalSubTaskDef.narrative_step,
                    assigned_agent_role: resultOfSubTask.assigned_agent_role || originalSubTaskDef.assigned_agent_role,
                    tool_name: resultOfSubTask.tool_name || originalSubTaskDef.tool_name,
                    sub_task_input: resultOfSubTask.sub_task_input || originalSubTaskDef.sub_task_input,
                    status: resultOfSubTask.status,
                    processed_result_data: processedData,
                    raw_result_data: resultOfSubTask.result_data,
                    error_details: resultOfSubTask.error_details,
                    sub_task_id: subTaskIdForResult
                };
                stageContextEntries.push(contextEntry);

                const logDetails = { parentTaskId, stageIndex, subTaskId: contextEntry.sub_task_id, narrativeStep: contextEntry.narrative_step, toolName: contextEntry.tool_name, agentRole: contextEntry.assigned_agent_role };
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
                    if (!firstFailedStepErrorDetails) {
                        firstFailedStepErrorDetails = contextEntry.error_details || { message: "Unknown error in failed step." };
                        if (!firstFailedStepErrorDetails.sub_task_id && contextEntry.sub_task_id) firstFailedStepErrorDetails.sub_task_id = contextEntry.sub_task_id;
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
                lastStepContext.sub_task_input &&
                lastStepContext.sub_task_input.isFinalAnswer === true) {

                finalAnswerOutput = lastStepContext.processed_result_data || lastStepContext.raw_result_data;
                finalAnswerWasSynthesized = true;

                journalEntries.push(this._createJournalEntry(
                    "PLAN_EXECUTOR_FINAL_ANSWER_IDENTIFIED", // More specific type
                    "Final answer was marked as synthesized by PlanExecutor within a plan step.",
                    {
                        parentTaskId,
                        stepNarrative: lastStepContext.narrative_step,
                        subTaskId: lastStepContext.sub_task_id
                    }
                ));
                console.log(`PlanExecutor: Final answer identified as pre-synthesized by step: "${lastStepContext.narrative_step}"`);
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
            finalAnswerSynthesized: finalAnswerWasSynthesized
        };
    }
}

module.exports = PlanExecutor;
