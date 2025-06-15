const fs = require('fs'); // Keep for existing sync operations if any
const fsp = require('fs').promises; // Added for async file operations
const path = require('path'); // Ensure path is imported
const crypto = require('crypto'); // Ensure crypto is imported (already added in a previous successful step)
// const { v4: uuidv4 } = require('uuid'); // Already imported
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

  async _getSummarizedKeyFindingsForPrompt(parentTaskIdForJournal, finalJournalEntriesInput, taskDirPath, count = 5) {
    const MAX_KEY_FINDINGS_TO_FETCH = count; // Max number of latest findings to fetch
    const MAX_KEY_FINDINGS_FOR_DIRECT_INCLUSION = 5; // Max number of findings to try and include directly in the prompt (subset of fetched)
    const MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT = 4000;
    const findingsSummarizationPromptTemplate = `The following text is a collection of key findings obtained while working on a task. Each finding might be a piece of data, an observation, or a result from a tool. Please synthesize these findings into a brief, coherent summary that captures the most important information relevant to the overall task progress. Focus on actionable insights or critical data points.\n\nCollection of Key Findings:\n---\n{text_to_summarize}\n---\nBrief Synthesized Summary:`;

    if (!taskDirPath) {
        console.warn("OrchestratorAgent._getSummarizedKeyFindingsForPrompt: taskDirPath not provided.");
        return "No key findings (taskDirPath missing).";
    }

    const actualKeyFindings = await this.memoryManager.getLatestKeyFindings(taskDirPath, MAX_KEY_FINDINGS_TO_FETCH);

    if (!actualKeyFindings || actualKeyFindings.length === 0) {
        return "No key findings.";
    }

    let findingsTextForPrompt = "";
    let currentLength = 0;
    let findingsToIncludeDirectly = [];

    const reversedFindings = [...actualKeyFindings].reverse();
    // Limit how many we attempt to directly include (e.g., up to 5 of the latest 'count' findings)
    const iterationLimit = Math.min(reversedFindings.length, MAX_KEY_FINDINGS_FOR_DIRECT_INCLUSION);

    for (let i = 0; i < iterationLimit; i++) {
        const finding = reversedFindings[i];
        // Simplified data representation for this refactoring step.
        // The complex raw content handling logic from subtask 12 would be re-integrated here if needed.
        const findingDataStr = typeof finding.data === 'string' ? finding.data : JSON.stringify(finding.data);
        const findingRepresentation = `Finding (Tool: ${finding.sourceToolName}, Step: "${finding.sourceStepNarrative}"): ${findingDataStr.substring(0, 500) + (findingDataStr.length > 500 ? '...' : '')}\n`;

        if (currentLength + findingRepresentation.length > MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT && findingsToIncludeDirectly.length > 0) {
            break;
        }
        findingsToIncludeDirectly.unshift(findingRepresentation); // Add the string representation
        currentLength += findingRepresentation.length;
    }

    // If not all (fetched) findings were included directly, or if the combined length is too great, summarize ALL fetched findings.
    if (findingsToIncludeDirectly.length < actualKeyFindings.length || currentLength > MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT && actualKeyFindings.length > 0) {
        let allFindingsTextForSummarization = "";
        actualKeyFindings.forEach(f => { // Use all 'actualKeyFindings' for the summarization context
            const findingDataStr = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
            allFindingsTextForSummarization += `Tool: ${f.sourceToolName}, Step: "${f.sourceStepNarrative}"\nData: ${findingDataStr}\n---\n`;
        });

        if (finalJournalEntriesInput) finalJournalEntriesInput.push(this._createOrchestratorJournalEntry("SUMMARIZING_KEY_FINDINGS_FOR_PROMPT_CONTEXT", `Summarizing ${actualKeyFindings.length} key findings due to length or count limits for prompt inclusion.`, { parentTaskId: parentTaskIdForJournal, count: actualKeyFindings.length }));
        try {
            const summary = await this.aiService.generateText(
                findingsSummarizationPromptTemplate.replace('{text_to_summarize}', allFindingsTextForSummarization),
                {
                    model: (this.aiService.baseConfig && this.aiService.baseConfig.summarizationModel) || (this.aiService.getServiceName() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-pro'),
                    temperature: 0.3,
                    maxTokens: 500
                }
            );
            return `Summary of Recent Key Findings:\n${summary}`;
        } catch (e) {
            if (finalJournalEntriesInput) finalJournalEntriesInput.push(this._createOrchestratorJournalEntry("KEY_FINDINGS_SUMMARIZATION_FAILED", `Summarization of key findings failed for prompt context. Error: ${e.message}`, { parentTaskId: parentTaskIdForJournal }));
            return "Key findings were too extensive for direct inclusion, and summarization failed.";
        }
    } else {
        // All (latest N) findings fit directly
        findingsTextForPrompt = "Key findings:\n" + findingsToIncludeDirectly.join('---\n');
        return findingsTextForPrompt.trim();
    }
  }

  /**
   * Handles a user task, orchestrating planning, execution, and synthesis.
   * @param {string} userTaskString - The user's task description.
   * @param {Array<Object>=} uploadedFiles - Array of uploaded file objects, e.g., { name: string, content: string }. Defaults to an empty array.
   * @param {string} parentTaskId - The unique ID for this task.
   * @param {string|null} [taskIdToLoad=null] - Optional ID of a previous task state to load.
   * @param {string} [executionMode="EXECUTE_FULL_PLAN"] - Defines the execution behavior:
   *   - "EXECUTE_FULL_PLAN": Standard full cycle: plan -> execute -> synthesize.
   *   - "PLAN_ONLY": Generates a plan and saves it, then stops.
   *   - "EXECUTE_PLANNED_TASK": Loads a task state (must include a plan) and executes it.
   *   - "SYNTHESIZE_ONLY": Loads a task state (must include execution context) and synthesizes a final answer.
   * @returns {Promise<Object>} Result object containing success status, messages, and task outputs.
   */
  async handleUserTask(userTaskString, uploadedFiles = [], parentTaskId, taskIdToLoad = null, executionMode = "EXECUTE_FULL_PLAN") {
    const MAX_ERRORS_FOR_CWC_PROMPT = 3;
    const DEFAULT_MEGA_CONTEXT_TTL = 3600; // 1 hour in seconds

    const initialJournalEntries = []; // Orchestrator-specific entries before execution
    initialJournalEntries.push(this._createOrchestratorJournalEntry(
        "TASK_RECEIVED",
        `Task received. Mode: ${executionMode}`,
        { parentTaskId, userTaskStringPreview: userTaskString ? userTaskString.substring(0, 200) + '...' : 'N/A', uploadedFileCount: uploadedFiles.length, taskIdToLoad, executionMode }
    ));
    console.log(`OrchestratorAgent: Received task: '${userTaskString ? userTaskString.substring(0,100)+'...' : 'N/A'}', uploadedFiles: ${uploadedFiles.length}, parentTaskId: ${parentTaskId}, taskIdToLoad: ${taskIdToLoad}, mode: ${executionMode}`);

    let currentWorkingContext = {
        lastUpdatedAt: new Date().toISOString(),
        summaryOfProgress: "Task processing initiated.",
        // keyFindings: [], // Removed
        identifiedEntities: {},
        pendingQuestions: [],
        nextObjective: "Define execution plan or synthesize based on mode.",
        confidenceScore: 0.7,
        // errorsEncountered: [] // Removed
    };
    initialJournalEntries.push(this._createOrchestratorJournalEntry("CWC_INITIALIZED", "CurrentWorkingContext initialized (keyFindings and errorsEncountered to be managed by MemoryManager).", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));

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

        // Save any user-uploaded files to the task's memory bank for later context assembly.
        const savedUploadedFilePaths = [];
        if (uploadedFiles && uploadedFiles.length > 0) {
            const uploadedFilesDir = path.join('uploaded_files'); // Store in a dedicated subdirectory within the task's memory bank.
            finalJournalEntries.push(this._createOrchestratorJournalEntry("SAVING_UPLOADED_FILES", `Attempting to save ${uploadedFiles.length} uploaded files.`, { parentTaskId, count: uploadedFiles.length }));
            for (const file of uploadedFiles) {
                try {
                    // Basic sanitization of filename to prevent path traversal issues.
                    const safeFileName = path.basename(file.name);
                    const relativeFilePath = path.join(uploadedFilesDir, safeFileName);
                    // Overwrite memory with the file content. MemoryManager handles directory creation.
                    await this.memoryManager.overwriteMemory(taskDirPath, relativeFilePath, file.content);
                    savedUploadedFilePaths.push(relativeFilePath); // Store the relative path for context assembly.
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_SUCCESS", `Successfully saved uploaded file: ${relativeFilePath}`, { parentTaskId, fileName: file.name, relativePath: relativeFilePath }));
                } catch (uploadError) {
                    console.error(`OrchestratorAgent: Error saving uploaded file '${file.name}': ${uploadError.message}`);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_ERROR", `Error saving uploaded file '${file.name}': ${uploadError.message}`, { parentTaskId, fileName: file.name, error: uploadError.message }));
                    // Consider if a single file save error should halt the task. For now, it logs and continues.
                }
            }
        }

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
            let tokenizerFn;
            let maxTokenLimit;

            try {
                // Get tokenizer and maxTokenLimit from aiService.
                // TODO: Ensure aiService is always initialized before this point or handle potential errors.
                if (this.aiService && typeof this.aiService.getTokenizer === 'function') {
                    tokenizerFn = this.aiService.getTokenizer();
                } else {
                    // Fallback to a placeholder if the AI service or its tokenizer isn't available.
                    console.warn("OrchestratorAgent: aiService.getTokenizer() is not available. Using placeholder tokenizer.");
                    tokenizerFn = (text) => text ? Math.ceil(text.length / 4) : 0; // Simple approximation.
                }

                // TODO: Ensure aiService is always initialized before this point.
                if (this.aiService && typeof this.aiService.getMaxContextTokens === 'function') {
                    maxTokenLimit = this.aiService.getMaxContextTokens();
                } else {
                    // Fallback to a default placeholder if max tokens cannot be determined.
                    console.warn("OrchestratorAgent: aiService.getMaxContextTokens() is not available. Using placeholder maxTokenLimit (4096).");
                    maxTokenLimit = 4096;
                }


                const taskDefFromMemory = await this.memoryManager.loadMemory(taskDirPath, 'task_definition.md', { defaultValue: currentOriginalTask });
                memoryContextForPlanning.taskDefinition = taskDefFromMemory;

                // Assemble context for initial planning.
                // This includes the task definition, uploaded files, and a few recent key findings.
                const contextSpecificationForPlanning = {
                    systemPrompt: "You are an AI assistant responsible for planning complex tasks. Use the provided context to create a comprehensive plan.",
                    includeTaskDefinition: true,
                    uploadedFilePaths: savedUploadedFilePaths,
                    maxLatestKeyFindings: 5,
                    chatHistory: [], // No chat history for initial planning.
                    maxTokenLimit: maxTokenLimit,
                    customPreamble: "Контекст для первоначального планирования:",
                    enableMegaContextCache: true, // Enable caching for this planning context.
                    megaContextCacheTTLSeconds: DEFAULT_MEGA_CONTEXT_TTL, // Set cache TTL.
                    // Optional: Add other relevant fields if needed for planning, e.g., specific constraints.
                };

                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_START", "Assembling mega context for initial planning.", { parentTaskId, spec: contextSpecificationForPlanning }));
                const megaContextResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForPlanning, tokenizerFn);

                if (megaContextResult.success) {
                    memoryContextForPlanning.megaContext = megaContextResult.contextString;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", "Mega context assembled successfully for planning.", { parentTaskId, contextLength: megaContextResult.contextString.length, tokenCount: megaContextResult.tokenCount }));
                } else {
                    console.error(`OrchestratorAgent: Failed to assemble mega context for initial planning for task ${parentTaskId}: ${megaContextResult.error}`);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `Failed to assemble mega context for planning: ${megaContextResult.error}`, { parentTaskId, error: megaContextResult.error }));
                    // Fallback: memoryContextForPlanning will not have .megaContext, PlanManager will use older context construction.
                }


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
                console.warn(`OrchestratorAgent: Error loading memory or assembling mega context for planning for task ${parentTaskId}: ${memError.message}`);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_CONTEXT_ERROR", `Failed to load memory or assemble mega context for planning: ${memError.message}`, { parentTaskId }));
            }

            // memoryContextForPlanning now potentially includes .megaContext
            planResult = await this.planManager.getPlan(currentOriginalTask, knownAgentRoles, knownToolsByRole, memoryContextForPlanning, currentWorkingContext);

            if (!planResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", `Planning failed: ${planResult.message}`, { parentTaskId, error: planResult.message }));
                currentWorkingContext.summaryOfProgress = `Planning failed: ${planResult.message}`;
                await this.memoryManager.addErrorEncountered(taskDirPath, { errorId: `err-plan-${parentTaskId}`, sourceStepNarrative: "Planning", sourceToolName: "PlanManager", errorMessage: planResult.message, timestamp: new Date().toISOString()});
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
                    if (currentExecutionResult.updatesForWorkingContext.keyFindings) {
                        for (const finding of currentExecutionResult.updatesForWorkingContext.keyFindings) {
                            await this.memoryManager.addKeyFinding(taskDirPath, finding);
                        }
                    }
                    if (currentExecutionResult.updatesForWorkingContext.errorsEncountered) {
                        for (const error of currentExecutionResult.updatesForWorkingContext.errorsEncountered) {
                            await this.memoryManager.addErrorEncountered(taskDirPath, error);
                        }
                    }
                }
                // Always store the latest execution context and result
                lastExecutionContext = currentExecutionResult.executionContext || [];
                lastExecutionResult = currentExecutionResult;

                if (currentExecutionResult.success) {
                    overallTaskSuccessFlag = true;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_ATTEMPT_SUCCESS", `Execution attempt ${currentAttempt + 1} succeeded.`, { parentTaskId, attemptNumber: currentAttempt + 1 }));
                    currentWorkingContext.summaryOfProgress = `Execution attempt ${currentAttempt + 1} succeeded.`; // Counts removed
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

                        const latestKeyFindingsForReplanning = await this.memoryManager.getLatestKeyFindings(taskDirPath, 5);
                        const latestErrorsForReplanning = await this.memoryManager.getLatestErrorsEncountered(taskDirPath, 3);

                        const newPlanResult = await this.planManager.getPlan(
                            currentOriginalTask,
                            knownAgentRoles,
                            knownToolsByRole,
                            memoryContextForPlanning,
                            currentWorkingContext,
                            lastExecutionContext,
                            structuredFailedStepInfo,
                            planForNextAttempt,
                            true,
                            currentAttempt + 1,
                            latestKeyFindingsForReplanning, // New param
                            latestErrorsForReplanning       // New param
                        );

                        if (newPlanResult.success && newPlanResult.plan && newPlanResult.plan.length > 0) {
                            planForNextAttempt = newPlanResult.plan;
                            planStages = newPlanResult.plan;
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_SUCCESS", `Replanning successful. New plan generated by ${newPlanResult.source}.`, { parentTaskId, source: newPlanResult.source, newPlanStageCount: planForNextAttempt.length }));
                            currentWorkingContext.summaryOfProgress = `Replanning attempt ${currentAttempt + 1} successful. New plan generated.`; // Error count removed
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
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_POST_EXECUTION_CYCLE", currentWorkingContext.summaryOfProgress, { parentTaskId /* Counts removed */ }));
            // CWC save here was already removed by previous subtask (CWC write optimization)

            // --- New Batch Summarization of Key Findings using getSummarizedRecords ---
            // This block was from previous subtask, but it used currentWorkingContext.keyFindings.slice(-20)
            // Now it will use getLatestKeyFindings
            finalJournalEntries.push(this._createOrchestratorJournalEntry("BATCH_SUMMARY_RECORDS_START", "Attempting to generate batch summary of key findings.", { parentTaskId }));
            const recordInputsForBatchSummary = [];
            const findingsToConsiderForBatchSummary = await this.memoryManager.getLatestKeyFindings(taskDirPath, 20);

            for (const finding of findingsToConsiderForBatchSummary) {
                if (finding.data && finding.data.type === 'reference_to_raw_content' && finding.data.rawContentPath) {
                    recordInputsForBatchSummary.push({
                        id: finding.id || path.basename(finding.data.rawContentPath),
                        type: 'path',
                        path: finding.data.rawContentPath
                    });
                } else {
                    let stringifiedData;
                    if (typeof finding.data === 'string') {
                        stringifiedData = finding.data;
                    } else if (finding.data === null || finding.data === undefined) {
                        stringifiedData = "";
                    } else {
                        try {
                            stringifiedData = JSON.stringify(finding.data);
                        } catch (e) {
                            console.warn(`OrchestratorAgent: Could not stringify finding.data for batch summary input (finding ID: ${finding.id}): ${e.message}`);
                            stringifiedData = `Error: Could not stringify data for finding ${finding.id}`;
                        }
                    }
                    recordInputsForBatchSummary.push({
                        id: finding.id || uuidv4(),
                        type: 'content',
                        content: stringifiedData
                    });
                }
            }

            if (recordInputsForBatchSummary.length > 0) {
                const batchSummarizationOptions = {
                    promptTemplate: `The following is a collection of records, findings, and data points accumulated during a complex task. Provide a single, coherent summary of the overall progress, current understanding, key achievements, and any unresolved issues or critical information. Focus on a high-level overview suitable for understanding the task's current state.

Combined Records:
{combined_content}

Comprehensive Task Status Summary:`,
                    llmParams: {
                        model: (this.aiService.baseConfig && this.aiService.baseConfig.cwcUpdateModel) || 'gpt-3.5-turbo',
                        temperature: 0.5
                    },
                };
                try {
                    const newBatchSummary = await this.memoryManager.getSummarizedRecords(
                        taskDirPath,
                        recordInputsForBatchSummary,
                        this.aiService,
                        batchSummarizationOptions
                    );
                    currentWorkingContext.batchProgressSummary = newBatchSummary;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("BATCH_SUMMARY_RECORDS_SUCCESS", "Successfully generated batch summary of key findings.", { parentTaskId, summaryPreview: String(newBatchSummary).substring(0, 100) + "..." }));
                } catch (batchSummaryError) {
                    console.error(`OrchestratorAgent: Failed to get summarized records for CWC update: ${batchSummaryError.message}`);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("BATCH_SUMMARY_RECORDS_FAILED", `Failed to generate batch summary: ${batchSummaryError.message}`, { parentTaskId, error: batchSummaryError.message }));
                }
            } else {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("BATCH_SUMMARY_RECORDS_SKIPPED", "No records identified for batch summarization.", { parentTaskId }));
            }
            // --- End of New Batch Summarization ---

            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_START", "Attempting LLM update for CWC summary and next objective post-execution cycle.", { parentTaskId }));
            finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_START", "Attempting to summarize key findings for CWC update.", { parentTaskId }));
            const summarizedKeyFindingsTextForCwc = await this._getSummarizedKeyFindingsForPrompt(parentTaskId, finalJournalEntries, taskDirPath, 10); // Use count 10

            // Check if findings were processed for logging, not by re-fetching
            if (summarizedKeyFindingsTextForCwc && !summarizedKeyFindingsTextForCwc.startsWith("No key findings") && !summarizedKeyFindingsTextForCwc.includes("summarization failed")) {
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_SUCCESS", "Key findings summarized for CWC update.", { parentTaskId }));
            } else {
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_SUMMARIZATION_SKIPPED_OR_FAILED", "Summarization of key findings skipped or failed for CWC update.", { parentTaskId, reason: summarizedKeyFindingsTextForCwc }));
            }

            const recentErrorsForCwcUpdate = await this.memoryManager.getLatestErrorsEncountered(taskDirPath, MAX_ERRORS_FOR_CWC_PROMPT);
            const recentErrorsSummary = recentErrorsForCwcUpdate.map(e => ({ narrative: e.sourceStepNarrative, tool: e.sourceToolName, error: e.errorMessage }));

            let cwcUpdatePrompt;
            // Assemble context for updating the Current Working Context (CWC).
            // This includes task definition, uploaded files, more key findings, current CWC state,
            // recent errors, and a summary of findings from the last execution cycle.
            const contextSpecificationForCwcUpdate = {
                systemPrompt: "You are an expert system analyzing task progress. Your goal is to update the Current Working Context (CWC) based on the latest information. Provide a concise summary of progress and the immediate next objective.",
                includeTaskDefinition: true,
                uploadedFilePaths: savedUploadedFilePaths,
                maxLatestKeyFindings: 10,
                includeRawContentForReferencedFindings: true,
                chatHistory: [], // No chat history for this internal CWC update.
                maxTokenLimit: maxTokenLimit || 4096, // Use fetched or default.
                customPreamble: "Контекст для обновления CWC:",
                // Key information for CWC update:
                currentProgressSummary: currentWorkingContext.summaryOfProgress,
                currentNextObjective: currentWorkingContext.nextObjective,
                recentErrorsSummary: recentErrorsSummary,
                summarizedKeyFindingsText: summarizedKeyFindingsTextForCwc, // Summary from _getSummarizedKeyFindingsForPrompt
                overallExecutionSuccess: overallSuccess,
                enableMegaContextCache: true, // Enable caching for CWC update context.
                megaContextCacheTTLSeconds: DEFAULT_MEGA_CONTEXT_TTL, // Set cache TTL.
                priorityOrder: [ // Example priority for CWC context
                    'systemPrompt',
                    'taskDefinition', // Remind LLM of original goal
                    'currentProgressSummary', 'currentNextObjective', // Current state
                    'overallExecutionSuccess', // Result of last attempt
                    'summarizedKeyFindingsText', // What was found
                    'recentErrorsSummary', // What went wrong
                    'uploadedFilePaths', // Any static files for reference
                    // chatHistory is empty here, so not critical in order
                ]
            };

            finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_START", "Assembling mega context for CWC update.", { parentTaskId, spec: contextSpecificationForCwcUpdate }));
            const megaContextCwcResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForCwcUpdate, tokenizerFn);

            if (megaContextCwcResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", "Mega context assembled successfully for CWC update.", { parentTaskId, contextLength: megaContextCwcResult.contextString.length, tokenCount: megaContextCwcResult.tokenCount }));
                cwcUpdatePrompt = `${megaContextCwcResult.contextString}

Based on all the provided context, provide an updated summary of progress and the immediate next objective for the overall task.
Return ONLY a JSON object with two keys: "updatedSummaryOfProgress" (string) and "updatedNextObjective" (string).
Example: { "updatedSummaryOfProgress": "Data gathered, some errors occurred.", "updatedNextObjective": "Synthesize findings considering errors." }`;
            } else {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `Failed to assemble mega context for CWC update: ${megaContextCwcResult.error}. Falling back to simpler prompt.`, { parentTaskId, error: megaContextCwcResult.error }));
                // Fallback to existing, simpler cwcUpdatePrompt construction
                cwcUpdatePrompt = `The overall user task is: "${currentOriginalTask}".
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
            }

            try {
                const cwcUpdateModel = (this.aiService.baseConfig && this.aiService.baseConfig.cwcUpdateModel) ||
                                     (this.aiService.getServiceName && (this.aiService.getServiceName() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-pro'));

                const cwcUpdateResponse = await this.aiService.generateText(cwcUpdatePrompt, { model: cwcUpdateModel });
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
                let synthesisPrompt;
                // Assemble context for the final answer synthesis.
                // This includes the original task, full execution history of the last attempt,
                // CWC summary, key findings, errors, and uploaded files.
                const contextSpecificationForSynthesis = {
                    systemPrompt: "You are an expert system synthesizing the final answer for a task. Use all available context to provide a comprehensive and accurate response to the original user query.",
                    includeTaskDefinition: true, // To ensure the LLM remembers the core goal.
                    uploadedFilePaths: savedUploadedFilePaths,
                    maxLatestKeyFindings: 20, // Allow more findings for comprehensive synthesis.
                    includeRawContentForReferencedFindings: true, // Crucial for accurate synthesis.
                    chatHistory: [], // No separate chat history for this system-level synthesis.
                    maxTokenLimit: maxTokenLimit || 8192, // Allow a larger context for synthesis.
                    customPreamble: "Контекст для финального ответа:",
                    // Key information for final synthesis:
                    originalUserTask: currentOriginalTask,
                    executionContext: lastExecutionContext,
                    currentWorkingContextSummary: currentWorkingContext.summaryOfProgress,
                    summarizedKeyFindingsText: summarizedKeyFindingsTextForCwc, // Or a more comprehensive one if needed.
                    recentErrorsSummary: recentErrorsSummary,
                    priorityOrder: [ // Example priority for synthesis
                        'systemPrompt',
                        'originalUserTask', // Most important: what was the goal?
                        'executionContext', // What was done?
                        'summarizedKeyFindingsText', // What was found?
                        'recentErrorsSummary', // What were the problems?
                        'currentWorkingContextSummary', // What's the current high-level status?
                        'taskDefinition', // Full original task definition, if different from userTaskString
                        'uploadedFilePaths' // Supporting documents.
                    ]
                };

                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_START", "Assembling mega context for final synthesis.", { parentTaskId, spec: contextSpecificationForSynthesis }));
                const megaContextSynthesisResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForSynthesis, tokenizerFn);

                if (megaContextSynthesisResult.success) {
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", "Mega context assembled successfully for final synthesis.", { parentTaskId, contextLength: megaContextSynthesisResult.contextString.length, tokenCount: megaContextSynthesisResult.tokenCount }));
                    synthesisPrompt = `${megaContextSynthesisResult.contextString}

