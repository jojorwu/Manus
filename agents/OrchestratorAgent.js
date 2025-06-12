const { v4: uuidv4 } = require('uuid'); // For generating unique sub_task_ids
const fs = require('fs');
const path = require('path');
const { saveTaskState } = require('../utils/taskStateUtil');
const { loadTaskState } = require('../utils/taskStateUtil');

// Helper function to parse and validate the LLM's staged plan response
async function parseSubTaskPlanResponse(jsonStringResponse, knownAgentRoles, knownToolsByRole) {
    const MAX_RAW_RESPONSE_LENGTH = 500;
    let cleanedString = jsonStringResponse;

    if (typeof jsonStringResponse !== 'string') {
        const detailsString = String(jsonStringResponse);
        const trimmedDetails = detailsString.length > MAX_RAW_RESPONSE_LENGTH ? detailsString.substring(0, MAX_RAW_RESPONSE_LENGTH) + "..." : detailsString;
        return { success: false, message: "LLM did not return a string response for the plan.", details: trimmedDetails, stages: [] };
    }

    try {
        if (cleanedString.startsWith('```json')) {
            cleanedString = cleanedString.substring(7);
            if (cleanedString.endsWith('```')) {
                cleanedString = cleanedString.slice(0, -3);
            }
        }
        cleanedString = cleanedString.trim();
        const parsedStages = JSON.parse(cleanedString);

        if (!Array.isArray(parsedStages)) {
            return { success: false, message: "LLM plan is not a JSON array of stages.", rawResponse: cleanedString, stages: [] };
        }
        if (parsedStages.length === 0) {
            return { success: false, message: "LLM plan is empty (no stages).", rawResponse: cleanedString, stages: [] };
        }

        for (const stage of parsedStages) {
            if (!Array.isArray(stage)) {
                return { success: false, message: "Invalid stage in plan: not an array.", rawResponse: cleanedString, stages: [] };
            }
            if (stage.length === 0) {
                return { success: false, message: "Invalid stage in plan: stage is empty.", rawResponse: cleanedString, stages: [] };
            }
            for (const subTask of stage) {
                if (typeof subTask !== 'object' || subTask === null) {
                    return { success: false, message: "Invalid sub-task structure: not an object.", rawResponse: cleanedString, stages: [] };
                }
                if (!subTask.assigned_agent_role || typeof subTask.assigned_agent_role !== 'string' || !knownAgentRoles.includes(subTask.assigned_agent_role)) {
                    return { success: false, message: `Invalid or unknown 'assigned_agent_role': ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                }
                const agentTools = knownToolsByRole[subTask.assigned_agent_role];
                if (!subTask.tool_name || typeof subTask.tool_name !== 'string' || !agentTools || !agentTools.includes(subTask.tool_name)) {
                    return { success: false, message: `Invalid or unknown 'tool_name': ${subTask.tool_name} for role ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                }
                if (typeof subTask.sub_task_input !== 'object' || subTask.sub_task_input === null) {
                    return { success: false, message: "Invalid 'sub_task_input': must be an object.", rawResponse: cleanedString, stages: [] };
                }
                if (!subTask.narrative_step || typeof subTask.narrative_step !== 'string' || !subTask.narrative_step.trim()) {
                    return { success: false, message: "Missing or empty 'narrative_step'.", rawResponse: cleanedString, stages: [] };
                }
            }
        }
        return { success: true, stages: parsedStages };
    } catch (e) {
        const trimmedRawResponse = cleanedString.length > MAX_RAW_RESPONSE_LENGTH ? cleanedString.substring(0, MAX_RAW_RESPONSE_LENGTH) + "..." : cleanedString;
        console.error("Error parsing sub-task plan JSON:", e.message, "Raw response:", trimmedRawResponse);
        return { success: false, message: "Failed to parse LLM plan: " + e.message, rawResponse: trimmedRawResponse, stages: [] };
    }
}

class OrchestratorAgent {
  constructor(subTaskQueue, resultsQueue, llmService, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.llmService = llmService;
    this.agentApiKeysConfig = agentApiKeysConfig;

    const capabilitiesPath = path.join(__dirname, '..', 'config', 'agentCapabilities.json');
    try {
        const capabilitiesFileContent = fs.readFileSync(capabilitiesPath, 'utf8');
        this.workerAgentCapabilities = JSON.parse(capabilitiesFileContent);
        console.log("OrchestratorAgent: Worker capabilities loaded successfully from config/agentCapabilities.json");
    } catch (error) {
        console.error(`OrchestratorAgent: Failed to load worker capabilities from ${capabilitiesPath}. Error: ${error.message}`);
        console.error("OrchestratorAgent: Falling back to default/empty capabilities. This may impact planning.");
        this.workerAgentCapabilities = [];
    }
    if (this.workerAgentCapabilities.length > 0) {
        console.log(`OrchestratorAgent initialized with ${this.workerAgentCapabilities.length} worker capabilities loaded.`);
    } else {
        console.log("OrchestratorAgent initialized with NO worker capabilities due to loading error or empty config.");
    }

    this.planTemplates = [];
    this.loadPlanTemplates();
  }

  loadPlanTemplates() {
    const templatesDir = path.join(__dirname, '..', 'config', 'plan_templates');
    this.planTemplates = [];
    try {
        if (!fs.existsSync(templatesDir)) {
            console.warn(`OrchestratorAgent: Plan templates directory not found at ${templatesDir}. No templates loaded.`);
            return;
        }
        const templateDefinitions = [
            { name: "weather_query", fileName: "weather_query_template.json", regex: /^(?:what is the )?weather (?:in )?(.+)/i, paramMapping: { CITY_NAME: 1 } },
            { name: "calculator", fileName: "calculator_template.json", regex: /^(?:calculate|what is) ([\d\s\+\-\*\/\(\)\.^%]+)/i, paramMapping: { EXPRESSION: 1 } }
        ];
        for (const def of templateDefinitions) {
            const filePath = path.join(templatesDir, def.fileName);
            if (fs.existsSync(filePath)) {
                const templateContent = fs.readFileSync(filePath, 'utf8');
                this.planTemplates.push({ name: def.name, regex: def.regex, paramMapping: def.paramMapping, template: JSON.parse(templateContent) });
                console.log(`OrchestratorAgent: Loaded plan template '${def.name}' from ${def.fileName}`);
            } else {
                console.warn(`OrchestratorAgent: Plan template file ${def.fileName} not found in ${templatesDir}`);
            }
        }
    } catch (error) {
        console.error(`OrchestratorAgent: Error loading plan templates: ${error.message}`);
        this.planTemplates = [];
    }
  }

  async tryGetPlanFromTemplate(userTaskString) {
    if (!this.planTemplates || this.planTemplates.length === 0) return null;
    for (const templateInfo of this.planTemplates) {
        const match = templateInfo.regex.exec(userTaskString);
        if (match) {
            console.log(`OrchestratorAgent: Matched plan template '${templateInfo.name}' for task.`);
            let populatedTemplateString = JSON.stringify(templateInfo.template);
            for (const placeholder in templateInfo.paramMapping) {
                const groupIndex = templateInfo.paramMapping[placeholder];
                const value = match[groupIndex] ? match[groupIndex].trim() : "";
                populatedTemplateString = populatedTemplateString.replace(new RegExp(`{{${placeholder}}}`, 'g'), value);
            }
            try {
                return JSON.parse(populatedTemplateString);
            } catch (e) {
                console.error(`OrchestratorAgent: Error parsing populated template '${templateInfo.name}'. Error: ${e.message}`);
                return null;
            }
        }
    }
    return null;
  }

  async summarizeDataWithLLM(dataToSummarize, userTaskString, narrativeStep) {
    const MAX_DATA_LENGTH = 1000;
    let dataString;
    if (typeof dataToSummarize === 'string') dataString = dataToSummarize;
    else try { dataString = JSON.stringify(dataToSummarize); } catch (e) {
        console.warn(`OrchestratorAgent.summarizeDataWithLLM: Could not stringify data for step "${narrativeStep}". Using raw data type. Error: ${e.message}`);
        return dataToSummarize;
    }
    if (dataString.length > MAX_DATA_LENGTH) {
        console.log(`OrchestratorAgent.summarizeDataWithLLM: Data for step "${narrativeStep}" is too long (${dataString.length} chars), attempting summarization.`);
        const summarizationPrompt = `The original user task was: "${userTaskString}".
A step in the execution plan, described as "${narrativeStep}", produced the following data:
---
${dataString.substring(0, MAX_DATA_LENGTH)}... (data truncated for this prompt if originally longer)
---
Please summarize this data concisely, keeping in mind its relevance to the original user task and the step description. The summary should be a string, suitable for inclusion as context for a final answer synthesis. Focus on extracting key information and outcomes. Provide only the summary text.`;
        try {
            const summary = await this.llmService(summarizationPrompt);
            if (typeof summary === 'string' && summary.trim() !== "") {
                console.log(`OrchestratorAgent.summarizeDataWithLLM: Summarization successful for step "${narrativeStep}".`);
                return summary;
            } else {
                console.warn(`OrchestratorAgent.summarizeDataWithLLM: LLM returned empty or non-string summary for step "${narrativeStep}". Original data (or its beginning) will be used.`);
                return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long and summarization failed)" : "");
            }
        } catch (error) {
            console.error(`OrchestratorAgent.summarizeDataWithLLM: Error during summarization for step "${narrativeStep}": ${error.message}`);
            return dataString.substring(0, MAX_DATA_LENGTH) + (dataString.length > MAX_DATA_LENGTH ? "... (original data was too long and summarization failed)" : "");
        }
    }
    return dataToSummarize;
  }

  async handleUserTask(userTaskString, parentTaskId, taskIdToLoad = null, executionMode = "EXECUTE_FULL_PLAN") {
    console.log(`OrchestratorAgent: Received task: '${userTaskString ? userTaskString.substring(0,100)+'...' : 'N/A'}', parentTaskId: ${parentTaskId}, taskIdToLoad: ${taskIdToLoad}, mode: ${executionMode}`);

    if (executionMode === "SYNTHESIZE_ONLY") {
        if (!taskIdToLoad) {
            return { success: false, message: "SYNTHESIZE_ONLY mode requires a taskIdToLoad.", originalTask: userTaskString, executedPlan: [], finalAnswer: null };
        }
        let loadedState = null;
        let stateFilePath = null;
        const savedTasksBaseDir = path.join(__dirname, '..', 'saved_tasks');
        try {
            await fs.promises.access(savedTasksBaseDir);
            const allDirents = await fs.promises.readdir(savedTasksBaseDir, { withFileTypes: true });
            const dateDirs = allDirents.filter(dirent => dirent.isDirectory() && dirent.name.startsWith('tasks_')).map(dirent => dirent.name).sort((a, b) => b.localeCompare(a));
            for (const dateDir of dateDirs) {
                const tryPath = path.join(savedTasksBaseDir, dateDir, `task_state_${taskIdToLoad}.json`);
                try { await fs.promises.access(tryPath); stateFilePath = tryPath; break; } catch (fileAccessError) {}
            }
        } catch (baseDirError) { console.warn(`OrchestratorAgent: Error accessing saved tasks base directory ${savedTasksBaseDir}: ${baseDirError.message}`); }

        if (!stateFilePath) {
             console.warn(`OrchestratorAgent (SYNTHESIZE_ONLY): State file for taskId '${taskIdToLoad}' not found.`);
             return { success: false, message: `State file for task ID '${taskIdToLoad}' not found. Cannot synthesize.`, originalTask: null, executedPlan: [], finalAnswer: null };
        }

        console.log(`OrchestratorAgent (SYNTHESIZE_ONLY): Attempting to load state from ${stateFilePath}.`);
        try {
            const loadResult = await loadTaskState(stateFilePath);
            if (!loadResult.success || !loadResult.taskState) {
                console.error(`OrchestratorAgent (SYNTHESIZE_ONLY): Failed to load task state from ${stateFilePath}: ${loadResult.message}`);
                return { success: false, message: `Failed to load task state for taskId '${taskIdToLoad}': ${loadResult.message}`, originalTask: null, executedPlan: [], finalAnswer: null };
            }
            loadedState = loadResult.taskState;
        } catch (loadError) {
            console.error(`OrchestratorAgent (SYNTHESIZE_ONLY): Critical error loading task state from ${stateFilePath}: ${loadError.message}`);
            return { success: false, message: `Critical error loading task state for taskId '${taskIdToLoad}': ${loadError.message}`, originalTask: null, executedPlan: [], finalAnswer: null };
        }

        const originalUserTaskString = loadedState.userTaskString;
        if (!loadedState.executionContext || loadedState.executionContext.length === 0) return { success: false, message: `No execution context found for taskId '${taskIdToLoad}'. Cannot synthesize.`, originalTask: originalUserTaskString, executedPlan: loadedState.executionContext, finalAnswer: null };

        const executionContextForSynthesis = loadedState.executionContext.map(entry => ({ ...entry, outcome_data: entry.processed_result_data !== undefined ? entry.processed_result_data : entry.result_data }));
        const contextForLLMSynthesis = executionContextForSynthesis.map(entry => ({ step_narrative: entry.narrative_step, tool_used: entry.tool_name, input_details: entry.sub_task_input, status: entry.status, outcome_data: entry.outcome_data, error_info: entry.error_details }));
        const synthesisContextString = JSON.stringify(contextForLLMSynthesis, null, 2);
        let finalAnswer = null; let synthesisMessage = "";

        if (contextForLLMSynthesis.every(e => e.status === "FAILED" || (e.status === "COMPLETED" && (e.outcome_data === null || e.outcome_data === undefined)))) {
            console.log("OrchestratorAgent (SYNTHESIZE_ONLY): No successful results with actionable data to synthesize.");
            synthesisMessage = "Loaded task state contained no specific data to synthesize from, or all steps had failed.";
            finalAnswer = "No specific information was generated from the previous execution to form a new final answer.";
        } else {
            const synthesisPrompt = `The original user task was: "${originalUserTaskString}".
A plan was previously executed for this task. The following is a JSON array detailing each step of that execution:
---
Execution History (JSON Array):
${synthesisContextString}
---
Based on the original user task and the detailed execution history, synthesize a comprehensive and coherent final answer for the user. Provide only the final answer.`;
            try {
                finalAnswer = await this.llmService(synthesisPrompt);
                synthesisMessage = "Synthesized answer from loaded task state.";
                console.log("OrchestratorAgent (SYNTHESIZE_ONLY): Final answer synthesized successfully.");
            } catch (synthError) {
                console.error("OrchestratorAgent (SYNTHESIZE_ONLY): Error during final answer synthesis:", synthError.message);
                finalAnswer = "Error during final answer synthesis from loaded state: " + synthError.message;
                synthesisMessage = "Error during synthesis from loaded state.";
            }
        }
        return { success: true, message: synthesisMessage, originalTask: originalUserTaskString, plan: loadedState.plan, executedPlan: executionContextForSynthesis, finalAnswer: finalAnswer };

    } else if (executionMode === "PLAN_ONLY" || executionMode === "EXECUTE_FULL_PLAN") {
        if (!userTaskString) {
            return { success: false, message: `Task string is required for ${executionMode} mode.`, originalTask: null, taskId: parentTaskId };
        }
        console.log(`OrchestratorAgent (${executionMode}): Processing task: "${userTaskString}"`);

        let parsedPlanResult = null;
        const templatePlan = await this.tryGetPlanFromTemplate(userTaskString);

        const knownAgentRoles = [];
        const knownToolsByRole = {};

        if (templatePlan) {
            console.log("OrchestratorAgent: Using plan from template.");
            if (Array.isArray(templatePlan) && templatePlan.every(stage => Array.isArray(stage))) {
                parsedPlanResult = { success: true, stages: templatePlan };
            } else {
                console.error("OrchestratorAgent: Template plan is not in the expected format (array of stages). Falling back to LLM.");
            }
        }

        if (!parsedPlanResult) {
            console.log("OrchestratorAgent: No valid matching template found, proceeding with LLM-based planning.");

            let formattedAgentCapabilitiesString = "You have the following specialized agents available:\n";
            if (!this.workerAgentCapabilities || this.workerAgentCapabilities.length === 0) {
                console.error(`OrchestratorAgent (${executionMode}): No worker agent capabilities defined. Cannot proceed.`);
                return { success: false, message: `Internal Server Error: No worker agent capabilities configured for ${executionMode} mode.`, originalTask: userTaskString, taskId: parentTaskId };
            }
            this.workerAgentCapabilities.forEach(agent => {
                knownAgentRoles.push(agent.role);
                knownToolsByRole[agent.role] = agent.tools.map(t => t.name);
                formattedAgentCapabilitiesString += "---\n";
                formattedAgentCapabilitiesString += `Agent Role: ${agent.role}\n`;
                formattedAgentCapabilitiesString += `Description: ${agent.description}\n`;
                formattedAgentCapabilitiesString += `Tools:\n`;
                agent.tools.forEach(tool => {
                    formattedAgentCapabilitiesString += `  - ${tool.name}: ${tool.description}\n`;
                });
            });
            formattedAgentCapabilitiesString += "---\n(End of available agents list)\n";

            const planningPrompt = `User task: '${userTaskString}'.
Available agent capabilities:
${formattedAgentCapabilitiesString}
Based on the user task and available agents, create a multi-stage execution plan.
The plan MUST be a JSON array of stages. Each stage MUST be a JSON array of sub-task objects.
Sub-tasks within the same stage can be executed in parallel. Stages are executed sequentially.
Each sub-task object in an inner array must have the following keys:
1. 'assigned_agent_role': String (must be one of [${knownAgentRoles.map(r => `"${r}"`).join(", ")}]).
2. 'tool_name': String (must be a tool available to the assigned agent, as listed in its capabilities).
3. 'sub_task_input': Object (the input for the specified tool, matching its described input format).
4. 'narrative_step': String (a short, human-readable description of this step's purpose in the context of the overall user task).
Produce ONLY the JSON array of stages. Do not include any other text before or after the JSON.`;

            let planJsonString;
            try {
                planJsonString = await this.llmService(planningPrompt);
            } catch (llmError) {
                console.error(`OrchestratorAgent (${executionMode}): Error from LLM service during planning:`, llmError.message);
                const errorState = { taskId: parentTaskId, userTaskString, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: `LLM service error: ${llmError.message}` }};
                const nowError = new Date(); const monthError = String(nowError.getMonth() + 1).padStart(2, '0'); const dayError = String(nowError.getDate()).padStart(2, '0'); const yearError = nowError.getFullYear();
                const dateDirError = `tasks_${monthError}${dayError}${yearError}`;
                const rootDirError = path.join(__dirname, '..');
                const saveDirError = path.join(rootDirError, 'saved_tasks', dateDirError);
                const taskStateFilePathError = path.join(saveDirError, `task_state_${parentTaskId}.json`);
                try {
                    await saveTaskState(errorState, taskStateFilePathError);
                } catch (saveError) {
                    console.error(`OrchestratorAgent (${executionMode}): Failed to save error task state for ${parentTaskId} (LLM error): ${saveError.message}`);
                }
                return { success: false, message: `Failed to generate plan: ${llmError.message}`, taskId: parentTaskId, originalTask: userTaskString };
            }
            parsedPlanResult = await parseSubTaskPlanResponse(planJsonString, knownAgentRoles, knownToolsByRole);
        }

        if (!parsedPlanResult || !parsedPlanResult.success) {
            const TPSR_Error_Message = parsedPlanResult ? parsedPlanResult.message : "Plan generation or template processing failed before parsing.";
            const TPSR_Raw_Response = parsedPlanResult ? parsedPlanResult.rawResponse : null;
            console.error(`OrchestratorAgent (${executionMode}): Failed to obtain a valid plan: ${TPSR_Error_Message}`);
            const errorState = { taskId: parentTaskId, userTaskString, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: TPSR_Error_Message }, rawLLMResponse: TPSR_Raw_Response };
            const nowError = new Date(); const monthError = String(nowError.getMonth() + 1).padStart(2, '0'); const dayError = String(nowError.getDate()).padStart(2, '0'); const yearError = nowError.getFullYear();
            const dateDirError = `tasks_${monthError}${dayError}${yearError}`;
            const rootDirError = path.join(__dirname, '..');
            const saveDirError = path.join(rootDirError, 'saved_tasks', dateDirError);
            const taskStateFilePathError = path.join(saveDirError, `task_state_${parentTaskId}.json`);
            try {
                await saveTaskState(errorState, taskStateFilePathError);
            } catch (saveError) {
                console.error(`OrchestratorAgent (${executionMode}): Failed to save error task state for ${parentTaskId} (parse error): ${saveError.message}`);
            }
            return { success: false, message: TPSR_Error_Message, taskId: parentTaskId, originalTask: userTaskString, rawResponse: TPSR_Raw_Response };
        }

        const planStages = parsedPlanResult.stages;
        console.log(`OrchestratorAgent (${executionMode}): Parsed plan with ${planStages.length} stage(s).`);

        if (executionMode === "PLAN_ONLY") {
            const taskStateToSave = { taskId: parentTaskId, userTaskString, status: "PLAN_GENERATED", plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null };
            const now = new Date(); const month = String(now.getMonth() + 1).padStart(2, '0'); const day = String(now.getDate()).padStart(2, '0'); const year = now.getFullYear();
            const dateDir = `tasks_${month}${day}${year}`;
            const rootDir = path.join(__dirname, '..');
            const saveDir = path.join(rootDir, 'saved_tasks', dateDir);
            const taskStateFilePath = path.join(saveDir, `task_state_${parentTaskId}.json`);
            try {
                await saveTaskState(taskStateToSave, taskStateFilePath);
                return { success: true, message: "Plan generated and saved successfully.", taskId: parentTaskId, originalTask: userTaskString, plan: planStages };
            } catch (saveError) {
                console.error(`OrchestratorAgent (PLAN_ONLY): Failed to save task state for ${parentTaskId}: ${saveError.message}`);
                return { success: true, message: "Plan generated, but failed to save task state: " + saveError.message, taskId: parentTaskId, originalTask: userTaskString, plan: planStages };
            }
        }

        // --- EXECUTE_FULL_PLAN specific logic continues ---
        const allExecutedStepsInfo = [];
        const executionContext = [];
        let overallSuccess = true;

        for (let i = 0; i < planStages.length; i++) {
            const currentStageTaskDefinitions = planStages[i];
            console.log(`OrchestratorAgent: Starting Stage ${i + 1}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`);
            const stageSubTaskPromises = [];
            for (const subTaskDefinition of currentStageTaskDefinitions) {
                allExecutedStepsInfo.push({ narrative_step: subTaskDefinition.narrative_step, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input });
                const sub_task_id = uuidv4();
                const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: subTaskDefinition.narrative_step };
                console.log('OrchestratorAgent: Dispatching taskMessage:', JSON.stringify(taskMessage, null, 2));
                this.subTaskQueue.enqueueTask(taskMessage);
                console.log(`Orchestrator: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${taskMessage.narrative_step}" for Stage ${i + 1}`);
                const subTaskPromise = new Promise((resolve) => {
                    this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                        if (error) { console.error(`Orchestrator: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${i+1}):`, error.message); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: error.message } }); }
                        else if (resultMsg) {
                            if (resultMsg.sub_task_id === sub_task_id) { console.log(`Orchestrator: Received result for sub_task_id ${sub_task_id} (Stage ${i+1}). Status: ${resultMsg.status}`); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details }); }
                            else { const errorMessage = `Orchestrator: Critical - Received mismatched sub_task_id. Expected ${sub_task_id}, but got ${resultMsg.sub_task_id} for parent_task_id ${parentTaskId} (Stage ${i+1}). This indicates an issue with result routing or subscription logic.`; console.error(errorMessage); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage } }); }
                        }
                    }, sub_task_id);
                });
                stageSubTaskPromises.push(subTaskPromise);
            }
            const stageResults = await Promise.all(stageSubTaskPromises);
            const stageContextEntries = [];
            for (let j = 0; j < stageResults.length; j++) {
                const resultOfSubTask = stageResults[j];
                const subTaskDefinition = currentStageTaskDefinitions[j];
                let processedData = resultOfSubTask.result_data;
                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data) {
                    processedData = await this.summarizeDataWithLLM(resultOfSubTask.result_data, userTaskString, subTaskDefinition.narrative_step);
                }
                const contextEntry = { narrative_step: subTaskDefinition.narrative_step, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, status: resultOfSubTask.status, processed_result_data: processedData, raw_result_data: resultOfSubTask.result_data, error_details: resultOfSubTask.error_details, sub_task_id: resultOfSubTask.sub_task_id };
                stageContextEntries.push(contextEntry);
            }
            executionContext.push(...stageContextEntries);
            for (const result of stageResults) { if (result.status === "FAILED") { console.error(`Orchestrator: Sub-task ${result.sub_task_id} ("${result.narrative_step}") failed in Stage ${i + 1}. Halting further stages for this parent task.`); overallSuccess = false; break; } }
            if (!overallSuccess) break;
            console.log(`OrchestratorAgent: Stage ${i + 1} completed successfully.`);
        }

        console.log(`OrchestratorAgent: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);
        let finalOrchestratorResponse = { success: overallSuccess, message: "", originalTask: userTaskString, plan: allExecutedStepsInfo, executedPlan: executionContext, finalAnswer: null };

        if (overallSuccess && executionContext.length > 0) {
            const contextForLLMSynthesis = executionContext.map(entry => ({ step_narrative: entry.narrative_step, tool_used: entry.tool_name, input_details: entry.sub_task_input, status: entry.status, outcome_data: entry.processed_result_data, error_info: entry.error_details }));
            const synthesisContextString = JSON.stringify(contextForLLMSynthesis, null, 2);
            if (contextForLLMSynthesis.every(e => e.status === "FAILED" || (e.status === "COMPLETED" && (e.outcome_data === null || e.outcome_data === undefined)))) {
                console.log("OrchestratorAgent: No successful results with actionable data to synthesize. Skipping synthesis.");
                finalOrchestratorResponse.message = "All sub-tasks were executed, but no specific data was gathered or all steps failed, so a synthesized answer cannot be provided.";
                finalOrchestratorResponse.finalAnswer = "The process completed, but no specific information was generated to form a final answer, or all steps resulted in errors.";
            } else {
                const synthesisPrompt = `The original user task was: "${userTaskString}".
A plan was executed to address this task. The following is a JSON array detailing each step of the execution. Each object in the array represents a step and includes:
- 'step_narrative': A human-readable description of the step's purpose.
- 'tool_used': The name of the tool used for the step.
- 'input_details': The input provided to the tool for this step.
- 'status': The execution status of the step ('COMPLETED' or 'FAILED').
- 'outcome_data': The data returned by the tool if the step completed successfully (can be null).
- 'error_info': Details of the error if the step failed.
---
Execution History (JSON Array):
${synthesisContextString}
---
Based on the original user task and the detailed execution history provided above, synthesize a comprehensive and coherent final answer for the user. If a step failed, acknowledge it briefly if relevant, but focus on the information gathered from successful steps to formulate the answer. Integrate the information smoothly. If some steps were just actions and yielded no specific data but completed successfully (i.e., 'outcome_data' is null or undefined), acknowledge them if relevant to the overall narrative of the answer. Provide only the final answer to the user. Do not repeat the execution history in your answer.`;
                console.log("OrchestratorAgent: Attempting final synthesis with new structured prompt and context.");
                try {
                    const synthesizedAnswer = await this.llmService(synthesisPrompt);
                    finalOrchestratorResponse.finalAnswer = synthesizedAnswer;
                    finalOrchestratorResponse.message = "Task completed and final answer synthesized.";
                    console.log("OrchestratorAgent: Final answer synthesized successfully.");
                } catch (synthError) {
                    console.error("OrchestratorAgent: Error during final answer synthesis:", synthError.message);
                    finalOrchestratorResponse.finalAnswer = "Error during final answer synthesis: " + synthError.message;
                    finalOrchestratorResponse.message = "Sub-tasks completed, but final answer synthesis failed.";
                }
            }
        } else if (!overallSuccess) {
          finalOrchestratorResponse.message = "One or more sub-tasks failed. Unable to provide a final synthesized answer.";
        } else {
          finalOrchestratorResponse.message = "No sub-tasks were executed, though the process was marked successful.";
        }

        if (executionMode === "EXECUTE_FULL_PLAN") {
            const taskStateToSave = { taskId: parentTaskId, userTaskString, createdAt: null, updatedAt: null, status: finalOrchestratorResponse.success ? "COMPLETED" : (finalOrchestratorResponse.message.includes("plan") ? "FAILED_PLANNING" : "FAILED_EXECUTION"), currentStageIndex: null, plan: finalOrchestratorResponse.plan, executionContext: finalOrchestratorResponse.executedPlan, finalAnswer: finalOrchestratorResponse.finalAnswer, errorSummary: null };
            if (!finalOrchestratorResponse.success) {
                taskStateToSave.errorSummary = { failedAtStage: null, reason: finalOrchestratorResponse.message };
                if (taskStateToSave.status === "FAILED_EXECUTION" && finalOrchestratorResponse.executedPlan && finalOrchestratorResponse.executedPlan.length > 0) {
                    const lastStep = finalOrchestratorResponse.executedPlan[finalOrchestratorResponse.executedPlan.length - 1];
                    if (lastStep && lastStep.error_details) taskStateToSave.errorSummary.reason = `Last failed step: ${lastStep.narrative_step}. Error: ${lastStep.error_details.message}`;
                }
            }
            const now = new Date(); const month = String(now.getMonth() + 1).padStart(2, '0'); const day = String(now.getDate()).padStart(2, '0'); const year = now.getFullYear();
            const dateDir = `tasks_${month}${day}${year}`;
            const rootDir = path.join(__dirname, '..');
            const saveDir = path.join(rootDir, 'saved_tasks', dateDir);
            const taskStateFilePath = path.join(saveDir, `task_state_${parentTaskId}.json`);
            try {
                await saveTaskState(taskStateToSave, taskStateFilePath);
            } catch (saveError) {
                console.error(`OrchestratorAgent (EXECUTE_FULL_PLAN): Failed to save final task state for ${parentTaskId}: ${saveError.message}`);
                finalOrchestratorResponse.message += ` (Warning: Failed to save final task state: ${saveError.message})`;
                // The success status of finalOrchestratorResponse should reflect the execution, not the save status.
            }
        }
        return finalOrchestratorResponse;
    } else {
        console.error(`OrchestratorAgent: Unknown execution mode '${executionMode}'.`);
        return { success: false, message: `Internal Server Error: Unknown execution mode '${executionMode}'.`};
    }
  }
}

module.exports = OrchestratorAgent;
