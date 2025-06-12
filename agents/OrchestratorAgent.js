const { v4: uuidv4 } = require('uuid'); // For generating unique sub_task_ids
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const ajv = new Ajv();
const agentCapabilitiesSchema = require('../schemas/agentCapabilitiesSchema.json');
const planTemplateSchema = require('../schemas/planTemplateSchema.json');
const { saveTaskState } = require('../utils/taskStateUtil');
const { loadTaskState } = require('../utils/taskStateUtil');
const { getTaskStateFilePath } = require('../utils/fileUtils');
const { ExecutionModes, TaskStatuses } = require('../core/constants');
const logger = require('../core/logger');

/**
 * Parses and validates the LLM's response for a sub-task plan.
 * Ensures the response is a valid JSON array of stages, with each stage
 * containing valid sub-task objects conforming to the expected structure.
 * @param {string} jsonStringResponse - The JSON string response from the LLM.
 * @param {string[]} knownAgentRoles - An array of known agent roles for validation.
 * @param {object.<string, string[]>} knownToolsByRole - An object mapping agent roles to their available tools.
 * @returns {Promise<{success: boolean, message?: string, details?: string, rawResponse?: string, stages: Array<Array<object>>}>}
 *          An object indicating success or failure, with messages, raw response snippets, and the parsed stages.
 * @async
 */
async function parseSubTaskPlanResponse(jsonStringResponse, knownAgentRoles, knownToolsByRole) {
    // MAX_RAW_RESPONSE_LENGTH is specific to this function, not the summarization one.
    // It can remain hardcoded or be moved to orchestratorConfig.json if desired for this function as well.
    // For now, leaving it as is, as the request was specific to summarization.
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
        logger.error("Error parsing sub-task plan JSON.", { errorMessage: e.message, rawResponse: trimmedRawResponse, error: e });
        return { success: false, message: "Failed to parse LLM plan: " + e.message, rawResponse: trimmedRawResponse, stages: [] };
    }
}

/**
 * The OrchestratorAgent is responsible for managing the overall execution of user tasks.
 * It handles task planning (either via templates or an LLM), dispatching sub-tasks to worker agents,
 * collecting results, and synthesizing a final answer. It also manages task state persistence.
 */
class OrchestratorAgent {
  /**
   * Constructs an OrchestratorAgent.
   * @param {object} subTaskQueue - The queue for dispatching sub-tasks to worker agents.
   * @param {object} resultsQueue - The queue for receiving results from worker agents.
   * @param {function} llmService - A function that interacts with an LLM for planning and synthesis.
   * @param {object} agentApiKeysConfig - Configuration object containing API keys needed by agents/tools.
   */
  constructor(subTaskQueue, resultsQueue, llmService, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.llmService = llmService;
    this.agentApiKeysConfig = agentApiKeysConfig;
    this.config = {}; // Initialize config object

    // Load Orchestrator Configuration
    const orchestratorConfigPath = path.join(__dirname, '..', 'config', 'orchestratorConfig.json');
    try {
        const configData = fs.readFileSync(orchestratorConfigPath, 'utf8');
        this.config = JSON.parse(configData);
        logger.info("OrchestratorAgent: Orchestrator configuration loaded successfully.", { configPath: orchestratorConfigPath });
    } catch (error) {
        logger.warn(`OrchestratorAgent: Failed to load orchestratorConfig.json from ${orchestratorConfigPath}. Using default values.`, { error: error.message, configPath: orchestratorConfigPath });
        // Define default values if config loading fails
        this.config.maxDataLengthForSummarization = 1000; // Default value
    }

    // Ensure maxDataLengthForSummarization has a value
    if (typeof this.config.maxDataLengthForSummarization !== 'number') {
        logger.warn(`OrchestratorAgent: maxDataLengthForSummarization is not defined or invalid in config. Using default value (1000).`, { currentValue: this.config.maxDataLengthForSummarization });
        this.config.maxDataLengthForSummarization = 1000;
    }


    const capabilitiesPath = path.join(__dirname, '..', 'config', 'agentCapabilities.json');
    this.workerAgentCapabilities = this.loadCapabilities(capabilitiesPath); // This will be an array of agent profiles

    if (this.workerAgentCapabilities && Array.isArray(this.workerAgentCapabilities) && this.workerAgentCapabilities.length > 0) {
        logger.info(`OrchestratorAgent initialized with ${this.workerAgentCapabilities.length} worker agent profiles loaded and validated.`);
    } else {
        logger.warn("OrchestratorAgent initialized with NO worker agent profiles due to loading error, empty config, or validation failure.");
    }

    this.planTemplates = new Map(); // Changed to Map
    this.loadPlanTemplates();
  }

