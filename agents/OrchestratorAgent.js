const fs = require('fs'); // Keep for existing sync operations if any
const fsp = require('fs').promises; // Added for async file operations
const path = require('path');
const { saveTaskState, loadTaskState, saveTaskJournal } = require('../utils/taskStateUtil');
const PlanManager = require('../core/PlanManager');
const PlanExecutor = require('../core/PlanExecutor');
const MemoryManager = require('../core/MemoryManager'); // Add this

// uuidv4 is not directly used by OrchestratorAgent after refactoring.
// It's used by PlanExecutor for sub-task IDs it generates.

class OrchestratorAgent {
  constructor(subTaskQueue, resultsQueue, aiService, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.aiService = aiService; // Changed from llmService
    this.agentApiKeysConfig = agentApiKeysConfig;
    this.memoryManager = new MemoryManager(); // Initialize MemoryManager

    const capabilitiesPath = path.join(__dirname, '..', 'config', 'agentCapabilities.json');
    try {
        const capabilitiesFileContent = fs.readFileSync(capabilitiesPath, 'utf8');
        this.workerAgentCapabilities = JSON.parse(capabilitiesFileContent);
        console.log("OrchestratorAgent: Worker capabilities loaded successfully.");
    } catch (error) {
        console.error(`OrchestratorAgent: Failed to load worker capabilities. Error: ${error.message}`);
        this.workerAgentCapabilities = [];
    }

    this.planManager = new PlanManager(
        this.aiService, // Changed from llmService
        this.workerAgentCapabilities,
        path.join(__dirname, '..', 'config', 'plan_templates')
    );
    this.planExecutor = new PlanExecutor(
        this.subTaskQueue,
        this.resultsQueue,
        this.aiService, // Changed from llmService
            { /* Tools can be passed here if PlanExecutor needs them directly */ },
            path.join(__dirname, '..', 'saved_tasks') // Pass baseSavedTasksPath
    );
  }

  _createOrchestratorJournalEntry(type, message, details = {}) {
    return {
        timestamp: new Date().toISOString(),
        type,
        source: "OrchestratorAgent",
        message,
        details
    };
  }