Based on all the provided context, synthesize a comprehensive answer for the original user task: "${currentOriginalTask}".`;
                } else {
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `Failed to assemble mega context for final synthesis: ${megaContextSynthesisResult.error}. Falling back to simpler prompt.`, { parentTaskId, error: megaContextSynthesisResult.error }));
                    // Fallback to existing synthesisPrompt construction
                    synthesisPrompt = `The original user task was: "${currentOriginalTask}".
Execution History (JSON Array):
${synthesisContextString}
Current Working Context Summary:
Progress: ${currentWorkingContext.summaryOfProgress}
Next Objective: ${currentWorkingContext.nextObjective}
Key Findings (Summarized):
${summarizedKeyFindingsTextForCwc}
Errors Encountered (Last ${MAX_ERRORS_FOR_CWC_PROMPT}):
${JSON.stringify(recentErrorsSummary,null,2)}
---
Based on the original user task, execution history, and current working context, synthesize a comprehensive answer.`;
                }

                try {
                    const synthesisModel = (this.aiService.baseConfig && this.aiService.baseConfig.synthesisModel) ||
                                         (this.aiService.getServiceName && (this.aiService.getServiceName() === 'OpenAI' ? 'gpt-4' : 'gemini-1.5-pro-latest')); // Use a powerful model for synthesis

                    finalAnswer = await this.aiService.generateText(synthesisPrompt, { model: synthesisModel });
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
                    // currentWorkingContext.errorsEncountered.push(...); // Replaced by addErrorEncountered
                    await this.memoryManager.addErrorEncountered(taskDirPath, { errorId: `err-critical-${parentTaskId}`, sourceStepNarrative: "Orchestrator System", sourceToolName: "handleUserTask", errorMessage: error.message, timestamp: new Date().toISOString() });
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
