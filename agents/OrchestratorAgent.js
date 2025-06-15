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
    const iterationLimit = Math.min(reversedFindings.length, MAX_KEY_FINDINGS_FOR_DIRECT_INCLUSION);

    for (let i = 0; i < iterationLimit; i++) {
        const finding = reversedFindings[i];
        const findingDataStr = typeof finding.data === 'string' ? finding.data : JSON.stringify(finding.data);
        const findingRepresentation = `Finding (Tool: ${finding.sourceToolName}, Step: "${finding.sourceStepNarrative}"): ${findingDataStr.substring(0, 500) + (findingDataStr.length > 500 ? '...' : '')}\n`;

        if (currentLength + findingRepresentation.length > MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT && findingsToIncludeDirectly.length > 0) {
            break;
        }
        findingsToIncludeDirectly.unshift(findingRepresentation);
        currentLength += findingRepresentation.length;
    }

    if (findingsToIncludeDirectly.length < actualKeyFindings.length || currentLength > MAX_TOTAL_FINDINGS_LENGTH_FOR_PROMPT && actualKeyFindings.length > 0) {
        let allFindingsTextForSummarization = "";
        actualKeyFindings.forEach(f => {
            const findingDataStr = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
            allFindingsTextForSummarization += `Tool: ${f.sourceToolName}, Step: "${f.sourceStepNarrative}"\nData: ${findingDataStr}\n---\n`;
        });

        if (finalJournalEntriesInput) finalJournalEntriesInput.push(this._createOrchestratorJournalEntry("SUMMARIZING_KEY_FINDINGS_FOR_PROMPT_CONTEXT", `Summarizing ${actualKeyFindings.length} key findings.`, { parentTaskId: parentTaskIdForJournal, count: actualKeyFindings.length }));
        try {
            const summary = await this.aiService.generateText(
                findingsSummarizationPromptTemplate.replace('{text_to_summarize}', allFindingsTextForSummarization),
                { model: (this.aiService.baseConfig?.summarizationModel) || (this.aiService.getServiceName?.() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-pro'), temperature: 0.3, maxTokens: 500 }
            );
            return `Summary of Recent Key Findings:\n${summary}`;
        } catch (e) {
            if (finalJournalEntriesInput) finalJournalEntriesInput.push(this._createOrchestratorJournalEntry("KEY_FINDINGS_SUMMARIZATION_FAILED", `Summarization failed: ${e.message}`, { parentTaskId: parentTaskIdForJournal }));
            return "Key findings were too extensive for direct inclusion, and summarization failed.";
        }
    } else {
        findingsTextForPrompt = "Key findings:\n" + findingsToIncludeDirectly.join('---\n');
        return findingsTextForPrompt.trim();
    }
  }

  async handleUserTask(userTaskString, uploadedFiles = [], parentTaskId, taskIdToLoad = null, executionMode = "EXECUTE_FULL_PLAN") {
    const MAX_ERRORS_FOR_CWC_PROMPT = 3;
    const DEFAULT_MEGA_CONTEXT_TTL = 3600;
    const CHAT_HISTORY_LIMIT = 20;
    const DEFAULT_GEMINI_CACHED_CONTENT_TTL = 3600;
    const MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE = 1024; // Min tokens in megaContext to attempt Gemini caching

    const initialJournalEntries = [];
    initialJournalEntries.push(this._createOrchestratorJournalEntry(
        "TASK_RECEIVED", `Task received. Mode: ${executionMode}`,
        { parentTaskId, userTaskStringPreview: userTaskString?.substring(0, 200) + '...' , uploadedFileCount: uploadedFiles.length, taskIdToLoad, executionMode }
    ));
    console.log(`OrchestratorAgent: Received task: '${userTaskString?.substring(0,100)+'...'}', uploadedFiles: ${uploadedFiles.length}, parentTaskId: ${parentTaskId}, taskIdToLoad: ${taskIdToLoad}, mode: ${executionMode}`);

    let currentWorkingContext = {
        lastUpdatedAt: new Date().toISOString(), summaryOfProgress: "Task processing initiated.",
        identifiedEntities: {}, pendingQuestions: [], nextObjective: "Define execution plan or synthesize based on mode.",
        confidenceScore: 0.7,
    };
    initialJournalEntries.push(this._createOrchestratorJournalEntry("CWC_INITIALIZED", "CWC initialized.", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));

    let finalJournalEntries = [...initialJournalEntries];
    let executionResult = { success: false, executionContext: [], journalEntries: [], updatesForWorkingContext: { keyFindings: [], errorsEncountered: [] } };
    let planStages = [];
    let loadedState = null;
    let currentOriginalTask = userTaskString;
    let planResult = null;

    const baseSavedTasksPath = path.join(__dirname, '..', 'saved_tasks');
    const date = new Date();
    const dateString = `${(date.getMonth() + 1).toString().padStart(2, '0')}${(date.getDate()).toString().padStart(2, '0')}${date.getFullYear()}`;
    const datedTasksDirPath = path.join(baseSavedTasksPath, `tasks_${dateString}`);
    const taskDirPath = path.join(datedTasksDirPath, parentTaskId);

    const stateFilePath = path.join(taskDirPath, `task_state.json`);
    const journalFilePath = path.join(taskDirPath, `journal.json`);

    try {
        await fsp.mkdir(taskDirPath, { recursive: true });
        await this.memoryManager.initializeTaskMemory(taskDirPath);

        if (userTaskString && userTaskString.trim() !== '') {
            try {
                await this.memoryManager.addChatMessage(taskDirPath, { role: 'user', content: userTaskString });
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_MESSAGE_LOGGED", "Initial user task logged.", { parentTaskId, role: 'user' }));
            } catch (logError) {
                console.warn(`Failed to log initial user message: ${logError.message}`);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_MESSAGE_LOG_FAILED", `Failed to log initial user message: ${logError.message}`, { parentTaskId }));
            }
        }

        let tokenizerFn;
        let maxTokenLimitForContextAssembly;
        try {
            tokenizerFn = this.aiService?.getTokenizer?.() || ((text) => text ? Math.ceil(text.length / 4) : 0);
            maxTokenLimitForContextAssembly = this.aiService?.getMaxContextTokens?.() || 4096;
            if (!this.aiService?.getTokenizer || !this.aiService?.getMaxContextTokens) {
                console.warn("OrchestratorAgent: aiService tokenizer/maxTokens methods not fully available. Using placeholders.");
            }
        } catch (serviceError) {
            console.error(`Error obtaining tokenizer/maxTokens: ${serviceError.message}. Using placeholders.`);
            finalJournalEntries.push(this._createOrchestratorJournalEntry("AISERVICE_CONFIG_ERROR", `Error getting tokenizer/maxTokens: ${serviceError.message}`, { parentTaskId }));
            tokenizerFn = (text) => text ? Math.ceil(text.length / 4) : 0;
            maxTokenLimitForContextAssembly = 4096;
        }

        const initialTaskDefinitionContent = userTaskString || (taskIdToLoad ? "Task definition will be loaded." : "No initial task string provided.");
        await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', initialTaskDefinitionContent);

        const savedUploadedFilePaths = [];
        if (uploadedFiles && uploadedFiles.length > 0) {
            const uploadedFilesDir = path.join('uploaded_files');
            finalJournalEntries.push(this._createOrchestratorJournalEntry("SAVING_UPLOADED_FILES", `Saving ${uploadedFiles.length} files.`, { parentTaskId, count: uploadedFiles.length }));
            for (const file of uploadedFiles) {
                try {
                    const safeFileName = path.basename(file.name);
                    const relativeFilePath = path.join(uploadedFilesDir, safeFileName);
                    await this.memoryManager.overwriteMemory(taskDirPath, relativeFilePath, file.content);
                    savedUploadedFilePaths.push(relativeFilePath);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_SUCCESS", `Saved: ${relativeFilePath}`, { parentTaskId, fileName: file.name }));
                } catch (uploadError) {
                    console.error(`Error saving uploaded file '${file.name}': ${uploadError.message}`);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_ERROR", `Error saving ${file.name}: ${uploadError.message}`, { parentTaskId, fileName: file.name }));
                }
            }
        }
        await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });

        // ... [SYNTHESIZE_ONLY and EXECUTE_PLANNED_TASK logic remains largely the same as it doesn't involve new planning/context assembly] ...
        if (executionMode === "SYNTHESIZE_ONLY") {
             if (!taskIdToLoad) return { success: false, message: "taskIdToLoad is required for SYNTHESIZE_ONLY mode." };
            const loadResult = await loadTaskState(path.join(path.join(datedTasksDirPath, taskIdToLoad), 'task_state.json'));
            if (!loadResult.success || !loadResult.taskState) return { success: false, message: "Failed to load state for SYNTHESIZE_ONLY."};
            loadedState = loadResult.taskState;
            currentOriginalTask = loadedState.userTaskString;
            const synthesisPrompt = `Original task: "${currentOriginalTask}". Execution context: ${JSON.stringify(loadedState.executionContext)}. Synthesize the final answer.`;
            const finalAnswer = await this.aiService.generateText(synthesisPrompt, { model: (this.aiService.baseConfig?.synthesisModel) || 'gpt-4' });
            return { success: true, finalAnswer, originalTask: currentOriginalTask, executedPlan: loadedState.executionContext, plan: loadedState.plan, currentWorkingContext: loadedState.currentWorkingContext };
        }
        if (executionMode === "EXECUTE_PLANNED_TASK") {
            if (!taskIdToLoad) return { success: false, message: "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode." };
            const loadResult = await loadTaskState(path.join(path.join(datedTasksDirPath, taskIdToLoad), 'task_state.json'));
            if (!loadResult.success || !loadResult.taskState || !loadResult.taskState.plan || loadResult.taskState.plan.length === 0) {
                 return { success: false, message: "Failed to load state or no plan found for EXECUTE_PLANNED_TASK."};
            }
            loadedState = loadResult.taskState;
            currentOriginalTask = userTaskString || loadedState.userTaskString;
            planStages = loadedState.plan;
            if(loadedState.currentWorkingContext) currentWorkingContext = loadedState.currentWorkingContext;
        }


        if (executionMode === "EXECUTE_FULL_PLAN" || (executionMode === "PLAN_ONLY" )) {
            finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan.", { parentTaskId, executionMode }));
            const knownAgentRoles = (this.workerAgentCapabilities || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (this.workerAgentCapabilities || []).forEach(agent => { knownToolsByRole[agent.role] = agent.tools.map(t => t.name); });

            memoryContextForPlanning = {};
            try {
                memoryContextForPlanning.taskDefinition = await this.memoryManager.loadMemory(taskDirPath, 'task_definition.md', { defaultValue: currentOriginalTask });
                let chatHistoryForPlanning = [];
                try {
                    chatHistoryForPlanning = await this.memoryManager.getChatHistory(taskDirPath, CHAT_HISTORY_LIMIT);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCHED", `Fetched ${chatHistoryForPlanning.length} for planning.`, { parentTaskId }));
                } catch (err) { finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCH_FAILED", `Failed for planning: ${err.message}`, { parentTaskId })); }

                const contextSpecificationForPlanning = {
                    systemPrompt: "You are an AI assistant responsible for planning complex tasks...",
                    includeTaskDefinition: true, uploadedFilePaths: savedUploadedFilePaths, maxLatestKeyFindings: 5,
                    chatHistory: chatHistoryForPlanning, maxTokenLimit: maxTokenLimitForContextAssembly,
                    customPreamble: "Контекст для первоначального планирования:",
                    enableMegaContextCache: true, megaContextCacheTTLSeconds: DEFAULT_MEGA_CONTEXT_TTL,
                };
                const megaContextResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForPlanning, tokenizerFn);

                if (megaContextResult.success) {
                    memoryContextForPlanning.megaContext = megaContextResult.contextString;
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", `Mega context for planning: ${megaContextResult.tokenCount} tokens.`, { parentTaskId, fromCache: megaContextResult.fromCache }));

                    let geminiCachedContentName = null;
                    if (this.aiService.getServiceName?.() === 'GeminiService' && typeof this.aiService.createCachedContent === 'function') {
                        const planningModelName = (this.aiService.baseConfig?.planningModel) || (this.aiService.defaultModel) || 'gemini-1.5-pro-latest';
                        const supportedCacheModels = ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest'];
                        if (supportedCacheModels.includes(planningModelName) && megaContextResult.tokenCount >= MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE) {
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ATTEMPT", `Attempting Gemini CachedContent for planning model ${planningModelName}.`, { parentTaskId }));
                            try {
                                const megaContextHash = crypto.createHash('sha256').update(megaContextResult.contextString).digest('hex');
                                const geminiCacheMap = await this.memoryManager.loadGeminiCachedContentMap(taskDirPath);
                                let existingCacheInfo = geminiCacheMap[megaContextHash];

                                // Check if the cache entry has expired using the server-provided expireTime.
                                if (existingCacheInfo?.modelName === planningModelName && existingCacheInfo.expireTime && Date.now() < new Date(existingCacheInfo.expireTime).getTime()) {
                                    geminiCachedContentName = existingCacheInfo.cachedContentName;
                                    finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_HIT", `Using existing Gemini CachedContent: ${geminiCachedContentName} (Expires: ${existingCacheInfo.expireTime})`, { parentTaskId }));
                                } else {
                                    if(existingCacheInfo) finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_EXPIRED", `Gemini CachedContent for planning (Hash: ${megaContextHash}, ExpireTime: ${existingCacheInfo.expireTime}) expired or invalid. Will recreate.`, { parentTaskId }));
                                    const contentsForCache = [{ role: "user", parts: [{ text: megaContextResult.contextString }] }];
                                    const newCachedContent = await this.aiService.createCachedContent({
                                        modelName: planningModelName, contents: contentsForCache, systemInstruction: contextSpecificationForPlanning.systemPrompt,
                                        ttlSeconds: DEFAULT_GEMINI_CACHED_CONTENT_TTL, displayName: `mega_ctx_plan_${parentTaskId.substring(0,8)}_${megaContextHash.substring(0,8)}`
                                    });
                                    if (newCachedContent?.name && newCachedContent.expireTime) {
                                        geminiCachedContentName = newCachedContent.name;
                                        // Store metadata for the new Gemini CachedContent in the map.
                                        // `expireTime` is provided by the Gemini API and is the authoritative source for cache expiration.
                                        geminiCacheMap[megaContextHash] = {
                                            cachedContentName: newCachedContent.name,
                                            modelName: newCachedContent.model || planningModelName,
                                            expireTime: newCachedContent.expireTime,
                                            createTime: newCachedContent.createTime, // For reference
                                            // requestedTtlSeconds: DEFAULT_GEMINI_CACHED_CONTENT_TTL, // Optional: for reference if needed
                                            originalContextTokenCount: megaContextResult.tokenCount
                                        };
                                        await this.memoryManager.saveGeminiCachedContentMap(taskDirPath, geminiCacheMap);
                                        finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_CREATED", `Created Gemini CachedContent for planning: ${geminiCachedContentName} (Expires: ${newCachedContent.expireTime})`, { parentTaskId }));
                                    } else throw new Error("Failed to create Gemini CachedContent or received invalid/incomplete response (missing name or expireTime).");
                                }
                            } catch (cacheError) { console.warn(`Error with Gemini CachedContent for planning: ${cacheError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ERROR", `Planning cache error: ${cacheError.message}`, { parentTaskId })); geminiCachedContentName = null; }
                        } else { /* Log skip reason for unsupported model or low token count */ }
                    }
                    if (geminiCachedContentName) {
                        memoryContextForPlanning.geminiCachedContentName = geminiCachedContentName;
                        memoryContextForPlanning.isMegaContextCachedByGemini = true;
                    }
                } else { finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `Planning: ${megaContextResult.error}`, { parentTaskId }));}

                 const decisionsPromptTemplate = `The following text is a log of key decisions...`;
                 const summarizationLlmParams = { model: (this.aiService.baseConfig?.summarizationModel) || 'gpt-3.5-turbo', temperature: 0.3, maxTokens: 500 };
                 const decisionsFromMemory = await this.memoryManager.getSummarizedMemory(taskDirPath, 'key_decisions_and_learnings.md', this.aiService, { maxOriginalLength: 3000, promptTemplate: decisionsPromptTemplate, llmParams: summarizationLlmParams, cacheSummary: true, defaultValue: "" });
                 if (decisionsFromMemory?.trim()) memoryContextForPlanning.retrievedKeyDecisions = decisionsFromMemory;
                 if (executionMode !== "EXECUTE_FULL_PLAN" || taskIdToLoad) {
                    const cwcSnapshotFromMemory = await this.memoryManager.loadMemory(taskDirPath, 'current_working_context.json', { isJson: true, defaultValue: null });
                    if (cwcSnapshotFromMemory) memoryContextForPlanning.retrievedCwcSnapshot = cwcSnapshotFromMemory;
                 }

            } catch (memError) { console.warn(`Error preparing planning context: ${memError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_CONTEXT_ERROR", `Planning context prep: ${memError.message}`, { parentTaskId })); }

            planResult = await this.planManager.getPlan(currentOriginalTask, knownAgentRoles, knownToolsByRole, memoryContextForPlanning, currentWorkingContext);
             if (!planResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", `Planning failed: ${planResult.message}`, { parentTaskId, error: planResult.message }));
                return { success: false, message: planResult.message, taskId: parentTaskId, originalTask: currentOriginalTask, rawResponse: planResult.rawResponse };
            }
            planStages = planResult.plan;
            finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", `Plan obtained. Stages: ${planStages.length}`, { parentTaskId, source: planResult.source }));
            await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
        }
        if (executionMode === "PLAN_ONLY") {
            return { success: true, message: "Plan generated and saved.", taskId: parentTaskId, originalTask: currentOriginalTask, plan: planStages, currentWorkingContext };
        }

        if (executionMode === "EXECUTE_FULL_PLAN" || executionMode === "EXECUTE_PLANNED_TASK") {
        // ... (execution loop)
        }

        if (executionMode === "EXECUTE_FULL_PLAN" || executionMode === "EXECUTE_PLANNED_TASK") {
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_START", "Attempting LLM update for CWC.", { parentTaskId }));
            let chatHistoryForCwc = [];
            try {
                chatHistoryForCwc = await this.memoryManager.getChatHistory(taskDirPath, CHAT_HISTORY_LIMIT);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCHED", `Fetched ${chatHistoryForCwc.length} for CWC.`, { parentTaskId }));
            } catch (err) { finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCH_FAILED", `CWC history: ${err.message}`, { parentTaskId })); }

            const summarizedKeyFindingsTextForCwc = await this._getSummarizedKeyFindingsForPrompt(parentTaskId, finalJournalEntries, taskDirPath, 10);
            const recentErrorsForCwcUpdate = await this.memoryManager.getLatestErrorsEncountered(taskDirPath, MAX_ERRORS_FOR_CWC_PROMPT);
            const recentErrorsSummary = recentErrorsForCwcUpdate.map(e => ({ narrative: e.sourceStepNarrative, tool: e.sourceToolName, error: e.errorMessage }));

            const contextSpecificationForCwcUpdate = {
                systemPrompt: "You are an expert system analyzing task progress...",
                includeTaskDefinition: true, uploadedFilePaths: savedUploadedFilePaths, maxLatestKeyFindings: 10,
                includeRawContentForReferencedFindings: true, chatHistory: chatHistoryForCwc,
                maxTokenLimit: maxTokenLimitForContextAssembly || 4096, customPreamble: "Контекст для обновления CWC:",
                currentProgressSummary: currentWorkingContext.summaryOfProgress, currentNextObjective: currentWorkingContext.nextObjective,
                recentErrorsSummary: recentErrorsSummary, summarizedKeyFindingsText: summarizedKeyFindingsTextForCwc,
                overallExecutionSuccess: overallSuccess, enableMegaContextCache: true, megaContextCacheTTLSeconds: DEFAULT_MEGA_CONTEXT_TTL,
                priorityOrder: [ 'systemPrompt', 'taskDefinition', 'currentProgressSummary', 'currentNextObjective', 'overallExecutionSuccess', 'summarizedKeyFindingsText', 'recentErrorsSummary', 'chatHistory', 'uploadedFilePaths']
            };
            const megaContextCwcResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForCwcUpdate, tokenizerFn);

            let cwcUpdatePromptString;
            const cwcUpdateModelName = (this.aiService.baseConfig?.cwcUpdateModel) || (this.aiService.getServiceName?.() === 'OpenAI' ? 'gpt-3.5-turbo' : 'gemini-1.5-pro-latest');
            const cwcLlmParams = { model: cwcUpdateModelName };
            let geminiCachedContentNameForCwc = null;

            if (megaContextCwcResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", `CWC Context: ${megaContextCwcResult.tokenCount} tokens.`, { parentTaskId, fromCache: megaContextCwcResult.fromCache }));
                if (this.aiService.getServiceName?.() === 'GeminiService' && typeof this.aiService.createCachedContent === 'function') {
                    const supportedCacheModels = ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest'];
                    if (supportedCacheModels.includes(cwcUpdateModelName) && megaContextCwcResult.tokenCount >= MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE) {
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ATTEMPT_CWC", `Attempting Gemini CachedContent for CWC model ${cwcUpdateModelName}.`, { parentTaskId }));
                        try {
                            const megaContextCwcHash = crypto.createHash('sha256').update(megaContextCwcResult.contextString).digest('hex');
                            const geminiCacheMap = await this.memoryManager.loadGeminiCachedContentMap(taskDirPath);
                            let existingCacheInfo = geminiCacheMap[megaContextCwcHash];
                            // Check if the cache entry has expired using the server-provided expireTime.
                            if (existingCacheInfo?.modelName === cwcUpdateModelName && existingCacheInfo.expireTime && Date.now() < new Date(existingCacheInfo.expireTime).getTime()) {
                                geminiCachedContentNameForCwc = existingCacheInfo.cachedContentName;
                                finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_HIT_CWC", `Using Gemini CachedContent for CWC: ${geminiCachedContentNameForCwc} (Expires: ${existingCacheInfo.expireTime})`, { parentTaskId }));
                            } else {
                                if(existingCacheInfo) finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_EXPIRED_CWC", `Expired CWC cache (Hash: ${megaContextCwcHash}, ExpireTime: ${existingCacheInfo.expireTime}). Will recreate.`, { parentTaskId }));
                                const contentsForCache = [{ role: "user", parts: [{ text: megaContextCwcResult.contextString }] }];
                                const newCachedContent = await this.aiService.createCachedContent({
                                    modelName: cwcUpdateModelName, contents: contentsForCache, systemInstruction: contextSpecificationForCwcUpdate.systemPrompt,
                                    ttlSeconds: DEFAULT_GEMINI_CACHED_CONTENT_TTL, displayName: `mega_ctx_cwc_${parentTaskId.substring(0,8)}_${megaContextCwcHash.substring(0,8)}`
                                });
                                if (newCachedContent?.name && newCachedContent.expireTime) {
                                    geminiCachedContentNameForCwc = newCachedContent.name;
                                    // Store metadata for the new Gemini CachedContent in the map.
                                    // `expireTime` is provided by the Gemini API and is the authoritative source for cache expiration.
                                    geminiCacheMap[megaContextCwcHash] = {
                                        cachedContentName: newCachedContent.name, modelName: newCachedContent.model || cwcUpdateModelName,
                                        expireTime: newCachedContent.expireTime, createTime: newCachedContent.createTime,
                                        originalContextTokenCount: megaContextCwcResult.tokenCount
                                    };
                                    await this.memoryManager.saveGeminiCachedContentMap(taskDirPath, geminiCacheMap);
                                    finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_CREATED_CWC", `Created Gemini CachedContent for CWC: ${geminiCachedContentNameForCwc} (Expires: ${newCachedContent.expireTime})`, { parentTaskId }));
                                } else throw new Error("Failed to create Gemini CachedContent for CWC or missing expireTime.");
                            }
                        } catch (cacheError) { console.warn(`Error with Gemini CachedContent for CWC: ${cacheError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ERROR_CWC", `CWC cache error: ${cacheError.message}`, { parentTaskId })); geminiCachedContentNameForCwc = null; }
                    } else { /* Log CWC cache skip if model not supported or low token count */ }
                }
                if (geminiCachedContentNameForCwc) {
                    cwcLlmParams.cachedContentName = geminiCachedContentNameForCwc;
                    cwcUpdatePromptString = `Based on the extensive context provided (now cached), provide an updated summary of progress...`;
                } else {
                    cwcUpdatePromptString = `${megaContextCwcResult.contextString}\n\nBased on all the provided context, provide an updated summary...`;
                }
            } else {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `CWC Update: ${megaContextCwcResult.error}. Fallback.`, { parentTaskId }));
                cwcUpdatePromptString = `The overall user task is: "${currentOriginalTask}".\nPrevious summary: "${currentWorkingContext.summaryOfProgress}"...\nBased on this, provide an updated summary...`;
            }
            cwcUpdatePromptString += `\nReturn ONLY a JSON object with two keys: "updatedSummaryOfProgress" (string) and "updatedNextObjective" (string).\nExample: { "updatedSummaryOfProgress": "Data gathered...", "updatedNextObjective": "Synthesize findings..." }`;

            try {
                const cwcUpdateResponse = await this.aiService.generateText(cwcUpdatePromptString, cwcLlmParams);
                 const parsedCwcUpdate = JSON.parse(cwcUpdateResponse);
                if (parsedCwcUpdate && parsedCwcUpdate.updatedSummaryOfProgress && parsedCwcUpdate.updatedNextObjective) {
                    currentWorkingContext.summaryOfProgress = parsedCwcUpdate.updatedSummaryOfProgress;
                    currentWorkingContext.nextObjective = parsedCwcUpdate.updatedNextObjective;
                    await this.memoryManager.overwriteMemory(taskDirPath, 'current_working_context.json', currentWorkingContext, { isJson: true });
                } else throw new Error("LLM CWC update response missing fields.");
            } catch (cwcLlmError) { console.error(`Error updating CWC with LLM: ${cwcLlmError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_ERROR", `LLM CWC update failed: ${cwcLlmError.message}`, { parentTaskId }));}
        }

        let finalAnswer = null;
        let responseMessage = "";
        if (wasFinalAnswerPreSynthesized) {
            // ...
        } else if (overallSuccess && lastExecutionContext && lastExecutionContext.length > 0) {
             if (contextForLLMSynthesis.every(e => e.status === "FAILED" || (e.status === "COMPLETED" && !e.outcome_data))) {
                // ...
            } else {
                let chatHistoryForSynthesis = [];
                try {
                    chatHistoryForSynthesis = await this.memoryManager.getChatHistory(taskDirPath, CHAT_HISTORY_LIMIT);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCHED", `Fetched ${chatHistoryForSynthesis.length} for synthesis.`, { parentTaskId }));
                } catch (err) { finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_HISTORY_FETCH_FAILED", `Synthesis history: ${err.message}`, { parentTaskId }));}

                const contextSpecificationForSynthesis = {
                    systemPrompt: "You are an expert system synthesizing the final answer...",
                    includeTaskDefinition: true, uploadedFilePaths: savedUploadedFilePaths, maxLatestKeyFindings: 20,
                    includeRawContentForReferencedFindings: true, chatHistory: chatHistoryForSynthesis,
                    maxTokenLimit: maxTokenLimitForContextAssembly || 8192, customPreamble: "Контекст для финального ответа:",
                    originalUserTask: currentOriginalTask, executionContext: lastExecutionContext,
                    currentWorkingContextSummary: currentWorkingContext.summaryOfProgress,
                    summarizedKeyFindingsText: summarizedKeyFindingsTextForCwc, recentErrorsSummary: recentErrorsSummary,
                    enableMegaContextCache: true, megaContextCacheTTLSeconds: DEFAULT_GEMINI_CACHED_CONTENT_TTL,
                    priorityOrder: [ 'systemPrompt', 'originalUserTask', 'chatHistory', 'executionContext', 'summarizedKeyFindingsText', 'recentErrorsSummary', 'currentWorkingContextSummary', 'taskDefinition', 'uploadedFilePaths']
                };
                const megaContextSynthesisResult = await this.memoryManager.assembleMegaContext(taskDirPath, contextSpecificationForSynthesis, tokenizerFn);

                let synthesisPromptString;
                const synthesisModelName = (this.aiService.baseConfig?.synthesisModel) || (this.aiService.getServiceName?.() === 'OpenAI' ? 'gpt-4' : 'gemini-1.5-pro-latest');
                const synthLlmParams = { model: synthesisModelName };
                let geminiCachedContentNameForSynthesis = null;

                if (megaContextSynthesisResult.success) {
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", `Synthesis Context: ${megaContextSynthesisResult.tokenCount} tokens.`, { parentTaskId, fromCache: megaContextSynthesisResult.fromCache }));
                    if (this.aiService.getServiceName?.() === 'GeminiService' && typeof this.aiService.createCachedContent === 'function') {
                        const supportedCacheModels = ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest'];
                        if (supportedCacheModels.includes(synthesisModelName) && megaContextSynthesisResult.tokenCount >= MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE) {
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ATTEMPT_SYNTH", `Attempting Gemini CachedContent for synthesis model ${synthesisModelName}.`, { parentTaskId }));
                            try {
                                const megaContextSynthHash = crypto.createHash('sha256').update(megaContextSynthesisResult.contextString).digest('hex');
                                const geminiCacheMap = await this.memoryManager.loadGeminiCachedContentMap(taskDirPath);
                                let existingCacheInfo = geminiCacheMap[megaContextSynthHash];
                                // Check if the cache entry has expired using the server-provided expireTime.
                                if (existingCacheInfo?.modelName === synthesisModelName && existingCacheInfo.expireTime && Date.now() < new Date(existingCacheInfo.expireTime).getTime()) {
                                    geminiCachedContentNameForSynthesis = existingCacheInfo.cachedContentName;
                                    finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_HIT_SYNTH", `Using Gemini CachedContent for synthesis: ${geminiCachedContentNameForSynthesis} (Expires: ${existingCacheInfo.expireTime})`, { parentTaskId }));
                                } else {
                                     if(existingCacheInfo) finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_EXPIRED_SYNTH", `Expired synthesis cache (Hash: ${megaContextSynthHash}, ExpireTime: ${existingCacheInfo.expireTime}). Will recreate.`, { parentTaskId }));
                                    const contentsForCache = [{ role: "user", parts: [{ text: megaContextSynthesisResult.contextString }] }];
                                    const newCachedContent = await this.aiService.createCachedContent({
                                        modelName: synthesisModelName, contents: contentsForCache, systemInstruction: contextSpecificationForSynthesis.systemPrompt,
                                        ttlSeconds: DEFAULT_GEMINI_CACHED_CONTENT_TTL, displayName: `mega_ctx_synth_${parentTaskId.substring(0,8)}_${megaContextSynthHash.substring(0,8)}`
                                    });
                                    if (newCachedContent?.name && newCachedContent.expireTime) {
                                        geminiCachedContentNameForSynthesis = newCachedContent.name;
                                        // Store metadata for the new Gemini CachedContent in the map.
                                        // `expireTime` is provided by the Gemini API and is the authoritative source for cache expiration.
                                        geminiCacheMap[megaContextSynthHash] = {
                                            cachedContentName: newCachedContent.name, modelName: newCachedContent.model || synthesisModelName,
                                            expireTime: newCachedContent.expireTime, createTime: newCachedContent.createTime,
                                            originalContextTokenCount: megaContextSynthesisResult.tokenCount
                                        };
                                        await this.memoryManager.saveGeminiCachedContentMap(taskDirPath, geminiCacheMap);
                                        finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_CREATED_SYNTH", `Created Gemini CachedContent for synthesis: ${geminiCachedContentNameForSynthesis} (Expires: ${newCachedContent.expireTime})`, { parentTaskId }));
                                    } else throw new Error("Failed to create Gemini CachedContent for synthesis or missing expireTime.");
                                }
                            } catch (cacheError) { console.warn(`Error with Gemini CachedContent for synthesis: ${cacheError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("GEMINI_CACHE_ERROR_SYNTH", `Synthesis cache error: ${cacheError.message}`, { parentTaskId })); geminiCachedContentNameForSynthesis = null; }
                        } else { /* Log synthesis cache skip */ }
                    }
                    if (geminiCachedContentNameForSynthesis) {
                        synthLlmParams.cachedContentName = geminiCachedContentNameForSynthesis;
                        synthesisPromptString = `Based on the extensive context provided (now cached), synthesize a comprehensive answer for the original user task: "${currentOriginalTask}".`;
                    } else {
                        synthesisPromptString = `${megaContextSynthesisResult.contextString}\n\nBased on all the provided context, synthesize a comprehensive answer...`;
                    }
                } else {
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", `Synthesis: ${megaContextSynthesisResult.error}. Fallback.`, { parentTaskId }));
                    synthesisPromptString = `The original user task was: "${currentOriginalTask}".\nExecution History (JSON Array):\n${synthesisContextString}\n Current Working Context Summary:\nProgress: ${currentWorkingContext.summaryOfProgress}\nNext Objective: ${currentWorkingContext.nextObjective}\nKey Findings (Summarized):\n${summarizedKeyFindingsTextForCwc}\nErrors Encountered (Last ${MAX_ERRORS_FOR_CWC_PROMPT}):\n${JSON.stringify(recentErrorsSummary,null,2)}\n---\nBased on the original user task, execution history, and current working context, synthesize a comprehensive answer.`;
                }
                 synthesisPromptString += `\nSynthesize a comprehensive answer for the original user task: "${currentOriginalTask}".`;

                try {
                    finalAnswer = await this.aiService.generateText(synthesisPromptString, synthLlmParams);
                     responseMessage = "Task completed and final answer synthesized.";
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SUCCESS", responseMessage, { parentTaskId }));
                } catch (synthError) {
                    responseMessage = "Synthesis failed: " + synthError.message;
                    finalAnswer = "Error during final answer synthesis.";
                    overallSuccess = false;
                }
            }
        } else { /* ... other conditions for finalAnswer ... */ }

        if (finalAnswer && (typeof finalAnswer === 'string' && finalAnswer.trim() !== '')) {
            try {
                await this.memoryManager.addChatMessage(taskDirPath, { role: 'assistant', content: finalAnswer });
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_MESSAGE_LOGGED", "Agent's final answer logged.", { parentTaskId }));
            } catch (logError) { console.warn(`Failed to log agent's final answer: ${logError.message}`); finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_MESSAGE_LOG_FAILED", `Failed to log agent final answer: ${logError.message}`, { parentTaskId }));}
        }
        await saveTaskState(stateFilePath, taskStateToSave);
        finalJournalEntries.push(this._createOrchestratorJournalEntry(overallSuccess ? "TASK_COMPLETED_SUCCESSFULLY" : "TASK_FAILED_FINAL", `Task processing finished. Success: ${overallSuccess}`, { parentTaskId, finalStatus: taskStateToSave.status }));
        await saveTaskJournal(journalFilePath, finalJournalEntries);
        return { success: overallSuccess, message: responseMessage, originalTask: currentOriginalTask, plan: planStages, executedPlan: executionContext, finalAnswer, currentWorkingContext };

    } catch (error) { /* ... existing catch block ... */ }
  }
}

module.exports = OrchestratorAgent;
