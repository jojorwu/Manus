const fs = require('fs'); // Required for saveTaskState and path.join (indirectly for capabilities)
const path = require('path'); // Required for path.join
const { saveTaskState } = require('../utils/taskStateUtil');
const { loadTaskState } = require('../utils/taskStateUtil');
// Removed uuidv4 as it's not directly used by OrchestratorAgent anymore
const PlanManager = require('../core/PlanManager');
const PlanExecutor = require('../core/PlanExecutor');

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
        this.workerAgentCapabilities = []; // Ensure it's an empty array on error
    }

    if (this.workerAgentCapabilities && this.workerAgentCapabilities.length > 0) {
        console.log(`OrchestratorAgent initialized with ${this.workerAgentCapabilities.length} worker capabilities loaded.`);
    } else {
        console.log("OrchestratorAgent initialized with NO worker capabilities due to loading error or empty config.");
    }

    this.planManager = new PlanManager(
        this.llmService,
        this.workerAgentCapabilities,
        path.join(__dirname, '..', 'config', 'plan_templates')
    );
    this.planExecutor = new PlanExecutor(
        this.subTaskQueue,
        this.resultsQueue,
        this.llmService,
        { /* No specific tools passed to PlanExecutor constructor for now */ }
    );
  }

  // summarizeDataWithLLM is removed (moved to PlanExecutor)
  // loadPlanTemplates and tryGetPlanFromTemplate are removed (moved to PlanManager)
  // parseSubTaskPlanResponse (global function) is removed (moved to PlanManager)

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

        // Define knownAgentRoles and knownToolsByRole based on this.workerAgentCapabilities
        // These will be passed to planManager.getPlan()
        const knownAgentRoles = this.workerAgentCapabilities.map(agent => agent.role);
        const knownToolsByRole = {};
        this.workerAgentCapabilities.forEach(agent => {
            knownToolsByRole[agent.role] = agent.tools.map(t => t.name);
        });

        const planResult = await this.planManager.getPlan(userTaskString, knownAgentRoles, knownToolsByRole);

        if (!planResult.success) {
            console.error(`OrchestratorAgent (${executionMode}): Failed to obtain a valid plan: ${planResult.message}`);
            // Determine error status based on the source of the error
            const errorStatus = planResult.source === "llm_validation_error"
                ? "FAILED_PLANNING_INVALID_LLM_RESPONSE"
                : (planResult.source === "llm_service_error" ? "FAILED_PLANNING_LLM_ERROR" : "FAILED_PLANNING");

            const errorState = {
                taskId: parentTaskId,
                userTaskString,
                status: errorStatus,
                plan: [],
                executionContext: [],
                finalAnswer: null,
                errorSummary: { reason: planResult.message },
                rawLLMResponse: planResult.rawResponse // Include raw response if available
            };

            const nowError = new Date();
            const monthError = String(nowError.getMonth() + 1).padStart(2, '0');
            const dayError = String(nowError.getDate()).padStart(2, '0');
            const yearError = nowError.getFullYear();
            const dateDirError = `tasks_${monthError}${dayError}${yearError}`;
            const rootDirError = path.join(__dirname, '..'); // Assuming OrchestratorAgent.js is in 'agents' directory
            const saveDirError = path.join(rootDirError, 'saved_tasks', dateDirError);
            const taskStateFilePathError = path.join(saveDirError, `task_state_${parentTaskId}.json`);

            await saveTaskState(errorState, taskStateFilePathError);
            return { success: false, message: planResult.message, taskId: parentTaskId, originalTask: userTaskString, rawResponse: planResult.rawResponse };
        }

        const planStages = planResult.plan;
        console.log(`OrchestratorAgent (${executionMode}): Plan obtained from ${planResult.source}. Parsed plan with ${planStages.length} stage(s).`);


        if (executionMode === "PLAN_ONLY") {
            const taskStateToSave = { taskId: parentTaskId, userTaskString, status: "PLAN_GENERATED", plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null, plan_source: planResult.source, raw_llm_response: planResult.rawResponse };
            // ... (save state logic) ...
            const now = new Date(); const month = String(now.getMonth() + 1).padStart(2, '0'); const day = String(now.getDate()).padStart(2, '0'); const year = now.getFullYear();
            const dateDir = `tasks_${month}${day}${year}`;
            const rootDir = path.join(__dirname, '..');
            const saveDir = path.join(rootDir, 'saved_tasks', dateDir);
            const taskStateFilePath = path.join(saveDir, `task_state_${parentTaskId}.json`);
            await saveTaskState(taskStateToSave, taskStateFilePath);
            return { success: true, message: "Plan generated and saved successfully.", taskId: parentTaskId, originalTask: userTaskString, plan: planStages };
        }

        // --- EXECUTE_FULL_PLAN or EXECUTE_PLANNED_TASK specific logic continues ---
        let executionContext = []; // Define executionContext here
        let overallSuccess = true; // Define overallSuccess here

        if (executionMode === "EXECUTE_FULL_PLAN" || executionMode === "EXECUTE_PLANNED_TASK") {
            // For EXECUTE_PLANNED_TASK, userTaskString might be loaded from state if not provided.
            // Ensure userTaskString is available for PlanExecutor.
            // Also, EXECUTE_PLANNED_TASK needs to load 'loadedState' if it's going to use it.
            let taskStringToExecuteWith = userTaskString;
            let loadedState = null; // Define loadedState for this block if needed

            if (executionMode === "EXECUTE_PLANNED_TASK") {
                if (!taskIdToLoad) {
                    return { success: false, message: "EXECUTE_PLANNED_TASK mode requires a taskIdToLoad.", originalTask: userTaskString, executedPlan: [], finalAnswer: null };
                }
                // Simplified state loading for EXECUTE_PLANNED_TASK, assuming planStages is already loaded if this mode is called
                // A more robust implementation would load the full state here if planStages isn't passed or is empty.
                // For now, we assume planStages is correctly populated by prior logic for EXECUTE_PLANNED_TASK.
                // If userTaskString is not provided with EXECUTE_PLANNED_TASK, it should have been loaded.
                // This part might need refinement based on how EXECUTE_PLANNED_TASK is called.
                 const loadResult = await loadTaskState(path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${taskIdToLoad}.json`)); // simplified path
                 if (loadResult.success && loadResult.taskState) {
                    loadedState = loadResult.taskState;
                    if (!userTaskString && loadedState.userTaskString) {
                        taskStringToExecuteWith = loadedState.userTaskString;
                    }
                    if (planStages.length === 0 && loadedState.plan) { // If planStages were not already set
                        // planStages = loadedState.plan; // This line was commented out, if EXECUTE_PLANNED_TASK implies plan is pre-loaded, it's fine.
                    }
                 } else if (!userTaskString) { // If loading failed and no userTaskString
                    console.error("OrchestratorAgent: userTaskString is missing for EXECUTE_PLANNED_TASK and could not be loaded.");
                    return { success: false, message: "User task string missing for EXECUTE_PLANNED_TASK and could not be loaded.", taskId: parentTaskId, originalTask: null };
                 }
            }
             if (!taskStringToExecuteWith && (executionMode === "EXECUTE_FULL_PLAN" || executionMode === "EXECUTE_PLANNED_TASK")) {
                 // This check is a bit redundant if EXECUTE_FULL_PLAN always has userTaskString from the start.
                 // More critical for EXECUTE_PLANNED_TASK if taskStringToExecuteWith couldn't be determined.
                 console.error("OrchestratorAgent: userTaskString is missing for plan execution.");
                 return { success: false, message: "User task string is critically missing before plan execution.", taskId: parentTaskId, originalTask: userTaskString };
            }


            console.log(`OrchestratorAgent: Executing plan for parentTaskId: ${parentTaskId}`);
            // Ensure taskStringToExecuteWith is valid if userTaskString was initially null (e.g. EXECUTE_PLANNED_TASK)
            const executionResult = await this.planExecutor.executePlan(planStages, parentTaskId, taskStringToExecuteWith || (loadedState ? loadedState.userTaskString : ""));

            overallSuccess = executionResult.success;
            executionContext = executionResult.executionContext;
        }
        // else: PLAN_ONLY mode has already returned. SYNTHESIZE_ONLY does not execute.

        console.log(`OrchestratorAgent: Plan execution finished for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);

        let finalOrchestratorResponse = {
            success: overallSuccess,
            message: "",
            originalTask: userTaskString || (loadedState && loadedState.userTaskString),
            plan: planStages,
            executedPlan: executionContext,
            finalAnswer: null
        };

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
