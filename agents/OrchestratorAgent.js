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

                // Validate assigned_agent_role and tool_name
                if (subTask.assigned_agent_role === "Orchestrator") {
                    if (subTask.tool_name !== "ExploreSearchResults" && subTask.tool_name !== "GeminiStepExecutor") {
                        return { success: false, message: `Invalid 'tool_name': ${subTask.tool_name} for Orchestrator role. Only 'ExploreSearchResults' or 'GeminiStepExecutor' allowed.`, rawResponse: cleanedString, stages: [] };
                    }
                } else if (!knownAgentRoles.includes(subTask.assigned_agent_role)) {
                    return { success: false, message: `Invalid or unknown 'assigned_agent_role': ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                } else { // This is a regular worker agent
                    const agentTools = knownToolsByRole[subTask.assigned_agent_role];
                    if (!subTask.tool_name || typeof subTask.tool_name !== 'string' || !agentTools || !agentTools.includes(subTask.tool_name)) {
                        return { success: false, message: `Invalid or unknown 'tool_name': ${subTask.tool_name} for role ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                    }
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
        // ... (existing SYNTHESIZE_ONLY logic remains unchanged) ...
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
             console.warn(`OrchestratorAgent: State file for taskId '${taskIdToLoad}' not found.`);
             return { success: false, message: `State file for task ID '${taskIdToLoad}' not found. Cannot synthesize.`, originalTask: null, executedPlan: [], finalAnswer: null };
        }
        console.log(`OrchestratorAgent: Attempting to load state from ${stateFilePath} for SYNTHESIZE_ONLY mode.`);
        const loadResult = await loadTaskState(stateFilePath);
        if (!loadResult.success || !loadResult.taskState) return { success: false, message: `Failed to load task state for taskId '${taskIdToLoad}': ${loadResult.message}`, originalTask: null, executedPlan: [], finalAnswer: null };
        loadedState = loadResult.taskState;
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

        const knownAgentRoles = []; // Define here to be in scope for LLM planning if needed
        const knownToolsByRole = {}; // Define here for the same reason

        if (templatePlan) {
            console.log("OrchestratorAgent: Using plan from template.");
            // Validate template plan structure (basic validation, more can be added if needed)
            if (Array.isArray(templatePlan) && templatePlan.every(stage => Array.isArray(stage))) {
                 // Here, we assume the template is validly structured regarding sub-task fields.
                 // A more robust solution might run the templatePlan through a light version of parseSubTaskPlanResponse
                 // or ensure templates are always valid. For now, we trust the pre-defined templates.
                parsedPlanResult = { success: true, stages: templatePlan };
            } else {
                console.error("OrchestratorAgent: Template plan is not in the expected format (array of stages). Falling back to LLM.");
                // parsedPlanResult will remain null, forcing LLM planning
            }
        }

        if (!parsedPlanResult) { // If no template plan or template was invalid
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
---
${formattedAgentCapabilitiesString}
---
Orchestrator Special Actions:
 - ExploreSearchResults: This is a special action for the Orchestrator. It should be used AFTER a WebSearchTool step to gather more detailed information from the search results.
   Input ('sub_task_input'):
     - 'pagesToExplore': (Optional, Integer, Default: 2) Number of top search result links to read using ReadWebpageTool.
     - 'relevanceCriteria': (Optional, String) Brief guidance on what makes a search result relevant for deeper exploration (e.g., "pages offering detailed explanations", "official documentation"). Orchestrator will primarily use the order of results.
   Functionality: The Orchestrator will take the results from the most recent WebSearchTool step in a preceding stage. It will select up to 'pagesToExplore' links. For each selected link, it will internally use 'ReadWebpageTool' to fetch its content. The collected content from all explored pages will then be aggregated.
   Output: An aggregated string containing the content from all explored pages.
   When to use: Use this if the user's task implies needing more than just search snippets and requires information from the content of the web pages found.
---
(End of available agents list and special actions)
Based on the user task and available capabilities, create a multi-stage execution plan.
The plan MUST be a JSON array of stages. Each stage MUST be a JSON array of sub-task objects.
Sub-tasks within the same stage can be executed in parallel. Stages are executed sequentially.
Each sub-task object in an inner array must have the following keys:
1. 'assigned_agent_role': String (must be one of [${knownAgentRoles.map(r => `"${r}"`).join(", ")}] OR "Orchestrator" for special actions).
2. 'tool_name': String (must be a tool available to the assigned agent OR a special action name like "ExploreSearchResults").
3. 'sub_task_input': Object (the input for the specified tool or action).
4. 'narrative_step': String (a short, human-readable description of this step's purpose).

For the 'ExploreSearchResults' action, set 'assigned_agent_role' to "Orchestrator" and 'tool_name' to "ExploreSearchResults". The 'sub_task_input' may include 'pagesToExplore' and 'relevanceCriteria'.

Example of a plan using ExploreSearchResults:
\`\`\`json
[
  [
    {
      "assigned_agent_role": "ResearchAgent",
      "tool_name": "WebSearchTool",
      "sub_task_input": { "query": "advantages of server-side rendering" },
      "narrative_step": "Search for advantages of server-side rendering."
    }
  ],
  [
    {
      "assigned_agent_role": "Orchestrator",
      "tool_name": "ExploreSearchResults",
      "sub_task_input": {
        "pagesToExplore": 2
      },
      "narrative_step": "Explore the top 2 search results about SSR advantages by reading their content."
    }
  ],
  [
    {
      "assigned_agent_role": "Orchestrator",
      "tool_name": "GeminiStepExecutor",
      "sub_task_input": {
        "prompt_template": "Based on the gathered information: {{previous_step_output}}, synthesize a comprehensive answer to the user's original query about server-side rendering."
      },
      "narrative_step": "Synthesize the final answer about SSR advantages from the explored content."
    }
  ]
]
\`\`\`
Produce ONLY the JSON array of stages. Do not include any other text before or after the JSON.`;

            let planJsonString;
            try {
                planJsonString = await this.llmService(planningPrompt);
            } catch (llmError) {
                console.error(`OrchestratorAgent (${executionMode}): Error from LLM service during planning:`, llmError.message);
                const errorState = { taskId: parentTaskId, userTaskString, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: `LLM service error: ${llmError.message}` }};
                // ... (save error state logic)
                const nowError = new Date(); const monthError = String(nowError.getMonth() + 1).padStart(2, '0'); const dayError = String(nowError.getDate()).padStart(2, '0'); const yearError = nowError.getFullYear();
                const dateDirError = `tasks_${monthError}${dayError}${yearError}`;
                const rootDirError = path.join(__dirname, '..');
                const saveDirError = path.join(rootDirError, 'saved_tasks', dateDirError);
                const taskStateFilePathError = path.join(saveDirError, `task_state_${parentTaskId}.json`);
                await saveTaskState(errorState, taskStateFilePathError);
                return { success: false, message: `Failed to generate plan: ${llmError.message}`, taskId: parentTaskId, originalTask: userTaskString };
            }
            parsedPlanResult = await parseSubTaskPlanResponse(planJsonString, knownAgentRoles, knownToolsByRole);
        }

        if (!parsedPlanResult || !parsedPlanResult.success) {
            const TPSR_Error_Message = parsedPlanResult ? parsedPlanResult.message : "Plan generation or template processing failed before parsing.";
            const TPSR_Raw_Response = parsedPlanResult ? parsedPlanResult.rawResponse : null;
            console.error(`OrchestratorAgent (${executionMode}): Failed to obtain a valid plan: ${TPSR_Error_Message}`);
            const errorState = { taskId: parentTaskId, userTaskString, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: TPSR_Error_Message }, rawLLMResponse: TPSR_Raw_Response };
            // ... (save error state logic) ...
            const nowError = new Date(); const monthError = String(nowError.getMonth() + 1).padStart(2, '0'); const dayError = String(nowError.getDate()).padStart(2, '0'); const yearError = nowError.getFullYear();
            const dateDirError = `tasks_${monthError}${dayError}${yearError}`;
            const rootDirError = path.join(__dirname, '..');
            const saveDirError = path.join(rootDirError, 'saved_tasks', dateDirError);
            const taskStateFilePathError = path.join(saveDirError, `task_state_${parentTaskId}.json`);
            await saveTaskState(errorState, taskStateFilePathError);
            return { success: false, message: TPSR_Error_Message, taskId: parentTaskId, originalTask: userTaskString, rawResponse: TPSR_Raw_Response };
        }

        const planStages = parsedPlanResult.stages;
        console.log(`OrchestratorAgent (${executionMode}): Parsed plan with ${planStages.length} stage(s).`);

        if (executionMode === "PLAN_ONLY") {
            const taskStateToSave = { taskId: parentTaskId, userTaskString, status: "PLAN_GENERATED", plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null };
            // ... (save state logic) ...
            const now = new Date(); const month = String(now.getMonth() + 1).padStart(2, '0'); const day = String(now.getDate()).padStart(2, '0'); const year = now.getFullYear();
            const dateDir = `tasks_${month}${day}${year}`;
            const rootDir = path.join(__dirname, '..');
            const saveDir = path.join(rootDir, 'saved_tasks', dateDir);
            const taskStateFilePath = path.join(saveDir, `task_state_${parentTaskId}.json`);
            await saveTaskState(taskStateToSave, taskStateFilePath);
            return { success: true, message: "Plan generated and saved successfully.", taskId: parentTaskId, originalTask: userTaskString, plan: planStages };
        }

        // --- EXECUTE_FULL_PLAN specific logic continues ---
        const allExecutedStepsInfo = [];
        const executionContext = [];
        let overallSuccess = true;

        for (let i = 0; i < planStages.length; i++) {
            // ... (existing stage execution logic, including summarization call) ...
            const currentStageTaskDefinitions = planStages[i];
            console.log(`OrchestratorAgent: Starting Stage ${i + 1}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`);
            const stageSubTaskPromises = [];
            const currentStageTaskDefinitions = planStages[i];
            console.log(`OrchestratorAgent: Starting Stage ${i + 1}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`);
            const stageSubTaskPromises = [];

            for (const subTaskDefinition of currentStageTaskDefinitions) { // Changed from 'j' to 'subTaskDefinition' for clarity
                allExecutedStepsInfo.push({ narrative_step: subTaskDefinition.narrative_step, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input });

                if (subTaskDefinition.assigned_agent_role === "Orchestrator" && subTaskDefinition.tool_name === "ExploreSearchResults") {
                    console.log(`Orchestrator: Handling special step - ExploreSearchResults: "${subTaskDefinition.narrative_step}"`);
                    const explorePromise = (async () => {
                        let previousSearchResults = null;
                        for (let k = executionContext.length - 1; k >= 0; k--) {
                            // Check processed_result_data first, then raw_result_data
                            const potentialResults = executionContext[k].processed_result_data || executionContext[k].raw_result_data;
                            if (executionContext[k].tool_name === "WebSearchTool" && executionContext[k].status === "COMPLETED" && potentialResults) {
                                if (Array.isArray(potentialResults)) {
                                    previousSearchResults = potentialResults;
                                } else if (typeof potentialResults === 'object' && Array.isArray(potentialResults.result)) { // Handle if WebSearchTool raw output was {result: [], error: null}
                                    previousSearchResults = potentialResults.result;
                                }
                                // Add further checks if WebSearchTool might return results in other structures
                                break;
                            }
                        }

                        if (!previousSearchResults || !Array.isArray(previousSearchResults) || previousSearchResults.length === 0) {
                            console.warn("ExploreSearchResults: No valid search results found from previous steps or results are not an array.");
                            return {
                                sub_task_id: `explore_${uuidv4()}`,
                                narrative_step: subTaskDefinition.narrative_step,
                                tool_name: "ExploreSearchResults",
                                assigned_agent_role: "Orchestrator",
                                status: "COMPLETED", // Completed, but with a note about no results
                                result_data: "No search results available to explore or results format was incompatible.",
                                error_details: null
                            };
                        }

                        const pagesToExplore = subTaskDefinition.sub_task_input?.pagesToExplore || 2;
                        const linksToRead = previousSearchResults.slice(0, pagesToExplore)
                                              .map(item => item && item.link) // ensure item and item.link exist
                                              .filter(link => typeof link === 'string' && link.trim() !== '');


                        if (linksToRead.length === 0) {
                            return { sub_task_id: `explore_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", status: "COMPLETED", result_data: "No valid links found in search results to explore.", error_details: null };
                        }

                        let aggregatedContent = "";
                        const ReadWebpageTool = require('../tools/ReadWebpageTool');
                        const webpageReader = new ReadWebpageTool();

                        for (const url of linksToRead) {
                            try {
                                console.log(`ExploreSearchResults: Reading URL - ${url}`);
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
                            status: "COMPLETED",
                            result_data: aggregatedContent || "No content could be fetched from the explored pages.",
                            error_details: null
                        };
                    })();
                    stageSubTaskPromises.push(explorePromise);

                } else if (subTaskDefinition.assigned_agent_role === "Orchestrator" && subTaskDefinition.tool_name === "GeminiStepExecutor") {
                    console.log(`Orchestrator: Handling special step - GeminiStepExecutor: "${subTaskDefinition.narrative_step}"`);
                    const geminiPromise = (async () => {
                        let promptInput = subTaskDefinition.sub_task_input?.prompt || "";
                        const promptTemplate = subTaskDefinition.sub_task_input?.prompt_template;
                        const promptParams = subTaskDefinition.sub_task_input?.prompt_params || {};

                        if (promptTemplate) {
                            promptInput = promptTemplate;
                            // Replace placeholders like {{placeholder}} or {placeholder}
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
                             // Fallback for a simple {{previous_step_output}} if not in prompt_params
                            if (promptInput.includes("{{previous_step_output}}")) {
                                 if (executionContext.length > 0) {
                                    const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput));
                                } else {
                                    promptInput = promptInput.replace(new RegExp("{{\\s*previous_step_output\\s*}}", 'g'), "No data from previous steps.");
                                }
                            }


                        } else if (!promptInput && subTaskDefinition.sub_task_input?.data_from_previous_step === true) { // Simple case: use previous step output as prompt
                             if (executionContext.length > 0) {
                                const lastStepOutput = executionContext[executionContext.length - 1].processed_result_data || executionContext[executionContext.length - 1].raw_result_data || "";
                                promptInput = typeof lastStepOutput === 'string' ? lastStepOutput : JSON.stringify(lastStepOutput);
                            } else {
                                promptInput = "No data from previous steps to use as prompt.";
                            }
                        }


                        if (!promptInput) {
                            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", status: "FAILED", error_details: { message: "Prompt is empty for GeminiStepExecutor." } };
                        }

                        try {
                            const resultData = await this.llmService(promptInput);
                            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", status: "COMPLETED", result_data: resultData, error_details: null };
                        } catch (e) {
                            return { sub_task_id: `gemini_${uuidv4()}`, narrative_step: subTaskDefinition.narrative_step, tool_name: "GeminiStepExecutor", assigned_agent_role: "Orchestrator", status: "FAILED", error_details: { message: e.message } };
                        }
                    })();
                    stageSubTaskPromises.push(geminiPromise);

                } else { // Regular worker agent task
                    const sub_task_id = uuidv4();
                    const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: subTaskDefinition.narrative_step };
                    // console.log('OrchestratorAgent: Dispatching taskMessage:', JSON.stringify(taskMessage, null, 2)); // Can be verbose
                    this.subTaskQueue.enqueueTask(taskMessage);
                    console.log(`Orchestrator: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${taskMessage.narrative_step}" for Stage ${i + 1}`);
                    const subTaskPromise = new Promise((resolve) => {
                        this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                            if (error) { console.error(`Orchestrator: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${i+1}):`, error.message); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: error.message } }); }
                            else if (resultMsg) {
                                if (resultMsg.sub_task_id === sub_task_id) { console.log(`Orchestrator: Received result for sub_task_id ${sub_task_id} (Stage ${i+1}). Status: ${resultMsg.status}`); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details }); }
                                else { const errorMessage = `Orchestrator: Critical - Received mismatched sub_task_id. Expected ${sub_task_id}, but got ${resultMsg.sub_task_id} for parent_task_id ${parentTaskId} (Stage ${i+1}). This indicates an issue with result routing or subscription logic.`; console.error(errorMessage); resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, sub_task_input: taskMessage.sub_task_input, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage } }); }
                            }
                        }, sub_task_id);
                    });
                    stageSubTaskPromises.push(subTaskPromise);
                }
            }
            const stageResults = await Promise.all(stageSubTaskPromises);
            const stageContextEntries = [];
            // Iterate using index j to align with currentStageTaskDefinitions if needed for original subTaskDefinition
            for (let j = 0; j < stageResults.length; j++) {
                const resultOfSubTask = stageResults[j];
                // For Orchestrator-handled steps, subTaskDefinition might not be directly from currentStageTaskDefinitions[j]
                // if their promises resolve to a structure that already includes narrative_step etc.
                // However, the current implementation of explorePromise and geminiPromise returns this info.
                const originalSubTaskDef = currentStageTaskDefinitions[j]; // Assuming order is maintained.

                let processedData = resultOfSubTask.result_data;
                // Summarization should only apply to actual tool outputs, not Orchestrator's internal steps unless they are verbose
                if (resultOfSubTask.status === "COMPLETED" && resultOfSubTask.result_data &&
                    resultOfSubTask.assigned_agent_role !== "Orchestrator") { // Don't summarize Orchestrator's own special actions by default
                    processedData = await this.summarizeDataWithLLM(resultOfSubTask.result_data, userTaskString, resultOfSubTask.narrative_step);
                }

                const contextEntry = {
                    narrative_step: resultOfSubTask.narrative_step || originalSubTaskDef.narrative_step, // Prefer result's if available
                    assigned_agent_role: resultOfSubTask.assigned_agent_role || originalSubTaskDef.assigned_agent_role,
                    tool_name: resultOfSubTask.tool_name || originalSubTaskDef.tool_name,
                    sub_task_input: resultOfSubTask.sub_task_input || originalSubTaskDef.sub_task_input, // Input from original plan
                    status: resultOfSubTask.status,
                    processed_result_data: processedData, // Summarized if applicable
                    raw_result_data: resultOfSubTask.result_data, // Original result from tool/action
                    error_details: resultOfSubTask.error_details,
                    sub_task_id: resultOfSubTask.sub_task_id
                };
                stageContextEntries.push(contextEntry);
            }
            executionContext.push(...stageContextEntries);

            for (const result of stageContextEntries) { // Check based on processed context entries
                if (result.status === "FAILED") {
                    console.error(`Orchestrator: Sub-task ${result.sub_task_id} ("${result.narrative_step}") failed in Stage ${i + 1}. Halting further stages for this parent task.`);
                    overallSuccess = false;
                    break;
                }
            }
            if (!overallSuccess) break;
            console.log(`OrchestratorAgent: Stage ${i + 1} completed successfully.`);
        }

        console.log(`OrchestratorAgent: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);
        let finalOrchestratorResponse = { success: overallSuccess, message: "", originalTask: userTaskString, plan: allExecutedStepsInfo, executedPlan: executionContext, finalAnswer: null };

        if (overallSuccess && executionContext.length > 0) {
            // ... (existing synthesis logic, ensure it uses entry.processed_result_data) ...
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
            // ... (existing saveTaskState logic for EXECUTE_FULL_PLAN) ...
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
            await saveTaskState(taskStateToSave, taskStateFilePath);
        }
        return finalOrchestratorResponse;
    } else {
        console.error(`OrchestratorAgent: Unknown execution mode '${executionMode}'.`);
        return { success: false, message: `Internal Server Error: Unknown execution mode '${executionMode}'.`};
    }
  }
}

module.exports = OrchestratorAgent;
