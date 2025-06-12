// core/PlanExecutor.js
const { v4: uuidv4 } = require('uuid');
const ReadWebpageTool = require('../tools/ReadWebpageTool'); // Required for _handleExploreSearchResults

class PlanExecutor {
    constructor(subTaskQueue, resultsQueue, llmService, tools = {}) { // Default tools to empty object
        this.subTaskQueue = subTaskQueue;
        this.resultsQueue = resultsQueue;
        this.llmService = llmService;
        this.tools = tools; // Expects { ReadWebpageTool: instance } or similar if passed
        // If ReadWebpageTool is not passed in tools, _handleExploreSearchResults will instantiate it.
    }

    async _summarizeStepData(dataToSummarize, userTaskString, narrativeStep) {
        // Adapted from OrchestratorAgent.summarizeDataWithLLM()
        const MAX_DATA_LENGTH = 1000; // Consider making this configurable
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
            console.log(`PlanExecutor.summarizeDataWithLLM: Data for step "${narrativeStep}" is too long (${dataString.length} chars), attempting summarization.`);
            const summarizationPrompt = `The original user task was: "${userTaskString}".
A step in the execution plan, described as "${narrativeStep}", produced the following data:
---
${dataString.substring(0, MAX_DATA_LENGTH)}... (data truncated for this prompt if originally longer)
---
Please summarize this data concisely, keeping in mind its relevance to the original user task and the step description. The summary should be a string, suitable for inclusion as context for a final answer synthesis. Focus on extracting key information and outcomes. Provide only the summary text.`;
            try {
                const summary = await this.llmService(summarizationPrompt);
                if (typeof summary === 'string' && summary.trim() !== "") {
                    console.log(`PlanExecutor.summarizeDataWithLLM: Summarization successful for step "${narrativeStep}".`);
                    return summary;
                } else {
                    console.warn(`PlanExecutor.summarizeDataWithLLM: LLM returned empty or non-string summary for step "${narrativeStep}". Original data (or its beginning) will be used.`);
                    return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long and summarization failed)" : "");
                }
            } catch (error) {
                console.error(`PlanExecutor.summarizeDataWithLLM: Error during summarization for step "${narrativeStep}": ${error.message}`);
                return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long and summarization failed)" : "");
            }
        }
        return dataToSummarize; // Return original (or stringified) data if not longer than MAX_DATA_LENGTH
    }

    async _handleExploreSearchResults(subTaskDefinition, executionContext, parentTaskId) {
        // Adapted from OrchestratorAgent.handleUserTask
        console.log(`PlanExecutor: Handling special step - ExploreSearchResults: "${subTaskDefinition.narrative_step}"`);
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
                sub_task_id: `explore_${uuidv4()}`, // Generate ID for this "internal" step
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
            return { sub_task_id: `explore_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED", result_data: "No valid links found in search results to explore.", error_details: null };
        }

        let aggregatedContent = "";
        const webpageReader = this.tools.ReadWebpageTool || new ReadWebpageTool();

        for (const url of linksToRead) {
            try {
                console.log(`PlanExecutor.ExploreSearchResults: Reading URL - ${url}`);
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
            sub_task_id: `explore_${uuidv4()}`,
            narrative_step: subTaskDefinition.narrative_step,
            tool_name: "ExploreSearchResults",
            assigned_agent_role: "Orchestrator",
            sub_task_input: subTaskDefinition.sub_task_input,
            status: "COMPLETED",
            result_data: aggregatedContent || "No content could be fetched from the explored pages.",
            error_details: null
        };
    }

    async _handleGeminiStepExecutor(subTaskDefinition, executionContext, parentTaskId) {
        // Adapted from OrchestratorAgent.handleUserTask
        console.log(`PlanExecutor: Handling special step - GeminiStepExecutor: "${subTaskDefinition.narrative_step}"`);
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
            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "FAILED", error_details: { message: "Prompt is empty for GeminiStepExecutor." } };
        }

        try {
            const resultData = await this.llmService(promptInput);
            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "COMPLETED", result_data: resultData, error_details: null };
        } catch (e) {
            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", sub_task_input: subTaskDefinition.sub_task_input, status: "FAILED", error_details: { message: e.message } };
        }
    }

    async executePlan(planStages, parentTaskId, userTaskString) {
        const executionContext = [];
        let overallSuccess = true;
        // Note: allExecutedStepsInfo was used to populate finalOrchestratorResponse.plan
        // If this is still needed, it should be returned by executePlan or handled by Orchestrator.
        // For now, OrchestratorAgent will use the original planStages for this.

        for (let i = 0; i < planStages.length; i++) {
            const currentStageTaskDefinitions = planStages[i];
            console.log(`PlanExecutor: Starting Stage ${i + 1}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`);
            const stageSubTaskPromises = [];

            for (const subTaskDefinition of currentStageTaskDefinitions) {
                if (subTaskDefinition.assigned_agent_role === "Orchestrator" && subTaskDefinition.tool_name === "ExploreSearchResults") {
                    // Ensure executionContext is passed correctly for _handleExploreSearchResults to find previous results
                    stageSubTaskPromises.push(this._handleExploreSearchResults(subTaskDefinition, executionContext, parentTaskId));
                } else if (subTaskDefinition.assigned_agent_role === "Orchestrator" && subTaskDefinition.tool_name === "GeminiStepExecutor") {
                    stageSubTaskPromises.push(this._handleGeminiStepExecutor(subTaskDefinition, executionContext, parentTaskId));
                } else { // Regular worker agent task
                    const sub_task_id = uuidv4();
                    const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: subTaskDefinition.narrative_step };
                    this.subTaskQueue.enqueueTask(taskMessage);
                    console.log(`PlanExecutor: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${taskMessage.narrative_step}" for Stage ${i + 1}`);

                    const subTaskPromise = new Promise((resolve) => {
                        this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                            if (error) {
                                console.error(`PlanExecutor: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${i+1}):`, error.message);
                                resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: error.message } });
                            } else if (resultMsg) {
                                if (resultMsg.sub_task_id === sub_task_id) {
                                    console.log(`PlanExecutor: Received result for sub_task_id ${sub_task_id} (Stage ${i+1}). Status: ${resultMsg.status}`);
                                    resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details });
                                } else {
                                    const errorMessage = `PlanExecutor: Critical - Received mismatched sub_task_id. Expected ${sub_task_id}, but got ${resultMsg.sub_task_id} for parent_task_id ${parentTaskId} (Stage ${i+1}).`;
                                    console.error(errorMessage);
                                    resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage } });
                                }
                            }
                        }, sub_task_id); // Subscribe with sub_task_id for specific result
                    });
                    stageSubTaskPromises.push(subTaskPromise);
                }
            }

            const stageResults = await Promise.all(stageSubTaskPromises);
            const stageContextEntries = [];
            for (let j = 0; j < stageResults.length; j++) {
                const resultOfSubTask = stageResults[j];
                const originalSubTaskDef = currentStageTaskDefinitions[j]; // Assuming order is maintained

                let processedData = resultOfSubTask.result_data;
                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                    resultOfSubTask.assigned_agent_role !== "Orchestrator") { // Do not summarize Orchestrator's own special actions by default
                    processedData = await this._summarizeStepData(resultOfSubTask.result_data, userTaskString, resultOfSubTask.narrative_step);
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
                    sub_task_id: resultOfSubTask.sub_task_id
                };
                stageContextEntries.push(contextEntry);
            }
            executionContext.push(...stageContextEntries);

            for (const entry of stageContextEntries) {
                if (entry.status === "FAILED") {
                    console.error(`PlanExecutor: Sub-task ${entry.sub_task_id} ("${entry.narrative_step}") failed in Stage ${i + 1}. Halting further stages.`);
                    overallSuccess = false;
                    break;
                }
            }
            if (!overallSuccess) break;
            console.log(`PlanExecutor: Stage ${i + 1} completed successfully.`);
        }

        console.log(`PlanExecutor: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);
        return { success: overallSuccess, executionContext };
    }
}

module.exports = PlanExecutor;