  async _getSummarizedKeyFindingsForPrompt(keyFindingsArray, parentTaskIdForJournal, finalJournalEntriesInput) { // Renamed finalJournalEntries to avoid conflict
    const MAX_KEY_FINDINGS_FOR_PROMPT = 5;
    const MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT = 4000;
    const findingsSummarizationPromptTemplate = `The following text is a collection of key findings obtained while working on a task. Each finding might be a piece of data, an observation, or a result from a tool. Please synthesize these findings into a brief, coherent summary that captures the most important information relevant to the overall task progress. Focus on actionable insights or critical data points.\n\nCollection of Key Findings:\n---\n{text_to_summarize}\n---\nBrief Synthesized Summary:`;

    if (!keyFindingsArray || keyFindingsArray.length === 0) {
        return "No key findings.";
    }

    let findingsTextForPrompt = "";
    let currentLength = 0;
    let findingsToIncludeDirectly = [];

    const reversedFindings = [...keyFindingsArray].reverse();
    for (let i = 0; i < reversedFindings.length && findingsToIncludeDirectly.length < MAX_KEY_FINDINGS_FOR_PROMPT; i++) {
        const finding = reversedFindings[i];
        const findingDataStr = typeof finding.data === 'string' ? finding.data : JSON.stringify(finding.data);
        const findingRepresentation = `Finding (Tool: ${finding.sourceToolName}, Step: "${finding.sourceStepNarrative}"): ${findingDataStr}\n`;
        if (currentLength + findingRepresentation.length > MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT && findingsToIncludeDirectly.length > 0) {
            break;
        }
        findingsToIncludeDirectly.unshift(finding);
        currentLength += findingRepresentation.length;
    }

    if (findingsToIncludeDirectly.length === keyFindingsArray.length ||
        (findingsToIncludeDirectly.length >= MAX_KEY_FINDINGS_FOR_PROMPT && currentLength <= MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT) ||
         keyFindingsArray.length <= MAX_KEY_FINDINGS_FOR_PROMPT ) {

        if (findingsToIncludeDirectly.length < keyFindingsArray.length && keyFindingsArray.length > MAX_KEY_FINDINGS_FOR_PROMPT) {
             findingsTextForPrompt = `Summary of earlier findings is omitted. Recent ${findingsToIncludeDirectly.length} findings are:\n`;
        } else if (keyFindingsArray.length === 0) {
             findingsTextForPrompt = "No key findings recorded yet.\n";
        } else {
             findingsTextForPrompt = "Key findings:\n";
        }
        findingsToIncludeDirectly.forEach(f => {
            const findingDataStr = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
            findingsTextForPrompt += `Tool: ${f.sourceToolName}, Step: "${f.sourceStepNarrative}"\nData: ${findingDataStr.substring(0, 500) + (findingDataStr.length > 500 ? '...' : '')}\n---\n`;
        });
        return findingsTextForPrompt.trim();
    }

    let allFindingsText = "Key findings to summarize:\n";
    keyFindingsArray.forEach(f => {
         const findingDataStr = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
         allFindingsText += `Tool: ${f.sourceToolName}, Step: "${f.sourceStepNarrative}"\nData: ${findingDataStr}\n---\n`;
    });

    // Caller (handleUserTask) will be responsible for logging summarization start/success/failure
    try {
        const summary = await this.aiService.generateText(
            findingsSummarizationPromptTemplate.replace('{text_to_summarize}', allFindingsText),
            {
                model: (this.aiService.baseConfig && this.aiService.baseConfig.summarizationModel) || (this.aiService.getServiceName() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-pro'),
                temperature: 0.3,
                maxTokens: 500
            }
        );
        return `Summary of Key Findings:\n${summary}`;
    } catch (e) {
        // console.error("OrchestratorAgent: Failed to summarize key findings for prompt:", e.message); // For future t()
        return "Key findings were too extensive to include directly, and summarization failed. Refer to detailed execution context if needed.";
    }
  }

  async handleUserTask(userTaskString, parentTaskId, taskIdToLoad = null, executionMode = "EXECUTE_FULL_PLAN") {
    const MAX_ERRORS_FOR_CWC_PROMPT = 3;

    const initialJournalEntries = []; // Orchestrator-specific entries before execution
    initialJournalEntries.push(this._createOrchestratorJournalEntry(
        "TASK_RECEIVED",
        `Task received. Mode: ${executionMode}`,
        { parentTaskId, userTaskStringPreview: userTaskString ? userTaskString.substring(0, 200) + '...' : 'N/A', taskIdToLoad, executionMode }
    ));
    console.log(`OrchestratorAgent: Received task: '${userTaskString ? userTaskString.substring(0,100)+'...' : 'N/A'}', parentTaskId: ${parentTaskId}, taskIdToLoad: ${taskIdToLoad}, mode: ${executionMode}`);

    let currentWorkingContext = {
        lastUpdatedAt: new Date().toISOString(),
        summaryOfProgress: "Task processing initiated.",
        keyFindings: [],
        identifiedEntities: {},
        pendingQuestions: [],
        nextObjective: "Define execution plan or synthesize based on mode.",
        confidenceScore: 0.7,
        errorsEncountered: []
    };
    initialJournalEntries.push(this._createOrchestratorJournalEntry("CWC_INITIALIZED", "CurrentWorkingContext initialized.", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));

    let finalJournalEntries = [...initialJournalEntries];
    let executionResult = { success: false, executionContext: [], journalEntries: [], updatesForWorkingContext: { keyFindings: [], errorsEncountered: [] } };
    let planStages = [];
    let loadedState = null;
    let currentOriginalTask = userTaskString;
    let planResult = null; // To store result from planManager

    // Path setup for this task
    const baseSavedTasksPath = path.join(__dirname, '..', 'saved_tasks');
    const date = new Date();
    const dateString = `${(date.getMonth() + 1).toString().padStart(2, '0')}${(date.getDate()).toString().padStart(2, '0')}${date.getFullYear()}`;
    const datedTasksDirPath = path.join(baseSavedTasksPath, `tasks_${dateString}`);
    const taskDirPath = path.join(datedTasksDirPath, parentTaskId); // Directory for this specific task

    const stateFilePath = path.join(taskDirPath, `task_state.json`);
    const journalFilePath = path.join(taskDirPath, `journal.json`);

    try {
        await fsp.mkdir(taskDirPath, { recursive: true });
        await this.memoryManager.initializeTaskMemory(taskDirPath);

        const initialTaskDefinitionContent = userTaskString || (taskIdToLoad ? "Task definition will be loaded." : "No initial task string provided.");
        await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', initialTaskDefinitionContent);
        await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

        if (executionMode === "SYNTHESIZE_ONLY") {
            finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIS_STARTED", "Starting task synthesis from loaded state.", { parentTaskId, taskIdToLoad }));
            if (!taskIdToLoad) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("LOAD_STATE_ERROR", "taskIdToLoad is required for SYNTHESIZE_ONLY mode.", { parentTaskId }));
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: "taskIdToLoad is required for SYNTHESIZE_ONLY mode." };
             }
            const loadTaskDirPath = path.join(datedTasksDirPath, taskIdToLoad);
            const loadStateFilePath = path.join(loadTaskDirPath, 'task_state.json');
            const loadResult = await loadTaskState(loadStateFilePath);
            if (!loadResult.success || !loadResult.taskState) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("LOAD_STATE_ERROR", `Failed to load state for SYNTHESIZE_ONLY from ${loadStateFilePath}.`, { parentTaskId }));
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: "Failed to load state for SYNTHESIZE_ONLY."};
            }
            loadedState = loadResult.taskState;
            currentOriginalTask = loadedState.userTaskString;
            await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', currentOriginalTask); // Update with loaded task def
            if (loadedState.currentWorkingContext) {
                currentWorkingContext = loadedState.currentWorkingContext;
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                currentWorkingContext.summaryOfProgress = "Resuming task for synthesis from loaded state.";
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "CWC loaded from state.", { parentTaskId }));
                await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
            }
            const synthesisPrompt = `Original task: "${currentOriginalTask}". Execution context: ${JSON.stringify(loadedState.executionContext)}. Current Working Context: ${JSON.stringify(currentWorkingContext)}. Synthesize the final answer.`;
            const finalAnswer = await this.aiService.generateText(synthesisPrompt, { model: (this.aiService.baseConfig && this.aiService.baseConfig.synthesisModel) || 'gpt-4' });
            finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_COMPLETED", "Synthesis complete.", { parentTaskId }));
            await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
            return { success: true, finalAnswer, originalTask: currentOriginalTask, executedPlan: loadedState.executionContext, plan: loadedState.plan, currentWorkingContext };
        }

        // Handling for PLAN_ONLY, EXECUTE_FULL_PLAN, EXECUTE_PLANNED_TASK
        if (executionMode === "EXECUTE_PLANNED_TASK") {
            if (!taskIdToLoad) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("LOAD_STATE_ERROR", "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode.", { parentTaskId }));
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode." };
            }
            const loadTaskDirPath = path.join(datedTasksDirPath, taskIdToLoad);
            const loadStateFilePath = path.join(loadTaskDirPath, 'task_state.json');
            const loadResult = await loadTaskState(loadStateFilePath);
            if (!loadResult.success || !loadResult.taskState) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("LOAD_STATE_ERROR", `Failed to load state for EXECUTE_PLANNED_TASK from ${loadStateFilePath}.`, { parentTaskId }));
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: "Failed to load state for EXECUTE_PLANNED_TASK."};
            }
            loadedState = loadResult.taskState;
            currentOriginalTask = userTaskString || loadedState.userTaskString;
            await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', currentOriginalTask); // Update with loaded task def
            planStages = loadedState.plan || [];
            if (loadedState.currentWorkingContext) {
                currentWorkingContext = loadedState.currentWorkingContext;
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                currentWorkingContext.summaryOfProgress = "Resuming task for execution from loaded plan.";
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "CWC loaded from state for planned execution.", { parentTaskId }));
                await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
            }
            if (!planStages || planStages.length === 0) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_ERROR", "No plan found in loaded state to execute.", { parentTaskId }));
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: "No plan found in loaded state to execute for EXECUTE_PLANNED_TASK."};
             }
        }

        if (executionMode === "EXECUTE_FULL_PLAN" || (executionMode === "PLAN_ONLY" )) { // Removed !templatePlan, assuming PlanManager handles templates
             finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan.", { parentTaskId, executionMode }));
            const knownAgentRoles = (this.workerAgentCapabilities || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (this.workerAgentCapabilities || []).forEach(agent => { knownToolsByRole[agent.role] = agent.tools.map(t => t.name); });

            let memoryContextForPlanning = {};
            try {
                const taskDefFromMemory = await this.memoryManager.loadMemory(taskDirPath, 'task_definition.md', { defaultValue: currentOriginalTask });
                memoryContextForPlanning.taskDefinition = taskDefFromMemory;

                const decisionsPromptTemplate = `The following text contains a log of key decisions, learnings, and events related to solving a complex task. Please provide a concise summary, highlighting:\n- The most impactful decisions made.\n- Key problems encountered and how they were (or were not) resolved.\n- Significant learnings or insights gained.\nThe summary should help in quickly understanding the critical junctures and takeaways from this log.\n\nLog content:\n---\n{text_to_summarize}\n---\nConcise Summary:`;
                const summarizationLlmParams = {
                    model: (this.aiService.baseConfig && this.aiService.baseConfig.summarizationModel) || (this.aiService.getServiceName() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-pro'),
                    temperature: 0.3,
                    maxTokens: 500
                };
                const decisionsFromMemory = await this.memoryManager.getSummarizedMemory(
                    taskDirPath,
                    'key_decisions_and_learnings.md',
                    this.aiService,
                    {
                        maxOriginalLength: 3000,
                        promptTemplate: decisionsPromptTemplate,
                        llmParams: summarizationLlmParams,
                        cacheSummary: true,
                        defaultValue: ""
                    }
                );
                if (decisionsFromMemory && decisionsFromMemory.trim() !== "") {
                    memoryContextForPlanning.retrievedKeyDecisions = decisionsFromMemory;
                }

                if (executionMode !== "EXECUTE_FULL_PLAN" || taskIdToLoad) {
                    const cwcSnapshotFromMemory = await this.memoryManager.loadMemory(taskDirPath, 'current_working_context.json', { isJson: true, defaultValue: null });
                    if (cwcSnapshotFromMemory) memoryContextForPlanning.retrievedCwcSnapshot = cwcSnapshotFromMemory;
                }
            } catch (memError) {
                console.warn(`OrchestratorAgent: Error loading memory for planning for task ${parentTaskId}: ${memError.message}`);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_LOAD_ERROR", `Failed to load memory for planning: ${memError.message}`, { parentTaskId }));
            }

            planResult = await this.planManager.getPlan(currentOriginalTask, knownAgentRoles, knownToolsByRole, memoryContextForPlanning, currentWorkingContext);

            if (!planResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", `Planning failed: ${planResult.message}`, { parentTaskId, error: planResult.message }));
                currentWorkingContext.summaryOfProgress = `Planning failed: ${planResult.message}`;
                currentWorkingContext.errorsEncountered.push({ errorId: `err-plan-${parentTaskId}`, sourceStepNarrative: "Planning", sourceToolName: "PlanManager", errorMessage: planResult.message, timestamp: new Date().toISOString()});
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                const errorState = { taskId: parentTaskId, userTaskString: currentOriginalTask, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: planResult.message }, rawLLMResponse: planResult.rawResponse, currentWorkingContext };
                await saveTaskState(stateFilePath, errorState); // Use new path
                await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
                return { success: false, message: planResult.message, taskId: parentTaskId, originalTask: currentOriginalTask, rawResponse: planResult.rawResponse };
            }
            planStages = planResult.plan;
            finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", `Plan successfully obtained from ${planResult.source}. Stages: ${planStages.length}`, { parentTaskId, source: planResult.source }));
            currentWorkingContext.summaryOfProgress = `Planning completed. Plan has ${planStages.length} stages.`;
            currentWorkingContext.nextObjective = "Execute plan.";
            currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED", "CWC updated after planning.", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));
            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
        }

        if (executionMode === "PLAN_ONLY") {
            currentWorkingContext.summaryOfProgress = `Plan generated successfully from ${planResult.source}. Task complete (PLAN_ONLY).`;
            currentWorkingContext.nextObjective = "Plan available for review or execution.";
            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
            const taskStateToSave = { taskId: parentTaskId, userTaskString: currentOriginalTask, status: "PLAN_GENERATED", plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null, plan_source: planResult.source, raw_llm_response: planResult.rawResponse, currentWorkingContext };
            await saveTaskState(stateFilePath, taskStateToSave); // Use new path
            finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_COMPLETED_SUCCESSFULLY", "PLAN_ONLY task completed.", { parentTaskId }));
            await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path
            return { success: true, message: "Plan generated and saved.", taskId: parentTaskId, originalTask: currentOriginalTask, plan: planStages, currentWorkingContext };
        }

        let overallSuccess = false;
        let executionContext = [];
        // executionResult is already initialized earlier

        if (executionMode === "EXECUTE_FULL_PLAN" || executionMode === "EXECUTE_PLANNED_TASK") {
            finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_CYCLE_STARTED", "Starting plan execution/replanning cycle.", { parentTaskId }));

            let revisionAttempts = 0;
            const MAX_REVISIONS = 2; // Max 2 replanning attempts (total 3 execution attempts)
            let planForNextAttempt = planStages;
            let overallTaskSuccessFlag = false;
            let lastExecutionContext = [];
            let lastExecutionResult = executionResult; // Use the initially defined executionResult

            const knownAgentRoles = (this.workerAgentCapabilities || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (this.workerAgentCapabilities || []).forEach(agent => { knownToolsByRole[agent.role] = agent.tools.map(t => t.name); });

            for (let currentAttempt = 0; currentAttempt <= MAX_REVISIONS; currentAttempt++) {
                const attemptType = currentAttempt === 0 ? "EXECUTION_ATTEMPT_START" : "REPLANNING_EXECUTION_ATTEMPT_START";
                const attemptMessage = currentAttempt === 0 ?
                    `Starting initial execution attempt for plan. Attempt ${currentAttempt + 1}/${MAX_REVISIONS + 1}` :
                    `Starting replanned execution attempt. Attempt ${currentAttempt + 1}/${MAX_REVISIONS + 1}`;

                finalJournalEntries.push(this._createOrchestratorJournalEntry(attemptType, attemptMessage, { parentTaskId, attemptNumber: currentAttempt + 1, totalAttemptsAllowed: MAX_REVISIONS + 1 }));

                currentWorkingContext.summaryOfProgress = `${attemptMessage}. Current objective: ${currentWorkingContext.nextObjective || 'Execute plan and achieve task.'}`;
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED_PRE_ATTEMPT", currentWorkingContext.summaryOfProgress, { parentTaskId }));
                await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

                let currentExecutionResult = await this.planExecutor.executePlan(planForNextAttempt, parentTaskId, currentOriginalTask);

                if (currentExecutionResult.journalEntries && currentExecutionResult.journalEntries.length > 0) {
                    finalJournalEntries = finalJournalEntries.concat(currentExecutionResult.journalEntries);
                }

                // Update CWC with findings and errors from this attempt
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                if (currentExecutionResult.updatesForWorkingContext) {
                    currentWorkingContext.keyFindings.push(...(currentExecutionResult.updatesForWorkingContext.keyFindings || []));
                    currentWorkingContext.errorsEncountered.push(...(currentExecutionResult.updatesForWorkingContext.errorsEncountered || []));
                }
                // Always store the latest execution context and result
                lastExecutionContext = currentExecutionResult.executionContext || [];
                lastExecutionResult = currentExecutionResult;

                if (currentExecutionResult.success) {
                    overallTaskSuccessFlag = true;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_ATTEMPT_SUCCESS", `Execution attempt ${currentAttempt + 1} succeeded.`, { parentTaskId, attemptNumber: currentAttempt + 1 }));
                    currentWorkingContext.summaryOfProgress = `Execution attempt ${currentAttempt + 1} succeeded. ${currentWorkingContext.keyFindings.length} findings, ${currentWorkingContext.errorsEncountered.length} errors (from all attempts).`;
                    currentWorkingContext.nextObjective = "Proceed to final answer synthesis or task completion.";
                    await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                    break; // Exit replanning loop
                } else {
                    // Execution attempt failed
                    const failureDetails = currentExecutionResult.failedStepDetails ?
                        { narrative: currentExecutionResult.failedStepDetails.narrative_step, tool: currentExecutionResult.failedStepDetails.tool_name, error: currentExecutionResult.failedStepDetails.error_details } :
                        { error: "Unknown failure details" };
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_ATTEMPT_FAILED", `Execution attempt ${currentAttempt + 1} failed.`, { parentTaskId, attemptNumber: currentAttempt + 1, failureDetails }));
                    currentWorkingContext.summaryOfProgress = `Execution attempt ${currentAttempt + 1} failed. Error during step: '${failureDetails.narrative || 'unknown step'}'. Details: ${JSON.stringify(failureDetails.error).substring(0,100)}...`;
                    await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

                    if (currentAttempt >= MAX_REVISIONS) {
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("MAX_REVISIONS_REACHED", "Maximum replanning attempts reached. Task failed.", { parentTaskId }));
                        overallTaskSuccessFlag = false;
                        break; // Exit loop, task has definitively failed
                    } else {
                        // Try to replan
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_STARTED", `Attempting replanning. Revision ${currentAttempt + 1}.`, { parentTaskId, revisionAttempt: currentAttempt + 1 }));
                        currentWorkingContext.nextObjective = `Replanning attempt ${currentAttempt + 1} due to execution failure.`;
                        currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                        await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

                        const structuredFailedStepInfo = currentExecutionResult.failedStepDetails ? {
                            narrative_step: currentExecutionResult.failedStepDetails.narrative_step,
                            assigned_agent_role: currentExecutionResult.failedStepDetails.assigned_agent_role,
                            tool_name: currentExecutionResult.failedStepDetails.tool_name,
                            sub_task_input: currentExecutionResult.failedStepDetails.sub_task_input,
                            errorMessage: currentExecutionResult.failedStepDetails.error_details ? (currentExecutionResult.failedStepDetails.error_details.message || JSON.stringify(currentExecutionResult.failedStepDetails.error_details)) : "No error details provided"
                        } : null;

                        const newPlanResult = await this.planManager.getPlan(
                            currentOriginalTask,
                            knownAgentRoles,
                            knownToolsByRole,
                            memoryContextForPlanning, // 4th: memoryContext
                            currentWorkingContext,    // 5th: currentCWC
                            lastExecutionContext,
                            structuredFailedStepInfo,
                            planForNextAttempt,
                            true,
                            currentAttempt + 1        // 10th: revisionAttemptNumber
                        );

                        if (newPlanResult.success && newPlanResult.plan && newPlanResult.plan.length > 0) {
                            planForNextAttempt = newPlanResult.plan;
                            planStages = newPlanResult.plan;
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_SUCCESS", `Replanning successful. New plan generated by ${newPlanResult.source}.`, { parentTaskId, source: newPlanResult.source, newPlanStageCount: planForNextAttempt.length }));
                            currentWorkingContext.summaryOfProgress = `Replanning attempt ${currentAttempt + 1} successful. New plan generated. Previous errors: ${currentWorkingContext.errorsEncountered.length}.`;
                            currentWorkingContext.nextObjective = "Execute the revised plan.";
                            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                            await this.memoryManager.appendToMemory(taskDirPath, 'key_decisions_and_learnings.md', `## Replanning on ${new Date().toISOString()}\nOutcome: New plan generated by ${newPlanResult.source}.\n---\n`);
                        } else {
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_FAILED", `Replanning failed: ${newPlanResult.message || 'No new plan could be generated.'}`, { parentTaskId, reason: newPlanResult.message, rawResponse: newPlanResult.rawResponse }));
                            currentWorkingContext.summaryOfProgress = `Replanning attempt ${currentAttempt + 1} failed. ${newPlanResult.message || 'No new plan could be generated.'}`;
                            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                            await this.memoryManager.appendToMemory(taskDirPath, 'key_decisions_and_learnings.md', `## Replanning Failed on ${new Date().toISOString()}\nReason: ${newPlanResult.message || 'No new plan could be generated.'}\n---\n`);
                            overallTaskSuccessFlag = false;
                            break;
                        }
                    }
                }
            }
            overallSuccess = overallTaskSuccessFlag;
            executionContext = lastExecutionContext;
            executionResult = lastExecutionResult;

            finalJournalEntries.push(this._createOrchestratorJournalEntry(overallSuccess ? "EXECUTION_CYCLE_COMPLETED_SUCCESS" : "EXECUTION_CYCLE_COMPLETED_FAILURE", `Execution/replanning cycle finished. Overall Success: ${overallSuccess}`, { parentTaskId, overallSuccess }));
            currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            currentWorkingContext.nextObjective = overallSuccess ? "Synthesize final answer." : "Task failed after execution/replanning attempts.";
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_POST_EXECUTION_CYCLE", currentWorkingContext.summaryOfProgress, { parentTaskId, findingCount: currentWorkingContext.keyFindings.length, errorCount: currentWorkingContext.errorsEncountered.length }));
            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_START", "Attempting LLM update for CWC summary and next objective post-execution cycle.", { parentTaskId }));
            finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_START", "Attempting to summarize key findings for CWC update.", { parentTaskId }));
            const summarizedKeyFindingsTextForCwc = await this._getSummarizedKeyFindingsForPrompt(currentWorkingContext.keyFindings, parentTaskId, finalJournalEntries);
            if (summarizedKeyFindingsTextForCwc.startsWith("Key findings were too extensive") || summarizedKeyFindingsTextForCwc === "No key findings.") {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_SKIPPED_OR_FAILED", "Summarization of key findings skipped or failed for CWC update.", { parentTaskId, reason: summarizedKeyFindingsTextForCwc }));
            } else if (currentWorkingContext.keyFindings && currentWorkingContext.keyFindings.length > 0) { // Only log success if there were findings to summarize
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_SUCCESS", "Key findings summarized for CWC update.", { parentTaskId }));
            }

            const recentErrorsSummary = currentWorkingContext.errorsEncountered.slice(-MAX_ERRORS_FOR_CWC_PROMPT).map(e => ({ narrative: e.sourceStepNarrative, tool: e.sourceToolName, error: e.errorMessage}));

            const cwcUpdatePrompt = `The overall user task is: "${currentOriginalTask}".
The previous summary of progress was: "${currentWorkingContext.summaryOfProgress}".
The previous next objective was: "${currentWorkingContext.nextObjective}".
Recent plan execution overall success: ${overallSuccess}.
Recent key findings:
${summarizedKeyFindingsTextForCwc}
Recent errors encountered:
${JSON.stringify(recentErrorsSummary, null, 2)}

Based on this, provide an updated summary of progress and the immediate next objective for the overall task.
Return ONLY a JSON object with two keys: "updatedSummaryOfProgress" (string) and "updatedNextObjective" (string).
Example: { "updatedSummaryOfProgress": "Data gathered, some errors occurred.", "updatedNextObjective": "Synthesize findings considering errors." }`;

            try {
                // const cwcUpdateResponse = await this.llmService(cwcUpdatePrompt); // OLD
                const cwcUpdateResponse = await this.aiService.generateText(cwcUpdatePrompt, { model: (this.aiService.baseConfig && this.aiService.baseConfig.cwcUpdateModel) || 'gpt-3.5-turbo' }); // NEW
                const parsedCwcUpdate = JSON.parse(cwcUpdateResponse);

                if (parsedCwcUpdate && parsedCwcUpdate.updatedSummaryOfProgress && parsedCwcUpdate.updatedNextObjective) {
                    currentWorkingContext.summaryOfProgress = parsedCwcUpdate.updatedSummaryOfProgress;
                    currentWorkingContext.nextObjective = parsedCwcUpdate.updatedNextObjective;
                    currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED_BY_LLM", "CWC summary and next objective updated by LLM.", { parentTaskId, newSummary: currentWorkingContext.summaryOfProgress, newObjective: currentWorkingContext.nextObjective }));
                    await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                } else {
                    throw new Error("LLM response for CWC update missing required fields.");
                }
            } catch (cwcLlmError) {
                console.error(`OrchestratorAgent: Error updating CWC with LLM: ${cwcLlmError.message}`);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_ERROR", `LLM CWC update failed: ${cwcLlmError.message}`, { parentTaskId, error: cwcLlmError.message }));
                // CWC already saved before this attempt.
            }
        }

        let finalAnswer = null;
        let responseMessage = "";

        // Retrieve pre-synthesized answer if available using lastExecutionResult
        const preSynthesizedFinalAnswer = lastExecutionResult.finalAnswer;
        const wasFinalAnswerPreSynthesized = lastExecutionResult.finalAnswerSynthesized;

        if (wasFinalAnswerPreSynthesized) {
            finalAnswer = preSynthesizedFinalAnswer;
            responseMessage = "Task completed. Final answer was generated during plan execution (possibly in the last successful attempt).";
            finalJournalEntries.push(this._createOrchestratorJournalEntry(
                "FINAL_SYNTHESIS_SKIPPED",
                "Final answer was pre-synthesized by PlanExecutor.",
                { parentTaskId, answerPreview: String(finalAnswer).substring(0,100) + "..." }
            ));
            console.log("OrchestratorAgent: Final answer was pre-synthesized by PlanExecutor.");
            if (currentWorkingContext) {
               currentWorkingContext.summaryOfProgress = "Task completed. Final answer pre-synthesized by PlanExecutor.";
               currentWorkingContext.nextObjective = "Task finished.";
               currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            }
        } else if (overallSuccess && lastExecutionContext && lastExecutionContext.length > 0) { // Use lastExecutionContext
            finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_START", "Starting final synthesis of answer using results from the last successful execution attempt.", { parentTaskId }));
            const contextForLLMSynthesis = lastExecutionContext.map(entry => ({ step_narrative: entry.narrative_step, tool_used: entry.tool_name, input_details: entry.sub_task_input, status: entry.status, outcome_data: entry.processed_result_data, error_info: entry.error_details }));
            const synthesisContextString = JSON.stringify(contextForLLMSynthesis, null, 2);

            if (contextForLLMSynthesis.every(e => e.status === "FAILED" || (e.status === "COMPLETED" && (e.outcome_data === null || e.outcome_data === undefined)))) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", "Skipping final synthesis, no actionable data from the successful execution.", { parentTaskId }));
                responseMessage = "Execution completed, but no specific data was gathered from the final successful attempt to form an answer.";
                finalAnswer = "No specific information was generated from the execution to form a final answer.";
            } else {
                const synthesisPrompt = `The original user task was: "${currentOriginalTask}".
Execution History (JSON Array):
${synthesisContextString}
Current Working Context Summary:
Progress: ${currentWorkingContext.summaryOfProgress}
Next Objective: ${currentWorkingContext.nextObjective}
Key Findings (Summarized):
${await this._getSummarizedKeyFindingsForPrompt(currentWorkingContext.keyFindings, parentTaskId, finalJournalEntries)}
Errors Encountered (Last ${MAX_ERRORS_FOR_CWC_PROMPT}):
${JSON.stringify(currentWorkingContext.errorsEncountered.slice(-MAX_ERRORS_FOR_CWC_PROMPT),null,2)}
---
Based on the original user task, execution history, and current working context, synthesize a comprehensive answer.`;
                try {
                    finalAnswer = await this.aiService.generateText(synthesisPrompt, { model: (this.aiService.baseConfig && this.aiService.baseConfig.synthesisModel) || 'gpt-4' });
                    responseMessage = "Task completed and final answer synthesized.";
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SUCCESS", responseMessage, { parentTaskId }));
                } catch (synthError) {
                    responseMessage = "Synthesis failed: " + synthError.message;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_FAILED", responseMessage, { parentTaskId, error: synthError.message }));
                    finalAnswer = "Error during final answer synthesis.";
                    overallSuccess = false; // Mark task as failed if synthesis fails
                }
            }
        } else if (!overallSuccess) {
            responseMessage = "One or more sub-tasks failed. Unable to provide a final synthesized answer.";
            finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ABORTED", responseMessage, { parentTaskId }));
        } else {
            responseMessage = "No execution steps were performed or no data produced; no final answer synthesized.";
             finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", responseMessage, { parentTaskId }));
        }

        currentWorkingContext.summaryOfProgress = `Final synthesis attempt concluded: ${responseMessage}`;
        currentWorkingContext.lastUpdatedAt = new Date().toISOString();
        finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED", "CWC updated after synthesis attempt.", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));
        await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
        }
         else if (!wasFinalAnswerPreSynthesized) {
            if (!overallSuccess) {
                 responseMessage = "One or more sub-tasks failed. Unable to provide a final synthesized answer.";
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ABORTED", responseMessage, { parentTaskId }));
            } else {
                 responseMessage = "No execution steps were performed or no actionable data produced; no final answer synthesized.";
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", responseMessage, { parentTaskId }));
            }
            if (currentWorkingContext) {
                currentWorkingContext.summaryOfProgress = responseMessage;
                currentWorkingContext.nextObjective = "Task finished with no new answer synthesized by Orchestrator.";
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
            }
        }

        const taskStatusToSave = overallSuccess ? "COMPLETED" : "FAILED_EXECUTION";
        const taskStateToSave = {
            taskId: parentTaskId,
            userTaskString: currentOriginalTask,
            status: taskStatusToSave,
            plan: planStages,
            executionContext: executionContext,
            finalAnswer: finalAnswer,
            errorSummary: overallSuccess ? null : {
                reason: responseMessage,
                ...(lastExecutionResult && lastExecutionResult.failedStepDetails ? {
                    failedStep: {
                        narrative: lastExecutionResult.failedStepDetails.narrative_step,
                        tool: lastExecutionResult.failedStepDetails.tool_name,
                        error: lastExecutionResult.failedStepDetails.error_details
                    }
                } : (lastExecutionResult && lastExecutionResult.updatesForWorkingContext && lastExecutionResult.updatesForWorkingContext.errorsEncountered && lastExecutionResult.updatesForWorkingContext.errorsEncountered.length > 0 ? { lastKnownError: lastExecutionResult.updatesForWorkingContext.errorsEncountered[lastExecutionResult.updatesForWorkingContext.errorsEncountered.length -1] } : { detail: "No specific error details captured in final result." }) )
            },
            currentWorkingContext
        };
        // planResult might be from the initial planning, or from the last successful replan.
        // For simplicity, we'll save the plan that was last attempted or successfully executed.
        // If replanning occurred, planStages would have been updated.
        if (planResult && planResult.source) { // planResult is from initial planning
             if (planStages === planResult.plan) { // Check if initial plan was used
                taskStateToSave.plan_source = planResult.source;
                if (planResult.source !== 'template') {
                    taskStateToSave.raw_llm_response_initial_plan = planResult.rawResponse;
                }
            } else { // A different plan (likely revised) was used
                 taskStateToSave.plan_source = 'llm_revised'; // Or track more specifically if newPlanResult is stored
            }
        } else if (executionMode === "EXECUTE_PLANNED_TASK" && loadedState) {
            taskStateToSave.plan_source = loadedState.plan_source || "loaded_from_previous_task";
            if (loadedState.raw_llm_response) taskStateToSave.raw_llm_response_initial_plan = loadedState.raw_llm_response;
        }

        if(currentWorkingContext) {
             currentWorkingContext.lastUpdatedAt = new Date().toISOString();
             await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
        }

        await saveTaskState(stateFilePath, taskStateToSave); // Use new path
        finalJournalEntries.push(this._createOrchestratorJournalEntry(overallSuccess ? "TASK_COMPLETED_SUCCESSFULLY" : "TASK_FAILED_FINAL", `Task processing finished. Overall Success: ${overallSuccess}`, { parentTaskId, finalStatus: taskStatusToSave }));
        await saveTaskJournal(journalFilePath, finalJournalEntries); // Use new path

        // Final memory writes
        if (taskStateToSave.finalAnswer) {
            await this.memoryManager.overwriteMemory(taskDirPath, 'final_answer_archive.md', String(taskStateToSave.finalAnswer));
        }
        let execSummary = `Execution Summary for Task ${parentTaskId}:\nStatus: ${taskStateToSave.status}\n`;
        if (taskStateToSave.plan && taskStateToSave.plan.length > 0) { execSummary += `Plan Stages: ${taskStateToSave.plan.length}\n`; }
        if (taskStateToSave.errorSummary) { execSummary += `Error: ${taskStateToSave.errorSummary.reason}\n`; }
        if (taskStateToSave.finalAnswer) { execSummary += `Final Answer (preview): ${String(taskStateToSave.finalAnswer).substring(0, 200)}...\n`; }
        await this.memoryManager.overwriteMemory(taskDirPath, 'execution_log_summary.md', execSummary);

        // Key decisions and learnings are appended within the loop.

        return { success: overallSuccess, message: responseMessage, originalTask: currentOriginalTask, plan: planStages, executedPlan: executionContext, finalAnswer, currentWorkingContext };

    } catch (error) {
        console.error(`OrchestratorAgent: Critical unhandled error in handleUserTask for ParentTaskID ${parentTaskId}: ${error.message}`, error.stack);
        finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_PROCESSING_ERROR", `Critical unhandled error: ${error.message}`, { parentTaskId, errorStack: error.stack }));
        if (currentWorkingContext) {
            currentWorkingContext.summaryOfProgress = `Critical unhandled error: ${error.message}`;
            currentWorkingContext.errorsEncountered.push({ errorId: `err-critical-${parentTaskId}`, sourceStepNarrative: "Orchestrator System", sourceToolName: "handleUserTask", errorMessage: error.message, timestamp: new Date().toISOString() });
            currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            if (taskDirPath) {
                 try { await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true }); }
                 catch (memErr) { console.error("Failed to save CWC to memory during critical error:", memErr.message); }
            }
        }

        const errorStateForSave = {
            taskId: parentTaskId, userTaskString: currentOriginalTask || userTaskString, status: "CRITICAL_ERROR",
            plan: planStages || [], executionContext: executionResult ? executionResult.executionContext : [], finalAnswer: null,
            errorSummary: { reason: `Critical unhandled error: ${error.message}` },
            currentWorkingContext: currentWorkingContext || {}
        };
        try {
            // Construct paths for saving state and journal even in critical error
            const baseSavePathOnError = path.join(__dirname, '..', 'saved_tasks');
            const dateOnError = new Date();
            const dateStrOnError = `${(dateOnError.getMonth() + 1).toString().padStart(2, '0')}${(dateOnError.getDate()).toString().padStart(2, '0')}${dateOnError.getFullYear()}`;
            const datedDirOnError = path.join(baseSavePathOnError, `tasks_${dateStrOnError}`);
            const taskDirOnError = path.join(datedDirOnError, parentTaskId); // Use parentTaskId for folder name

            await fsp.mkdir(taskDirOnError, { recursive: true }); // Ensure dir exists

            const stateFilePathOnError = path.join(taskDirOnError, `task_state.json`);
            const journalFilePathOnError = path.join(taskDirOnError, `journal.json`);

            await saveTaskState(stateFilePathOnError, errorStateForSave);
            await saveTaskJournal(journalFilePathOnError, finalJournalEntries);
        } catch (saveError) {
            console.error(`OrchestratorAgent: Failed to save state/journal during critical error handling: ${saveError.message}`);
        }
        return { success: false, message: `Internal Server Error: ${error.message}`, taskId: parentTaskId, originalTask: currentOriginalTask || userTaskString, finalAnswer: null, currentWorkingContext };
    }
  }
}

module.exports = OrchestratorAgent;
