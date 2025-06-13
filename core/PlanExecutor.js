// core/PlanExecutor.js
const { v4: uuidv4 } = require('uuid');
const ReadWebpageTool = require('../tools/ReadWebpageTool'); // Fallback if not in tools
const AdvancedWebpageReaderTool = require('../tools/AdvancedWebpageReaderTool'); // Fallback if not in tools

// Defines the maximum length for raw string data to be stored directly in the executionContext.
// Data exceeding this length will be replaced by a marker object to conserve memory.
const MAX_RAW_DATA_IN_MEMORY_LENGTH = 10000;

class PlanExecutor {
    constructor(subTaskQueue, resultsQueue, llmService, tools = {}) {
        this.subTaskQueue = subTaskQueue;
        this.resultsQueue = resultsQueue;
        this.llmService = llmService;
        this.tools = tools;
        // Expected tools for _handleExploreSearchResults:
        // this.tools.AdvancedWebpageReaderTool
        // this.tools.ReadWebpageTool
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

    async _summarizeStepData(dataToSummarize, userTaskString, narrativeStep, subTaskId, parentTaskId) {
        const MAX_DATA_LENGTH = 1000;
        let dataString;

        if (typeof dataToSummarize === 'string') {
            dataString = dataToSummarize;
        } else {
            try {
                dataString = JSON.stringify(dataToSummarize);
            } catch (e) {
                console.warn(`PlanExecutor.summarizeDataWithLLM: Could not stringify data for step "${narrativeStep}". Using raw data type. Error: ${e.message}`);
                return dataToSummarize;
            }
        }

        if (dataString.length > MAX_DATA_LENGTH) {
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
                return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long, summarization error occurred)" : "");
            }
        }
        return dataToSummarize;
    }

    async _handleExploreSearchResults(sub_task_id, subTaskDefinition, executionContext, parentTaskId) {
        console.log(`PlanExecutor: Handling special step ExploreSearchResults: "${subTaskDefinition.narrative_step}" (SubTaskID: ${sub_task_id})`);
        let previousSearchResults = null;
        for (let k = executionContext.length - 1; k >= 0; k--) {
            // Prioritize raw_result_data for links, especially if processed_result_data is a summary string.
            const rawResults = executionContext[k].raw_result_data;
            const processedResults = executionContext[k].processed_result_data;
            let potentialResultsToParse = null;

            if (executionContext[k].tool_name === "WebSearchTool" && executionContext[k].status === "COMPLETED") {
                if (rawResults) { // Prefer raw_result_data if it exists for WebSearchTool
                    potentialResultsToParse = rawResults;
                } else if (processedResults) { // Fallback to processed_result_data
                    potentialResultsToParse = processedResults;
                }

                if (potentialResultsToParse) {
                    if (Array.isArray(potentialResultsToParse)) {
                        previousSearchResults = potentialResultsToParse;
                        break;
                    } else if (typeof potentialResultsToParse === 'object' && Array.isArray(potentialResultsToParse.result)) {
                        previousSearchResults = potentialResultsToParse.result;
                        break;
                    }
                }
            }
        }

        if (!previousSearchResults || !Array.isArray(previousSearchResults) || previousSearchResults.length === 0) {
            console.warn("PlanExecutor.ExploreSearchResults: No valid array of search results found from previous WebSearchTool steps.");
            return {
                sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED",
                result_data: "No valid search results array available to explore.", error_details: null
            };
        }

        const pagesToExplore = subTaskDefinition.sub_task_input?.pagesToExplore || 2;
        const linksToRead = previousSearchResults.slice(0, pagesToExplore)
            .map(item => item && item.link)
            .filter(link => typeof link === 'string' && link.trim() !== '');

        if (linksToRead.length === 0) {
            return {
                sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults",
                assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED",
                result_data: "No valid links found in search results to explore.", error_details: null
            };
        }

        let webpageReader;
        if (this.tools && this.tools.AdvancedWebpageReaderTool) {
            webpageReader = this.tools.AdvancedWebpageReaderTool;
            console.log(`PlanExecutor._handleExploreSearchResults: Using AdvancedWebpageReaderTool.`);
        } else if (this.tools && this.tools.ReadWebpageTool) {
            webpageReader = this.tools.ReadWebpageTool;
            console.log(`PlanExecutor._handleExploreSearchResults: AdvancedWebpageReaderTool not found, falling back to ReadWebpageTool.`);
        } else {
            webpageReader = new ReadWebpageTool(); // Fallback, though ideally tools are always provided.
            console.warn(`PlanExecutor._handleExploreSearchResults: No webpage reader tool found in this.tools, instantiating ReadWebpageTool directly.`);
        }

        let aggregatedContent = "";
        // let aggregatedImages = []; // If we decide to collect images

        for (const url of linksToRead) {
            try {
                console.log(`PlanExecutor._handleExploreSearchResults: Reading URL - ${url} for SubTaskID: ${sub_task_id} using ${webpageReader.constructor.name}`);
                const readResult = await webpageReader.execute({ url });

                if (readResult.success && readResult.text) {
                    aggregatedContent += `Content from ${url}:\n${readResult.text}\n---\n`;
                    // if (readResult.images && readResult.images.length > 0) {
                    //     aggregatedImages.push({url: url, images: readResult.images});
                    // }
                } else if (readResult.error) {
                    let errorMessage = readResult.error;
                    if (readResult.details) errorMessage += ` (Details: ${readResult.details})`;
                    aggregatedContent += `Error reading ${url}: ${errorMessage}\n---\n`;
                } else {
                    aggregatedContent += `Could not retrieve content or empty content from ${url}.\n---\n`;
                }
            } catch (e) {
                aggregatedContent += `Exception while reading ${url}: ${e.message}\n---\n`;
            }
        }
        return {
            sub_task_id: sub_task_id, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults",
            assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED",
            result_data: aggregatedContent || "No content could be fetched from the explored pages.",
            // images_data: aggregatedImages, // If returning images
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
            if (promptInput.includes("{{previous_step_output}}")) {
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
                    }
                } else {
                    const sub_task_id = uuidv4();
                    const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: stepNarrative };
                    let subTaskPromise;

                    // Check if there are any active subscribers (agents) for the assigned role.
                    // This prevents tasks from being enqueued indefinitely if no agent is available.
                    if (!this.subTaskQueue.hasSubscribers(taskMessage.assigned_agent_role)) {
                        const errorMsg = `No active subscribers for assigned agent role: ${taskMessage.assigned_agent_role}`;
                        console.error(`ERROR: PlanExecutor: ${errorMsg} for sub-task ${sub_task_id} ("${stepNarrative}"). Marking step as FAILED.`);
                        const noSubscriberErrorDetails = {
                            message: errorMsg,
                            type: "PlanExecutorError", // Specific type for PlanExecutor-level errors
                            details: "Task was not enqueued because no agent was subscribed for this role.",
                            toolName: taskMessage.tool_name // Include tool_name if available
                        };
                        journalEntries.push(this._createJournalEntry(
                            "EXECUTION_STEP_FAILED",
                            `Step failed: ${stepNarrative} (SubTaskID: ${sub_task_id}) - ${errorMsg}`,
                            { parentTaskId, stageIndex, subTaskId: sub_task_id, narrativeStep: stepNarrative, toolName: taskMessage.tool_name, agentRole: taskMessage.assigned_agent_role, subTaskInput: subTaskInputForLog, errorDetails: noSubscriberErrorDetails }
                        ));
                        subTaskPromise = Promise.resolve({
                            sub_task_id,
                            narrative_step: stepNarrative,
                            tool_name: taskMessage.tool_name,
                            sub_task_input: taskMessage.sub_task_input,
                            assigned_agent_role: taskMessage.assigned_agent_role,
                            status: "FAILED",
                            error_details: noSubscriberErrorDetails // Use the structured error object
                        });
                    } else {
                        journalEntries.push(this._createJournalEntry(
                            "EXECUTION_STEP_DISPATCHED", // Clear event type for dispatch
                            `Dispatching step: ${stepNarrative} (SubTaskID: ${sub_task_id}) to agent ${taskMessage.assigned_agent_role}`, // Descriptive message
                            { parentTaskId, stageIndex, subTaskId: sub_task_id, narrativeStep: stepNarrative, toolName: taskMessage.tool_name, agentRole: taskMessage.assigned_agent_role, subTaskInput: subTaskInputForLog }
                        ));
                        this.subTaskQueue.enqueueTask(taskMessage);
                        console.log(`INFO: PlanExecutor: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${stepNarrative}" for Stage ${stageIndex}`);

                        subTaskPromise = new Promise((resolve) => {
                            this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                                const resultDetails = { parentTaskId, stageIndex, subTaskId: sub_task_id, narrativeStep: stepNarrative };
                                if (error) { // Error from resultsQueue (e.g., timeout for subscribeOnce)
                                    const queueErrorDetails = {
                                        message: error.message,
                                        type: "QueueTimeoutError", // Specific type for queue-level timeouts
                                        toolName: taskMessage.tool_name,
                                        details: "Error or timeout waiting for sub-task result in ResultsQueue."
                                    };
                                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_ERROR", `Error or timeout for SubTaskID: ${sub_task_id}`, { ...resultDetails, errorDetails: queueErrorDetails }));
                                    console.error(`ERROR: PlanExecutor: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${stageIndex}):`, error.message);
                                    resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: queueErrorDetails });
                                } else if (resultMsg) {
                                    // Log the received error_details if the sub-task failed
                                    if (resultMsg.status === "FAILED") {
                                        console.warn(`WARN: PlanExecutor [${parentTaskId}/${sub_task_id}]: Received FAILED status from ${resultMsg.worker_agent_role}. Error details: ${JSON.stringify(resultMsg.error_details)}`);
                                    } else if (resultMsg.status === "COMPLETED") {
                                        let rawResultPreview;
                                        if (typeof resultMsg.result_data === 'string') {
                                            rawResultPreview = resultMsg.result_data.substring(0, 100) + (resultMsg.result_data.length > 100 ? "..." : "");
                                        } else if (resultMsg.result_data && typeof resultMsg.result_data === 'object' && resultMsg.result_data.text) {
                                            rawResultPreview = `Object with text: ${(resultMsg.result_data.text || "").substring(0,80)}...`;
                                        } else if (resultMsg.result_data && typeof resultMsg.result_data === 'object') {
                                            try {
                                                rawResultPreview = `Data type: object, JSON preview: ${JSON.stringify(resultMsg.result_data).substring(0, 100)}...`;
                                            } catch (stringifyError) {
                                                rawResultPreview = `Data type: object (non-serializable), Keys: ${Object.keys(resultMsg.result_data).join(', ')}`;
                                            }
                                        } else {
                                            rawResultPreview = `Data type: ${typeof resultMsg.result_data}`;
                                        }
                                        console.log(`INFO: PlanExecutor [${parentTaskId}/${sub_task_id}]: Received COMPLETED result from ${resultMsg.worker_agent_role}. Raw result preview: ${rawResultPreview}`);
                                    }

                                    const resultDataPreview = typeof resultMsg.result_data === 'string' ? resultMsg.result_data.substring(0,100) + '...' : String(resultMsg.result_data);
                                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_RECEIVED", `Result received for SubTaskID: ${sub_task_id}, Status: ${resultMsg.status}`, { ...resultDetails, status: resultMsg.status, agentRole: resultMsg.worker_agent_role, resultDataPreview, errorDetailsReceived: resultMsg.error_details })); // Log received error_details
                                    if (resultMsg.sub_task_id === sub_task_id) {
                                        // This console log is more about the event of receiving a message for the correct sub_task_id rather than its content details.
                                        // console.log(`INFO: PlanExecutor: Received result for sub_task_id ${sub_task_id} (Stage ${stageIndex}). Status: ${resultMsg.status}`);
                                        resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details }); // Pass along the rich error_details from agent
                                    } else {
                                        const mismatchErrorMsg = `Critical - Mismatched sub_task_id. Expected ${sub_task_id}, got ${resultMsg.sub_task_id}`;
                                        const mismatchErrorDetails = {
                                            message: mismatchErrorMsg,
                                            type: "PlanExecutorError",
                                            details: `Expected sub_task_id ${sub_task_id} but received result for ${resultMsg.sub_task_id}.`
                                        };
                                        journalEntries.push(this._createJournalEntry("EXECUTION_STEP_RESULT_ERROR", mismatchErrorMsg, { ...resultDetails, errorDetails: mismatchErrorDetails, expectedSubTaskId: sub_task_id, receivedSubTaskId: resultMsg.sub_task_id }));
                                        console.error(`ERROR: PlanExecutor: ${mismatchErrorMsg} for parent_task_id ${parentTaskId} (Stage ${stageIndex}).`);
                                        resolve({ sub_task_id, narrative_step: stepNarrative, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: mismatchErrorDetails });
                                    }
                                }
                            }, sub_task_id);
                        });
                    }
                    stageSubTaskPromises.push(subTaskPromise);
                }
            }

            const stageResults = await Promise.all(stageSubTaskPromises);
            const stageContextEntries = [];
            let firstFailedStepErrorDetails = null;

            for (let j = 0; j < stageResults.length; j++) {
                const resultOfSubTask = stageResults[j];
                const originalSubTaskDef = currentStageTaskDefinitions[j];
                const subTaskIdForResult = resultOfSubTask.sub_task_id;

                let processedData = resultOfSubTask.result_data; // This will be used for summarization if applicable
                let rawDataForContext = resultOfSubTask.result_data; // This will be stored in contextEntry.raw_result_data

                const summarizationLogDetails = { parentTaskId, stageIndex, subTaskId: subTaskIdForResult, narrativeStep: resultOfSubTask.narrative_step };

                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                    resultOfSubTask.assigned_agent_role !== "Orchestrator") { // Orchestrator steps often have structured data not meant for summarization here
                    journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_START", `Summarizing data for step: ${resultOfSubTask.narrative_step}`, summarizationLogDetails));
                    // _summarizeStepData receives the original, full resultOfSubTask.result_data
                    try {
                        const summary = await this._summarizeStepData(resultOfSubTask.result_data, userTaskString, resultOfSubTask.narrative_step, subTaskIdForResult, parentTaskId);
                        if (summary !== resultOfSubTask.result_data) { // Check if summarization actually changed the data
                             journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_SUCCESS", `Successfully summarized data for step: ${resultOfSubTask.narrative_step}`, { ...summarizationLogDetails, summarizedDataPreview: String(summary).substring(0,100) + "..."}));
                        }
                        processedData = summary; // processedData will hold the summary or original if not summarized
                    } catch (summarizationError) {
                        journalEntries.push(this._createJournalEntry("EXECUTION_DATA_SUMMARIZATION_FAILED", `Summarization failed for step: ${resultOfSubTask.narrative_step}`, { ...summarizationLogDetails, errorMessage: summarizationError.message }));
                         console.error(`PlanExecutor: Error during _summarizeStepData call for SubTaskID ${subTaskIdForResult}: ${summarizationError.message}`);
                        // In case of summarization error, processedData retains its initial value (original resultOfSubTask.result_data)
                    }
                }
                // If it was an Orchestrator step, processedData is still the original resultOfSubTask.result_data as summarization is skipped.

                // Memory optimization: Check if the raw_result_data (which is the original, full data from the sub-task)
                // is a large string. If so, replace it with a marker object in the executionContext to save memory.
                // The `processed_result_data` (which might be a summary or the same original data if not summarized)
                // is stored separately and is not affected by this specific raw_data truncation.
                if (typeof resultOfSubTask.result_data === 'string' && resultOfSubTask.result_data.length > MAX_RAW_DATA_IN_MEMORY_LENGTH) {
                    // Log a warning when this replacement happens, including context like step and data size.
                    console.warn(`WARN: PlanExecutor: raw_result_data for step "${resultOfSubTask.narrative_step}" (SubTaskID: ${subTaskIdForResult}) is too large (${resultOfSubTask.result_data.length} chars). Storing preview and marker instead in executionContext.raw_result_data.`);
                    rawDataForContext = { // This marker is stored in contextEntry.raw_result_data
                        _isLargeDataMarker: true, // A distinct property to identify this as a marker
                        originalLength: resultOfSubTask.result_data.length,
                        preview: resultOfSubTask.result_data.substring(0, 250) + "..." // Store a small preview
                    };
                    // Add a journal entry for this event, useful for debugging and monitoring.
                    journalEntries.push(this._createJournalEntry(
                        "INFO", // Informational event
                        `Large raw_result_data for step "${resultOfSubTask.narrative_step}" (SubTaskID: ${subTaskIdForResult}) replaced with a marker in executionContext.`,
                        { subTaskId: subTaskIdForResult, originalLength: resultOfSubTask.result_data.length, previewLength: 250 }
                    ));
                }
                // If data is not a large string, rawDataForContext remains as the original resultOfSubTask.result_data.

                const contextEntry = {
                    narrative_step: resultOfSubTask.narrative_step || originalSubTaskDef.narrative_step, // Ensure narrative step is present
                    assigned_agent_role: resultOfSubTask.assigned_agent_role || originalSubTaskDef.assigned_agent_role,
                    tool_name: resultOfSubTask.tool_name || originalSubTaskDef.tool_name,
                    sub_task_input: resultOfSubTask.sub_task_input || originalSubTaskDef.sub_task_input,
                    status: resultOfSubTask.status, // Crucial for determining success/failure
                    processed_result_data: processedData, // This is the (potentially summarized) data, or original if not summarized
                    raw_result_data: rawDataForContext,   // This is the original data or the marker object if data was too large
                    error_details: resultOfSubTask.error_details, // Store any error details from the sub-task execution
                    sub_task_id: subTaskIdForResult // Ensure sub_task_id is part of the context for traceability
                };
                stageContextEntries.push(contextEntry);

                // Logging the outcome of the step processing.
                const logDetails = { parentTaskId, stageIndex, subTaskId: contextEntry.sub_task_id, narrativeStep: contextEntry.narrative_step, toolName: contextEntry.tool_name, agentRole: contextEntry.assigned_agent_role };
                // For logging preview, prefer processed_result_data (summary or smaller data), fallback to raw_result_data (which might be a marker)
                const dataPreviewForLog = contextEntry.processed_result_data !== undefined ?
                                          (typeof contextEntry.processed_result_data === 'string' ? contextEntry.processed_result_data : JSON.stringify(contextEntry.processed_result_data)) :
                                          (typeof contextEntry.raw_result_data === 'string' ? contextEntry.raw_result_data : (contextEntry.raw_result_data._isLargeDataMarker ? contextEntry.raw_result_data.preview : JSON.stringify(contextEntry.raw_result_data)));


                if (contextEntry.status === "COMPLETED") {
                    journalEntries.push(this._createJournalEntry("EXECUTION_STEP_COMPLETED", `Step completed: ${contextEntry.narrative_step}`, { ...logDetails, processedResultDataPreview: String(dataPreviewForLog).substring(0, 100) + "..." }));
                    // Key findings are collected from processed_result_data or raw_result_data (if marker, its preview is used).
                    const findingData = contextEntry.processed_result_data !== undefined ? contextEntry.processed_result_data : contextEntry.raw_result_data;
                    if (findingData || (typeof findingData === 'boolean' || typeof findingData === 'number')) {
                        let dataToStore = findingData;
                        const MAX_FINDING_DATA_LENGTH = 500;
                        if (typeof findingData === 'string' && findingData.length > MAX_FINDING_DATA_LENGTH) {
                            dataToStore = findingData.substring(0, MAX_FINDING_DATA_LENGTH) + "...";
                        } else if (typeof findingData === 'object') {
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
                    if (contextEntry.error_details) {
                        const encounteredError = {
                            errorId: uuidv4(),
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
        return {
            success: overallSuccess,
            executionContext,
            journalEntries,
            updatesForWorkingContext: {
                keyFindings: collectedKeyFindings,
                errorsEncountered: collectedErrors
            }
        };
    }
}

module.exports = PlanExecutor;