  /**
   * Loads worker agent capabilities from a JSON file.
   * Validates the loaded capabilities against a predefined JSON schema.
   * @param {string} filePath - The path to the agent capabilities JSON file.
   * @returns {object[]} An array of agent capability objects, or an empty array if loading/validation fails.
   */
  loadCapabilities(filePath) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        const capabilitiesArray = JSON.parse(rawData); // Expect an array directly
        const validate = ajv.compile(agentCapabilitiesSchema); // Schema expects an array
        if (!validate(capabilitiesArray)) {
            logger.error(`OrchestratorAgent: Error validating agent capabilities array from ${filePath}: ${ajv.errorsText(validate.errors)}. Using empty capabilities array.`, { filePath, errors: ajv.errorsText(validate.errors) });
            return []; // Fallback to an empty array
        }
        logger.info(`OrchestratorAgent: Worker capabilities array loaded and validated successfully from ${filePath}`, { filePath });
        return capabilitiesArray;
    } catch (error) {
        logger.error(`OrchestratorAgent: Failed to load worker capabilities from ${filePath}. Error: ${error.message}. Using empty capabilities array.`, { filePath, error: error.message, stack: error.stack });
        return []; // Fallback to an empty array
    }
  }

  loadPlanTemplates() {
    const templatesDir = path.join(__dirname, '..', 'config', 'plan_templates');
    this.planTemplates.clear(); // Clear existing templates
    try {
        if (!fs.existsSync(templatesDir)) {
            logger.warn(`OrchestratorAgent: Plan templates directory not found at ${templatesDir}. No templates loaded.`, { templatesDir });
            return;
        }
        // Assuming templateDefinitions is still how you identify which files to load.
        // If you want to load all .json files in the directory, this part needs to change.
        const templateDefinitions = [
            { name: "weather_query", fileName: "weather_query_template.json", regex: /^(?:what is the )?weather (?:in )?(.+)/i, paramMapping: { CITY_NAME: 1 } },
            { name: "calculator", fileName: "calculator_template.json", regex: /^(?:calculate|what is) ([\d\s\+\-\*\/\(\)\.^%]+)/i, paramMapping: { EXPRESSION: 1 } }
        ];

        for (const def of templateDefinitions) {
            const filePath = path.join(templatesDir, def.fileName);
            if (fs.existsSync(filePath)) {
                try {
                    const rawData = fs.readFileSync(filePath, 'utf8');
                    const template = JSON.parse(rawData);
                    const validate = ajv.compile(planTemplateSchema);
                    if (!validate(template)) {
                        logger.warn(`OrchestratorAgent: Plan template from ${def.fileName} failed validation. Skipping this template.`, { templateFile: def.fileName, errors: ajv.errorsText(validate.errors) });
                        continue; // Skip this template
                    }
                    // The schema now requires 'name', 'description', 'steps'.
                    // We are using 'def.name' as the key for the map, and the template itself has its own 'name' field.
                    // Ensure the template's internal name matches def.name or decide which one to use.
                    // For now, let's assume template.name is the source of truth if validated.
                    if (template.name) {
                         this.planTemplates.set(template.name, { regex: def.regex, paramMapping: def.paramMapping, template: template });
                         logger.info(`OrchestratorAgent: Loaded and validated plan template '${template.name}' from ${def.fileName}`, { templateName: template.name, templateFile: def.fileName });
                    } else {
                         // This should be caught by schema validation if "name" is required in planTemplateSchema.json
                         logger.warn(`OrchestratorAgent: Plan template from ${def.fileName} is missing a name after validation. Skipping this template.`, { templateFile: def.fileName });
                    }
                } catch (error) {
                    logger.warn(`OrchestratorAgent: Could not load or parse plan template from ${def.fileName}. Skipping this template.`, { templateFile: def.fileName, error: error.message, stack: error.stack });
                }
            } else {
                logger.warn(`OrchestratorAgent: Plan template file ${def.fileName} not found in ${templatesDir}`, { templateFile: def.fileName, templatesDir });
            }
        }
    } catch (error) {
        // This catch is for errors like readdirSync failing, not individual file errors
        logger.error(`OrchestratorAgent: Error reading plan templates directory ${templatesDir}.`, { templatesDir, error: error.message, stack: error.stack });
        this.planTemplates.clear(); // Ensure templates are empty on directory error
    }
  }

  /**
   * Attempts to find and populate a plan from predefined templates based on the user task string.
   * @param {string} userTaskString - The user's task description.
   * @returns {Promise<object[]|null>} A populated plan (array of stages) if a template matches, otherwise null.
   * @async
   */
  async tryGetPlanFromTemplate(userTaskString) {
    if (!this.planTemplates || this.planTemplates.size === 0) return null; // Changed to check map size
    // Iterate over map values
    for (const templateInfo of this.planTemplates.values()) {
        const match = templateInfo.regex.exec(userTaskString);
        if (match) {
            // Ensure templateInfo.template exists and has a name (it should, due to earlier validation)
            const templateName = templateInfo.template.name || "Unnamed Template";
            logger.info(`OrchestratorAgent: Matched plan template '${templateName}' for task.`, { templateName, userTaskString });
            // The 'template' property now holds the actual plan structure.
            let populatedTemplateString = JSON.stringify(templateInfo.template);
            for (const placeholder in templateInfo.paramMapping) {
                const groupIndex = templateInfo.paramMapping[placeholder];
                const value = match[groupIndex] ? match[groupIndex].trim() : "";
                populatedTemplateString = populatedTemplateString.replace(new RegExp(`{{${placeholder}}}`, 'g'), value);
            }
            try {
                // The populated template string is the plan itself.
                const populatedPlan = JSON.parse(populatedTemplateString);
                // We need to return the plan (which is template.steps), not the full template object
                return populatedPlan.steps;
            } catch (e) {
                logger.error(`OrchestratorAgent: Error parsing populated template '${templateName}'.`, { templateName, error: e.message, stack: e.stack });
                return null;
            }
        }
    }
    return null;
  }

  /**
   * Summarizes data using an LLM if it exceeds a configured maximum length.
   * This is used to keep the context provided to subsequent LLM calls concise.
   * @param {any} dataToSummarize - The data to potentially summarize.
   * @param {string} userTaskString - The original user task string, for context in the summarization prompt.
   * @param {string} narrativeStep - A description of the step that produced the data, for context.
   * @returns {Promise<any>} The summarized data (string) or the original data if not summarized.
   * @async
   */
  async summarizeDataWithLLM(dataToSummarize, userTaskString, narrativeStep) {
    const currentMaxDataLength = this.config.maxDataLengthForSummarization;
    let dataString;
    if (typeof dataToSummarize === 'string') dataString = dataToSummarize;
    else try { dataString = JSON.stringify(dataToSummarize); } catch (e) {
        logger.warn(`OrchestratorAgent.summarizeDataWithLLM: Could not stringify data for step "${narrativeStep}". Using raw data type.`, { narrativeStep, error: e.message, stack: e.stack });
        return dataToSummarize;
    }
    if (dataString.length > currentMaxDataLength) {
        logger.info(`OrchestratorAgent.summarizeDataWithLLM: Data for step "${narrativeStep}" is too long (${dataString.length} chars, max: ${currentMaxDataLength}), attempting summarization.`, { narrativeStep, dataLength: dataString.length, maxLength: currentMaxDataLength });
        const summarizationPrompt = `The original user task was: "${userTaskString}".
A step in the execution plan, described as "${narrativeStep}", produced the following data:
---
${dataString.substring(0, currentMaxDataLength)}... (data truncated for this prompt if originally longer)
---
Please summarize this data concisely, keeping in mind its relevance to the original user task and the step description. The summary should be a string, suitable for inclusion as context for a final answer synthesis. Focus on extracting key information and outcomes. Provide only the summary text.`;
        try {
            const summary = await this.llmService(summarizationPrompt);
            if (typeof summary === 'string' && summary.trim() !== "") {
                logger.info(`OrchestratorAgent.summarizeDataWithLLM: Summarization successful for step "${narrativeStep}".`, { narrativeStep });
                return summary;
            } else {
                logger.warn(`OrchestratorAgent.summarizeDataWithLLM: LLM returned empty or non-string summary for step "${narrativeStep}". Original data (or its beginning) will be used.`, { narrativeStep, summaryReceived: summary });
                return dataString.substring(0, currentMaxDataLength) + (dataString.length > currentMaxDataLength ? "... (original data was too long and summarization failed)" : "");
            }
        } catch (error) {
            logger.error(`OrchestratorAgent.summarizeDataWithLLM: Error during summarization for step "${narrativeStep}".`, { narrativeStep, error: error.message, stack: error.stack });
            return dataString.substring(0, currentMaxDataLength) + (dataString.length > currentMaxDataLength ? "... (original data was too long and summarization failed)" : "");
        }
    }
    return dataToSummarize;
  }

  /**
   * Handles a user task based on the specified execution mode.
   * This is the main entry point for task processing by the OrchestratorAgent.
   * It can operate in different modes:
   * - `ExecutionModes.EXECUTE_FULL_PLAN`: Generates a plan (or uses a template), executes it, and synthesizes a final answer.
   * - `ExecutionModes.PLAN_ONLY`: Generates a plan and saves it without execution.
   * - `ExecutionModes.SYNTHESIZE_ONLY`: Loads a previously executed plan and synthesizes a final answer.
   * @param {string} userTaskString - The user's task description.
   * @param {string} parentTaskId - The ID for this task execution.
   * @param {string} [taskIdToLoad=null] - The ID of a previously saved task state to load (used in `SYNTHESIZE_ONLY` mode).
   * @param {string} [executionMode=ExecutionModes.EXECUTE_FULL_PLAN] - The mode of operation.
   * @returns {Promise<object>} An object containing the outcome of the task handling, including success status, messages, plan, executed steps, and final answer.
   * @async
   */
  async handleUserTask(userTaskString, parentTaskId, taskIdToLoad = null, executionMode = ExecutionModes.EXECUTE_FULL_PLAN) {
    logger.info(`OrchestratorAgent: Received task. Mode: ${executionMode}`, { parentTaskId, taskIdToLoad, executionMode, userTaskString: userTaskString ? userTaskString.substring(0,100)+'...' : 'N/A' });

    if (executionMode === ExecutionModes.SYNTHESIZE_ONLY) {
        if (!taskIdToLoad) {
            logger.warn("OrchestratorAgent: SYNTHESIZE_ONLY mode requires a taskIdToLoad, but it was not provided.", { parentTaskId });
            return { success: false, message: `${ExecutionModes.SYNTHESIZE_ONLY} mode requires a taskIdToLoad.`, originalTask: userTaskString, executedPlan: [], finalAnswer: null };
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
                try { await fs.promises.access(tryPath); stateFilePath = tryPath; break; } catch (fileAccessError) { /* File not in this dateDir, try next */ }
            }
        } catch (baseDirError) { logger.warn(`OrchestratorAgent: Error accessing saved tasks base directory ${savedTasksBaseDir}.`, { error: baseDirError.message, stack: baseDirError.stack }); }

        if (!stateFilePath) {
             logger.warn(`OrchestratorAgent: State file for taskId '${taskIdToLoad}' not found.`, { taskIdToLoad });
             return { success: false, message: `State file for task ID '${taskIdToLoad}' not found. Cannot synthesize.`, originalTask: null, executedPlan: [], finalAnswer: null };
        }
        logger.info(`OrchestratorAgent: Attempting to load state from ${stateFilePath} for ${ExecutionModes.SYNTHESIZE_ONLY} mode.`, { stateFilePath });
        const loadResult = await loadTaskState(stateFilePath);
        if (!loadResult.success || !loadResult.taskState) {
            logger.error(`OrchestratorAgent: Failed to load task state for taskId '${taskIdToLoad}'.`, { taskIdToLoad, message: loadResult.message });
            return { success: false, message: `Failed to load task state for taskId '${taskIdToLoad}': ${loadResult.message}`, originalTask: null, executedPlan: [], finalAnswer: null };
        }
        loadedState = loadResult.taskState;
        const originalUserTaskString = loadedState.userTaskString;
        if (!loadedState.executionContext || loadedState.executionContext.length === 0) {
             logger.warn(`OrchestratorAgent: No execution context found for taskId '${taskIdToLoad}'. Cannot synthesize.`, { taskIdToLoad });
            return { success: false, message: `No execution context found for taskId '${taskIdToLoad}'. Cannot synthesize.`, originalTask: originalUserTaskString, executedPlan: loadedState.executionContext, finalAnswer: null };
        }
        const executionContextForSynthesis = loadedState.executionContext.map(entry => ({ ...entry, outcome_data: entry.processed_result_data !== undefined ? entry.processed_result_data : entry.result_data }));
        const contextForLLMSynthesis = executionContextForSynthesis.map(entry => ({ step_narrative: entry.narrative_step, tool_used: entry.tool_name, input_details: entry.sub_task_input, status: entry.status, outcome_data: entry.outcome_data, error_info: entry.error_details }));

        logger.debug("OrchestratorAgent: Context for LLM Synthesis:", { contextForLLMSynthesis });
        let finalAnswer = null; let synthesisMessage = "";

        if (contextForLLMSynthesis.every(e => e.status === TaskStatuses.FAILED || (e.status === TaskStatuses.COMPLETED && (e.outcome_data === null || e.outcome_data === undefined)))) {
            logger.info(`OrchestratorAgent (${ExecutionModes.SYNTHESIZE_ONLY}): No successful results with actionable data to synthesize.`, { taskIdToLoad });
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
                logger.info(`OrchestratorAgent (${ExecutionModes.SYNTHESIZE_ONLY}): Final answer synthesized successfully.`, { taskIdToLoad });
            } catch (synthError) {
                logger.error(`OrchestratorAgent (${ExecutionModes.SYNTHESIZE_ONLY}): Error during final answer synthesis.`, { taskIdToLoad, error: synthError.message, stack: synthError.stack });
                finalAnswer = "Error during final answer synthesis from loaded state: " + synthError.message;
                synthesisMessage = "Error during synthesis from loaded state.";
            }
        }
        return { success: true, message: synthesisMessage, originalTask: originalUserTaskString, plan: loadedState.plan, executedPlan: executionContextForSynthesis, finalAnswer: finalAnswer };

    } else if (executionMode === ExecutionModes.PLAN_ONLY || executionMode === ExecutionModes.EXECUTE_FULL_PLAN) {
        if (!userTaskString) {
            logger.warn(`OrchestratorAgent: Task string is required for ${executionMode} mode, but was not provided.`, { executionMode, parentTaskId });
            return { success: false, message: `Task string is required for ${executionMode} mode.`, originalTask: null, taskId: parentTaskId };
        }
        logger.info(`OrchestratorAgent (${executionMode}): Processing task: "${userTaskString}"`, { executionMode, parentTaskId });

        let parsedPlanResult = null;
        const templatePlan = await this.tryGetPlanFromTemplate(userTaskString);

        const knownAgentRoles = []; // Define here to be in scope for LLM planning if needed
        const knownToolsByRole = {}; // Define here for the same reason

        if (templatePlan) {
            logger.info("OrchestratorAgent: Using plan from template.", { parentTaskId });
            // Validate template plan structure (basic validation, more can be added if needed)
            if (Array.isArray(templatePlan) && templatePlan.every(stage => Array.isArray(stage))) {
                 // Here, we assume the template is validly structured regarding sub-task fields.
                parsedPlanResult = { success: true, stages: templatePlan };
            } else {
                logger.error("OrchestratorAgent: Template plan is not in the expected format (array of stages). Falling back to LLM.", { parentTaskId, templatePlan });
                // parsedPlanResult will remain null, forcing LLM planning
            }
        }

        if (!parsedPlanResult) { // If no template plan or template was invalid
            logger.info("OrchestratorAgent: No valid matching template found or template was invalid, proceeding with LLM-based planning.", { parentTaskId });

            let formattedAgentCapabilitiesString = "You have the following specialized agents available:\n";
            // `this.workerAgentCapabilities` is an array of agent profiles.
            // The previous check `!this.workerAgentCapabilities.tools` was based on an old structure.
            // The correct check is for the array itself and its length.
            if (!this.workerAgentCapabilities || !Array.isArray(this.workerAgentCapabilities) || this.workerAgentCapabilities.length === 0) {
                logger.error(`OrchestratorAgent (${executionMode}): No worker agent profiles defined in capabilities. Cannot proceed with LLM planning.`, { executionMode, parentTaskId });
                return { success: false, message: `Internal Server Error: No worker agent profiles configured for ${executionMode} mode.`, originalTask: userTaskString, taskId: parentTaskId };
            }

            this.workerAgentCapabilities.forEach(agent => {
                knownAgentRoles.push(agent.role);
                knownToolsByRole[agent.role] = agent.tools.map(t => t.name);
                formattedAgentCapabilitiesString += "---\n";
                formattedAgentCapabilitiesString += `Agent Role: ${agent.role}\n`;
                // Assuming 'description' field for the role, and 'tools' array with 'name' and 'description'
                formattedAgentCapabilitiesString += `Description: ${agent.description || 'No description'}\n`;
                formattedAgentCapabilitiesString += `Tools:\n`;
                if (agent.tools && agent.tools.length > 0) {
                    agent.tools.forEach(tool => {
                        formattedAgentCapabilitiesString += `  - ${tool.name}: ${tool.description}\n`;
                    });
                } else {
                    formattedAgentCapabilitiesString += `  (No tools listed for this agent role)\n`;
                }
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
                logger.error(`OrchestratorAgent (${executionMode}): Error from LLM service during planning.`, { executionMode, parentTaskId, error: llmError.message, stack: llmError.stack });
                const errorStateLlm = { taskId: parentTaskId, userTaskString, status: TaskStatuses.FAILED_PLANNING, plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: `LLM service error: ${llmError.message}` }};
                const llmErrorFilePath = getTaskStateFilePath(parentTaskId, path.join(__dirname, '..'));
                await saveTaskState(errorStateLlm, llmErrorFilePath);
                return { success: false, message: `Failed to generate plan: ${llmError.message}`, taskId: parentTaskId, originalTask: userTaskString };
            }
            parsedPlanResult = await parseSubTaskPlanResponse(planJsonString, knownAgentRoles, knownToolsByRole);
        }

        if (!parsedPlanResult || !parsedPlanResult.success) {
            const TPSR_Error_Message = parsedPlanResult ? parsedPlanResult.message : "Plan generation or template processing failed before parsing.";
            const TPSR_Raw_Response = parsedPlanResult ? parsedPlanResult.rawResponse : null; // Can be large, log with caution or truncate
            logger.error(`OrchestratorAgent (${executionMode}): Failed to obtain a valid plan.`, { executionMode, parentTaskId, errorMessage: TPSR_Error_Message, rawResponseSnippet: TPSR_Raw_Response ? TPSR_Raw_Response.substring(0, 200) : null });
            const errorStatePlan = { taskId: parentTaskId, userTaskString, status: TaskStatuses.FAILED_PLANNING, plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: TPSR_Error_Message }, rawLLMResponse: TPSR_Raw_Response };
            const planErrorFilePath = getTaskStateFilePath(parentTaskId, path.join(__dirname, '..'));
            await saveTaskState(errorStatePlan, planErrorFilePath);
            return { success: false, message: TPSR_Error_Message, taskId: parentTaskId, originalTask: userTaskString, rawResponse: TPSR_Raw_Response };
        }

    const planStages = parsedPlanResult.stages; // This should be the array of stages, e.g., [ [subtask1], [subtask2] ]
        logger.info(`OrchestratorAgent (${executionMode}): Parsed plan with ${planStages.length} stage(s).`, { executionMode, parentTaskId, stageCount: planStages.length });
        logger.debug(`OrchestratorAgent (${executionMode}): Full parsed plan:`, { executionMode, parentTaskId, planStages });


        if (executionMode === ExecutionModes.PLAN_ONLY) {
            const taskStateToSave = { taskId: parentTaskId, userTaskString, status: TaskStatuses.PLAN_GENERATED, plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null };
            const planOnlyFilePath = getTaskStateFilePath(parentTaskId, path.join(__dirname, '..'));
            await saveTaskState(taskStateToSave, planOnlyFilePath);
            logger.info(`OrchestratorAgent (${ExecutionModes.PLAN_ONLY}): Plan generated and saved successfully.`, { parentTaskId, filePath: planOnlyFilePath });
            return { success: true, message: "Plan generated and saved successfully.", taskId: parentTaskId, originalTask: userTaskString, plan: planStages };
        }

        // --- EXECUTE_FULL_PLAN specific logic continues ---
        const allExecutedStepsInfo = [];
        const executionContext = [];
        let overallSuccess = true;

        for (let i = 0; i < planStages.length; i++) {
            const currentStageTaskDefinitions = planStages[i];
            logger.info(`OrchestratorAgent: Starting Stage ${i + 1}/${planStages.length} with ${currentStageTaskDefinitions.length} sub-task(s).`, { parentTaskId, stage: i + 1, totalStages: planStages.length, subTaskCount: currentStageTaskDefinitions.length });

            const stageSubTaskPromises = [];
            for (const subTaskDefinition of currentStageTaskDefinitions) {
                allExecutedStepsInfo.push({ narrative_step: subTaskDefinition.narrative_step, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input });
                const sub_task_id = uuidv4();
                const taskMessage = { sub_task_id, parent_task_id: parentTaskId, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, narrative_step: subTaskDefinition.narrative_step };

                logger.debug('OrchestratorAgent: Dispatching taskMessage:', { parentTaskId, taskMessage });
                this.subTaskQueue.enqueueTask(taskMessage);
                logger.info(`Orchestrator: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${taskMessage.narrative_step}" for Stage ${i + 1}`, { parentTaskId, subTaskId: sub_task_id, agentRole: taskMessage.assigned_agent_role, narrativeStep: taskMessage.narrative_step, stage: i + 1 });

                const subTaskPromise = new Promise((resolve) => {
                    this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
                        if (error) {
                            logger.error(`Orchestrator: Error or timeout waiting for result of sub_task_id ${sub_task_id} (Stage ${i+1})`, { parentTaskId, subTaskId: sub_task_id, stage: i+1, error: error.message, stack: error.stack });
                            resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: TaskStatuses.FAILED, error_details: { message: error.message } });
                        } else if (resultMsg) {
                            if (resultMsg.sub_task_id === sub_task_id) {
                                logger.info(`Orchestrator: Received result for sub_task_id ${sub_task_id} (Stage ${i+1}). Status: ${resultMsg.status}`, { parentTaskId, subTaskId: sub_task_id, stage: i+1, status: resultMsg.status });
                                resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details });
                            } else {
                                const errorMessage = `Orchestrator: Critical - Received mismatched sub_task_id. Expected ${sub_task_id}, but got ${resultMsg.sub_task_id} for parent_task_id ${parentTaskId} (Stage ${i+1}). This indicates an issue with result routing or subscription logic.`;
                                logger.error(errorMessage, { parentTaskId, expectedSubTaskId: sub_task_id, receivedSubTaskId: resultMsg.sub_task_id, stage: i+1 });
                                resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: TaskStatuses.FAILED, error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage } });
                            }
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
                if (resultOfSubTask.status === TaskStatuses.COMPLETED && resultOfSubTask.result_data) {
                    processedData = await this.summarizeDataWithLLM(resultOfSubTask.result_data, userTaskString, subTaskDefinition.narrative_step);
                }
                const contextEntry = { narrative_step: subTaskDefinition.narrative_step, assigned_agent_role: subTaskDefinition.assigned_agent_role, tool_name: subTaskDefinition.tool_name, sub_task_input: subTaskDefinition.sub_task_input, status: resultOfSubTask.status, processed_result_data: processedData, raw_result_data: resultOfSubTask.result_data, error_details: resultOfSubTask.error_details, sub_task_id: resultOfSubTask.sub_task_id };
                stageContextEntries.push(contextEntry);
            }
            executionContext.push(...stageContextEntries);
            for (const result of stageResults) {
                if (result.status === TaskStatuses.FAILED) {
                    logger.error(`Orchestrator: Sub-task ${result.sub_task_id} ("${result.narrative_step}") failed in Stage ${i + 1}. Halting further stages for this parent task.`, { parentTaskId, subTaskId: result.sub_task_id, narrativeStep: result.narrative_step, stage: i + 1, errorDetails: result.error_details });
                    overallSuccess = false;
                    break;
                }
            }
            if (!overallSuccess) break;
            logger.info(`OrchestratorAgent: Stage ${i + 1} completed successfully.`, { parentTaskId, stage: i + 1 });
        }

        logger.info(`OrchestratorAgent: Finished processing all stages for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`, { parentTaskId, overallSuccess });
        let finalOrchestratorResponse = { success: overallSuccess, message: "", originalTask: userTaskString, plan: allExecutedStepsInfo, executedPlan: executionContext, finalAnswer: null };

        if (overallSuccess && executionContext.length > 0) {
            const contextForLLMSynthesis = executionContext.map(entry => ({ step_narrative: entry.narrative_step, tool_used: entry.tool_name, input_details: entry.sub_task_input, status: entry.status, outcome_data: entry.processed_result_data, error_info: entry.error_details }));
            // Log with caution if contextForLLMSynthesis can be very large
            logger.debug("OrchestratorAgent: Context for final LLM synthesis:", { parentTaskId, contextForLLMSynthesis });

            if (contextForLLMSynthesis.every(e => e.status === TaskStatuses.FAILED || (e.status === TaskStatuses.COMPLETED && (e.outcome_data === null || e.outcome_data === undefined)))) {
                logger.info("OrchestratorAgent: No successful results with actionable data to synthesize. Skipping synthesis.", { parentTaskId });
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

        if (executionMode === ExecutionModes.EXECUTE_FULL_PLAN) {
            const finalStatus = finalOrchestratorResponse.success ? TaskStatuses.COMPLETED : (finalOrchestratorResponse.message.toLowerCase().includes("plan") ? TaskStatuses.FAILED_PLANNING : TaskStatuses.FAILED_EXECUTION);
            const taskStateToSave = { taskId: parentTaskId, userTaskString, createdAt: null, updatedAt: null, status: finalStatus, currentStageIndex: null, plan: finalOrchestratorResponse.plan, executionContext: finalOrchestratorResponse.executedPlan, finalAnswer: finalOrchestratorResponse.finalAnswer, errorSummary: null };
            if (!finalOrchestratorResponse.success) {
                taskStateToSave.errorSummary = { failedAtStage: null, reason: finalOrchestratorResponse.message };
                if (taskStateToSave.status === TaskStatuses.FAILED_EXECUTION && finalOrchestratorResponse.executedPlan && finalOrchestratorResponse.executedPlan.length > 0) {
                    const lastStep = finalOrchestratorResponse.executedPlan[finalOrchestratorResponse.executedPlan.length - 1];
                    if (lastStep && lastStep.error_details) taskStateToSave.errorSummary.reason = `Last failed step: ${lastStep.narrative_step}. Error: ${lastStep.error_details.message}`;
                }
            }
            const fullPlanFilePath = getTaskStateFilePath(parentTaskId, path.join(__dirname, '..'));
            await saveTaskState(taskStateToSave, fullPlanFilePath);
        }
        return finalOrchestratorResponse;
    } else {
        console.error(`OrchestratorAgent: Unknown execution mode '${executionMode}'.`);
        return { success: false, message: `Internal Server Error: Unknown execution mode '${executionMode}'.`};
    }
  }
}

module.exports = OrchestratorAgent;
