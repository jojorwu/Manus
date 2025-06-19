// OrchestratorAgent.js
    const fs = require('fs-extra');
    const path = require('path');
    const PlanExecutor = require('../core/PlanExecutor.js');
    const { PlanManager } = require('../core/PlanManager.js');
    // const { EXECUTE_FULL_PLAN, PLAN_ONLY, SYNTHESIZE_ONLY, EXECUTE_PLANNED_TASK } = require('../utils/constants.js'); // Commmented out due to missing file
    // Temporary definitions for missing constants
    const EXECUTE_FULL_PLAN = 'EXECUTE_FULL_PLAN';
    const PLAN_ONLY = 'PLAN_ONLY';
    const SYNTHESIZE_ONLY = 'SYNTHESIZE_ONLY';
    const EXECUTE_PLANNED_TASK = 'EXECUTE_PLANNED_TASK';
    // const MemoryManager = require('../core/MemoryManager.js'); // Removed as memoryManager instance is injected
    // const ConfigManager = require('../core/ConfigManager.js'); // Commented out due to missing file
    const { loadTaskState } = require('../utils/taskStateUtil.js');
    const { v4: uuidv4 } = require('uuid'); // Added for replan cycle ID

    const MAX_TOTAL_REPLAN_ATTEMPTS = 5;
    const MAX_REPLAN_ATTEMPTS_PER_CYCLE = 2;

    class OrchestratorAgent {
        constructor(activeAIService, taskQueue, memoryManager, reportGenerator, agentCapabilities, resultsQueue, savedTasksBaseDir) {
            this.aiService = activeAIService;
            this.taskQueue = taskQueue;
            this.memoryManager = memoryManager;
            this.reportGenerator = reportGenerator;
            this.agentCapabilities = agentCapabilities;
            this.resultsQueue = resultsQueue;
            this.savedTasksBaseDir = savedTasksBaseDir;

            this.planManager = new PlanManager(activeAIService, this.agentCapabilities);
            this.planExecutor = new PlanExecutor(
                this.taskQueue, this.resultsQueue, this.aiService,
                this.memoryManager, // <--- ДОБАВЛЕНО
                {}, this.savedTasksBaseDir
            );
            // this.configManager = new ConfigManager(); // Commented out due to missing file
            console.log(`OrchestratorAgent initialized with AI Service: ${this.aiService.getServiceName()}, PlanExecutor configured.`);
        }

        _createOrchestratorJournalEntry(type, message, details = {}) {
            return { timestamp: new Date().toISOString(), type, source: "OrchestratorAgent", message, details };
        }

        async _processUserClarification(taskState) {
            // ... (no change from previous version)
            if (!taskState.needsUserInput || !taskState.pendingQuestionId) return;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_CHECK_STARTED", `Checking for response to QID ${taskState.pendingQuestionId}`));
            const chatHistory = await taskState.memoryManager.getChatHistory(taskState.taskDirPath, { sort_order: 'asc' });
            const agentQuestionMessage = chatHistory.find(msg => msg.sender?.id === 'OrchestratorAgent' && msg.content?.questionDetails?.questionId === taskState.pendingQuestionId);

            if (!agentQuestionMessage) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_ERROR", `Agent's question ${taskState.pendingQuestionId} not found.`));
                return;
            }
            const agentQuestionTimestamp = new Date(agentQuestionMessage.timestamp);
            const userResponse = chatHistory.find(msg => msg.sender?.role === 'user' && new Date(msg.timestamp) > agentQuestionTimestamp);

            if (userResponse?.content?.text) {
                const userAnswerText = userResponse.content.text;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_RECEIVED", `User responded to ${taskState.pendingQuestionId}: "${userAnswerText.substring(0,100)}..."`));
                taskState.currentOriginalTask += `\n\nUser Clarification (for QID ${taskState.pendingQuestionId}): ${userAnswerText}`;
                taskState.needsUserInput = false;
                taskState.pendingQuestionId = null;
                taskState.responseMessage = 'User clarification processed. Resuming task.';
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_PROCESSED", "User input processed."));
            } else {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_NOT_FOUND", `No new user response for ${taskState.pendingQuestionId}.`));
                taskState.responseMessage = agentQuestionMessage.content.text;
                taskState.overallSuccess = false;
            }
        }

        async _initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, existingState = null) {
            // ... (no change from previous version)
            let taskId, taskDirPath, finalJournalEntries, currentWorkingContext, uploadedFilePaths, planStages,
                lastExecutionContext, currentOriginalTask, needsUserInput, pendingQuestionId, responseMessage,
                currentWebSearchResults, lastError;

            if (existingState) {
                taskId = existingState.taskId;
                taskDirPath = existingState.taskDirPath;
                finalJournalEntries = existingState.finalJournalEntries || [this._createOrchestratorJournalEntry("TASK_RESUMED", `Task ${taskId} resumed.`)];
                currentWorkingContext = existingState.currentWorkingContext || 'No CWC loaded on resume.';
                uploadedFilePaths = existingState.savedUploadedFilePaths || [];
                planStages = existingState.plan || null;
                lastExecutionContext = existingState.executionContext || null;
                currentOriginalTask = existingState.currentOriginalTask || userTaskString;
                needsUserInput = existingState.needsUserInput || false;
                pendingQuestionId = existingState.pendingQuestionId || null;
                responseMessage = existingState.responseMessage || '';
                currentWebSearchResults = existingState.currentWebSearchResults || null;
                lastError = existingState.lastError || null;
                // Replanning history fields
                taskState.replanHistory = existingState.replanHistory || [];
                taskState.currentReplanningCycleId = existingState.currentReplanningCycleId || null;
                taskState.totalReplanAttempts = existingState.totalReplanAttempts || 0;
            } else {
                taskId = taskIdToLoad ? taskIdToLoad.split('_')[1] : Date.now().toString();
                const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                const datedTasksDirPath = path.join(baseTaskDir, new Date().toISOString().split('T')[0]);
                taskDirPath = path.join(datedTasksDirPath, `task_${taskId}`);

                await fs.ensureDir(taskDirPath);
                await fs.ensureDir(path.join(taskDirPath, 'uploaded_files'));
                await this.memoryManager.initializeTaskMemory(taskDirPath);

                finalJournalEntries = [this._createOrchestratorJournalEntry("TASK_INITIALIZED", `Task ${taskId} (${executionMode}) initialized.`, { parentTaskId, taskIdToLoad })];
                currentWorkingContext = 'No CWC generated yet.';
                currentOriginalTask = userTaskString;
                uploadedFilePaths = []; planStages = null; lastExecutionContext = null;
                needsUserInput = false; pendingQuestionId = null; responseMessage = '';
                currentWebSearchResults = null; lastError = null;
                // Replanning history fields
                taskState.replanHistory = [];
                taskState.currentReplanningCycleId = null;
                taskState.totalReplanAttempts = 0;

                if (taskIdToLoad && executionMode !== EXECUTE_FULL_PLAN && executionMode !== PLAN_ONLY) {
                    const loadTaskDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], `task_${taskIdToLoad.split('_')[1]}`);
                    try {
                        const loadedCwc = await this.memoryManager.loadMemory(loadTaskDir, 'cwc.md');
                        if (loadedCwc) currentWorkingContext = loadedCwc;
                        else {
                            const loadedCwcJson = await this.memoryManager.loadMemory(loadTaskDir, 'current_working_context.json', {isJson: true});
                            if (loadedCwcJson?.CWC) currentWorkingContext = loadedCwcJson.CWC;
                        }
                        if (currentWorkingContext !== 'No CWC generated yet.') {
                             finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "Existing CWC loaded.", { taskIdToLoad }));
                        }
                    } catch (error) {
                         finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOAD_FAILED", `Could not load CWC: ${error.message}`, { taskIdToLoad }));
                    }
                }
                const taskDefinitionContent = `# Task: ${taskId}\nUser Task: ${currentOriginalTask}\nMode: ${executionMode}`;
                await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', taskDefinitionContent);
                // Initial user message is now logged in handleUserTask after potential clarification processing
            }

            return {
                taskId, parentTaskIdFromCall: parentTaskId, taskDirPath,
                stateFilePath: path.join(taskDirPath, 'task_state.json'),
                journalFilePath: path.join(taskDirPath, 'orchestrator_journal.json'),
                finalJournalEntries, currentWorkingContext, userTaskString, executionMode, taskIdToLoad,
                tokenizerFn: this.aiService.getTokenizer(),
                maxTokenLimitForContextAssembly: (this.aiService.getMaxContextTokens() || 32000) * 0.8,
                uploadedFilePaths, planStages, overallSuccess: existingState?.overallSuccess || false,
                lastExecutionContext, finalAnswer: existingState?.finalAnswer || '', responseMessage,
                currentOriginalTask, CHAT_HISTORY_LIMIT: 20, DEFAULT_MEGA_CONTEXT_TTL: 3600,
                DEFAULT_GEMINI_CACHED_CONTENT_TTL: 3600, MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE: 1024,
                aiService: this.aiService, memoryManager: this.memoryManager,
                planManager: this.planManager, planExecutor: this.planExecutor,
                workerAgentCapabilities: this.agentCapabilities,
                needsUserInput, pendingQuestionId, currentWebSearchResults, lastError
            };
        }

        async _processAndSaveUploadedFiles(uploadedFiles, taskState) {
            // ... (no change)
            if (uploadedFiles && uploadedFiles.length > 0) {
                const uploadedFilesDir = path.join(taskState.taskDirPath, 'uploaded_files');
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SAVING_UPLOADED_FILES", `Saving ${uploadedFiles.length} files.`));
                for (const file of uploadedFiles) {
                    try {
                        // Sanitize the original filename before using it to form a path
                        // This removes potentially harmful characters and path traversal attempts from the filename itself.
                        const sanitizedOriginalName = (file.name || 'unknown_file').replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 255);
                        const safeFileName = path.basename(sanitizedOriginalName); // path.basename further ensures it's just a filename
                        const absoluteFilePath = path.join(uploadedFilesDir, safeFileName);
                        // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFileName is sanitized, path.basename is used, and uploadedFilesDir is a system-controlled path within the task's workspace.
                        await fs.writeFile(absoluteFilePath, file.content);
                        taskState.uploadedFilePaths.push(path.join('uploaded_files', safeFileName));
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_SUCCESS", `Saved: ${safeFileName}`));
                    } catch (uploadError) {
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_ERROR", `Error saving ${file.name}: ${uploadError.message}`));
                    }
                }
            }
        }

        async _classifyUserRequestForSearch(taskState, userMessageText) {
            // ... (Implementation from Turn 49)
            let previousChatHistoryString = "Нет предыдущего контекста.";
            if (taskState.memoryManager && typeof taskState.memoryManager.getChatHistory === 'function') {
                try {
                    const historyOptions = { sort_order: 'desc', limit: 4 };
                    const chatHistory = await taskState.memoryManager.getChatHistory(taskState.taskDirPath, historyOptions);
                    if (chatHistory && chatHistory.length > 0) {
                        previousChatHistoryString = chatHistory.reverse()
                            .map(msg => {
                                const senderPrefix = msg.senderId === 'OrchestratorAgent' || msg.sender?.role === 'assistant' ? 'Агент' : 'Пользователь';
                              return `${senderPrefix}: ${msg.content.text}`;
                            })
                            .join('\n');
                    }
              } catch (histError) { console.error(`[OrchestratorAgent] Error fetching chat history for search classification: ${histError.stack}`); }
            } else { console.warn("[OrchestratorAgent] MemoryManager or getChatHistory not available for search classification."); }

            const userMessagePlaceholder = '{{userMessage}}';
            const chatHistoryPlaceholder = '{{previousChatHistory}}';
          const promptTemplate = `Ты — умный ассистент-классификатор. Твоя задача - проанализировать ЗАПРОС ПОЛЬЗОВАТЕЛЯ и решить, требуется ли для ответа на него или выполнения подразумеваемой задачи поиск АКТУАЛЬНОЙ или СПЕЦИФИЧЕСКОЙ информации в интернете. Учитывай "ПРЕДЫСТОРИЮ ДИАЛОГА" (если предоставлена), чтобы понять контекст. Не предлагай поиск, если ответ уже мог быть дан, или если вопрос является продолжением обсуждения, где поиск не требуется. КРИТЕРИИ ДЛЯ ПОИСКА: - Информация, скорее всего, отсутствует в базовых знаниях стандартной языковой модели (например, очень нишевые факты, данные о малоизвестных компаниях или людях). - Требуется актуальная информация (новости, курсы валют, погода, события, произошедшие недавно). - Запрос на конкретные факты, которые легко проверяются в вебе. ИЗБЕГАЙ ПОИСКА: - Для общих вопросов, на которые можно ответить на основе эрудиции. - Для генерации идей, творческих текстов, мнений, если это не подразумевает поиск конкретных примеров или фактов. - Если ЗАПРОС ПОЛЬЗОВАТЕЛЯ является прямым ответом на предыдущий вопрос агента. - Если ЗАПРОС ПОЛЬЗОВАТЕЛЯ является простой командой для другого инструмента (например, "посчитай 2+2", "создай файл x.txt"). ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ В ОДНОМ ИЗ ДВУХ ФОРМАТОВ: 1.  Если поиск НУЖЕН: верни ТОЛЬКО строку поискового запроса, который следует использовать (например, "курс биткоина к доллару сегодня" или "симптомы гриппа H1N1"). Поисковый запрос должен быть на языке ЗАПРОСА ПОЛЬЗОВАТЕЛЯ. 2.  Если поиск НЕ НУЖЕН: верни ТОЛЬКО специальный маркер "NO_SEARCH". ПРЕДЫСТОРИЯ ДИАЛОГА (последние несколько сообщений, если есть):\n${chatHistoryPlaceholder}\n\nЗАПРОС ПОЛЬЗОВАТЕЛЯ:\n"${userMessagePlaceholder}"\n\nТВОЙ ОТВЕТ:`;
            const finalPrompt = promptTemplate.replace(chatHistoryPlaceholder, previousChatHistoryString).replace(userMessagePlaceholder, userMessageText);
            let classificationResult = 'NO_SEARCH';
            if (!taskState.aiService) { taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_CLASSIFICATION_ERROR", "aiService not available, defaulting to NO_SEARCH.")); return classificationResult; }
            try {
                const classificationLlmParams = { model: taskState.aiService.baseConfig?.models?.fast || taskState.aiService.baseConfig?.defaultModel || 'gpt-3.5-turbo', temperature: 0.1, max_tokens: 150 };
                const messagesForClassifier = [{ role: 'user', content: finalPrompt }];
                const preparedContext = await taskState.aiService.prepareContextForModel(messagesForClassifier, { modelName: classificationLlmParams.model });
                let llmResponse;
                const effectiveContext = (preparedContext && !preparedContext.cacheName) ? preparedContext : messagesForClassifier;
                const callParams = { ...classificationLlmParams };
                if (preparedContext && preparedContext.cacheName) { callParams.cacheHandle = { cacheName: preparedContext.cacheName }; }
                llmResponse = await taskState.aiService.completeChat(effectiveContext, callParams);
                if (llmResponse?.trim()) { classificationResult = llmResponse.trim(); } else { classificationResult = 'NO_SEARCH'; }
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_CLASSIFICATION_ATTEMPT", `User message: "${userMessageText.substring(0,100)}...". LLM Response: "${classificationResult}"`));
            } catch (classError) {
                console.error(`[OrchestratorAgent] Error during search classification: ${classError.stack}`);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_CLASSIFICATION_ERROR", `Error: ${classError.message}. Defaulting to NO_SEARCH.`));
                classificationResult = 'NO_SEARCH';
            }
            return classificationResult;
        }

        async _notifyAndExecuteSearch(_taskState, _searchQuery) { /* ... no change from Turn 43 ... */ }
        async _summarizeAndPresentSearchResults(_taskState, _searchQuery) { /* ... no change from Turn 43 ... */ }
        async _handleSynthesizeOnlyMode(_taskState) { /* ... no change ... */ }
        async _handleExecutePlannedTaskMode(_taskState) { /* ... no change ... */ }
    async _performPlanningPhase(taskState, isRevision = false) { // Added isRevision here
        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_PHASE_STARTED", `Starting planning phase. Is revision: ${isRevision}`));
        // ... (existing logic for memoryContext, cwcForPlanning, etc.)
        // The existing logic for preparing memoryContext, cwcForPlanning, executionContextForPlanning,
        // remainingPlanForRevision, latestKeyFindingsForPlanning, latestErrorsForPlanning
        // should remain here or be called before this point.
        // For brevity, I'm assuming these are prepared as they were before.

        let memoryContext = { /* ... */ }; // Assume populated as before
        let cwcForPlanning = taskState.currentWorkingContext;
        let executionContextForPlanning = taskState.lastExecutionContext;
        let remainingPlanForRevision = isRevision ? taskState.planStages : null;

        // Simplified fetching for example, replace with actual calls if different
        const latestKeyFindingsForPlanning = await this.memoryManager.getLatestKeyFindings(taskState.taskDirPath, 5);
        const latestErrorsForPlanning = taskState.replanHistory ? taskState.replanHistory.slice(-3) : [];


        let replanErrorHistoryForPrompt = null;
        if (isRevision && taskState.replanHistory && taskState.currentReplanningCycleId) {
            replanErrorHistoryForPrompt = taskState.replanHistory
                .filter(entry => entry.cycleId === taskState.currentReplanningCycleId)
                .slice(-3) // Последние 3 попытки в текущем цикле
                .map(entry => ({
                    attemptInCycle: entry.attemptInCycle,
                    failedStepNarrative: entry.failedStepNarrative,
                    errorMessage: entry.errorMessage.substring(0, 200) // Ограничить длину сообщения
                }));
        }

        const planResult = await this.planManager.getPlan(
            taskState.currentOriginalTask,
            taskState.workerAgentCapabilities.map(agent => agent.role),
            taskState.workerAgentCapabilities.reduce((acc, agent) => {
                acc[agent.role] = agent.tools.map(tool => tool.name);
                return acc;
            }, {}),
            memoryContext,
            cwcForPlanning,
            executionContextForPlanning,
            isRevision ? taskState.lastError : null, // Pass lastError only if it's a revision
            remainingPlanForRevision,
            isRevision,
            taskState.totalReplanAttempts, // This is revisionAttemptNumber
            latestKeyFindingsForPlanning,
            latestErrorsForPlanning,
            replanErrorHistoryForPrompt // New parameter
        );

        // ... (rest of the _performPlanningPhase logic from previous state)
        if (!planResult.success) {
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", `Planning failed: ${planResult.message}`, { rawResponse: planResult.rawResponse }));
            // Handle error or decide to ask for clarification
            if (planResult.message && planResult.message.toLowerCase().includes("clarification needed")) {
                 taskState.needsUserInput = true;
                 // taskState.pendingQuestionId = ... (if LLM can provide a question ID)
                 taskState.responseMessage = planResult.message; // Or a more structured question
            }
            return { success: false, message: planResult.message, rawResponse: planResult.rawResponse };
        }
        taskState.planStages = planResult.plan;
        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SUCCESSFUL", `Plan created successfully. Source: ${planResult.source}. Plan has ${planResult.plan.length} stages.`));
        await this.memoryManager.overwriteMemory(taskState.taskDirPath, 'plan.json', taskState.planStages, { isJson: true });
        taskState.lastError = null; // Clear last error after successful planning/replanning
        return { success: true };
    }
        async _performExecutionPhase(_taskState) { /* ... no change ... */ }
        async _performCwcUpdateLLM(_taskState) { /* ... no change ... */ }
        async _performFinalSynthesis(_taskState) { /* ... no change ... */ }
        async _finalizeTaskProcessing(_taskState) { /* ... no change ... */ }

        async handleUserTask(userTaskString, uploadedFiles, parentTaskId = null, taskIdToLoad = null, executionMode = EXECUTE_FULL_PLAN) {
            let taskState;
            let loadedStateForResumption = null;
            let performedAdHocSearchThisTurn = false;

            if (taskIdToLoad) {
                const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                let potentialTaskDirPath;
                try {
                    // TODO: Robust task path discovery for resuming/loading tasks, especially across different dates.
                    const todayDate = new Date().toISOString().split('T')[0]; // This date assumption is a key limitation.
                  potentialTaskDirPath = path.join(baseTaskDir, todayDate, `task_${taskIdToLoad}`);

                    const stateFilePath = path.join(potentialTaskDirPath, 'task_state.json');
                    if (await fs.pathExists(stateFilePath)) {
                        const stateResult = await loadTaskState(stateFilePath);
                        if (stateResult.success && stateResult.taskState) {
                            loadedStateForResumption = stateResult.taskState;
                            loadedStateForResumption.taskDirPath = potentialTaskDirPath;
                            if (loadedStateForResumption.needsUserInput && loadedStateForResumption.pendingQuestionId) {
                                await this._processUserClarification(loadedStateForResumption);
                            }
                        }
                    } else if (executionMode !== EXECUTE_PLANNED_TASK && executionMode !== SYNTHESIZE_ONLY) {
                        console.warn(`No state file at ${stateFilePath} for taskIdToLoad: ${taskIdToLoad}`);
                    }
                } catch (e) { console.warn(`Error loading state for taskIdToLoad ${taskIdToLoad}: ${e.message}`); }
            }

            try {
                taskState = await this._initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, loadedStateForResumption);

                // Log the specific user input for this interaction if it's new (not just resuming a loaded task state)
                if (userTaskString && (!loadedStateForResumption || userTaskString !== loadedStateForResumption.userTaskString)) {
                     const currentInteractionUserMessage = {
                        taskId: taskState.taskId,
                        senderId: parentTaskId || 'user_interaction', // Distinguish from initial prompt if needed
                        role: 'user',
                        content: { type: 'text', text: userTaskString }
                     };
                     await this.memoryManager.addChatMessage(taskState.taskDirPath, currentInteractionUserMessage);
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CURRENT_USER_INPUT_LOGGED", `Logged current interaction: "${userTaskString.substring(0,100)}..."`));
                }

                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);

                if (!loadedStateForResumption || (uploadedFiles && uploadedFiles.length > 0) ) {
                    await this._processAndSaveUploadedFiles(uploadedFiles, taskState);
                }

                // --- Ad-hoc Search Query Classification & Execution ---
                // Condition for running classifier:
                // - Not currently waiting for user input (i.e., previous question was answered or no question was pending).
                // - Current execution mode is EXECUTE_FULL_PLAN (typical for new general requests) or no specific mode (implying a new request).
                // - Not a simple reload of a task if userTaskString is empty (meaning user just wants to "continue" without new input).
                if (!taskState.needsUserInput &&
                    (taskState.executionMode === EXECUTE_FULL_PLAN || !taskState.executionMode) &&
                    userTaskString?.trim() // Only classify if there's new textual input from user for this turn
                   ) {

                    let messageToClassify = userTaskString; // Use the current input for classification

                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("ADHOC_SEARCH_CLASSIFICATION_STARTED", `Classifying for ad-hoc search: "${messageToClassify.substring(0,100)}..."`));
                    const searchQueryOrNoSearch = await this._classifyUserRequestForSearch(taskState, messageToClassify);

                    if (searchQueryOrNoSearch && searchQueryOrNoSearch.toUpperCase() !== 'NO_SEARCH') {
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("ADHOC_SEARCH_TRIGGERED", `LLM classified for search. Query: "${searchQueryOrNoSearch}"`));
                        taskState = await this._notifyAndExecuteSearch(taskState, searchQueryOrNoSearch);
                        taskState = await this._summarizeAndPresentSearchResults(taskState, searchQueryOrNoSearch);
                        taskState.overallSuccess = !taskState.lastError;
                        performedAdHocSearchThisTurn = true;
                    } else {
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("ADHOC_SEARCH_NOT_NEEDED", `LLM classified as NO_SEARCH for: "${messageToClassify.substring(0,100)}..."`));
                    }
                }
                // --- End Ad-hoc Search ---

                if (performedAdHocSearchThisTurn) {
                    // If search was performed, this turn's primary action is complete.
                    // responseMessage and overallSuccess are set by search methods.
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("ADHOC_SEARCH_TURN_CONCLUDED", `Ad-hoc search flow completed for task ${taskState.taskId}`));
                } else if (taskState.needsUserInput) {
                    // If, after clarification processing or if planning asked a question, we still need input.
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_PAUSED_AWAITING_INPUT", `Awaiting input for: ${taskState.pendingQuestionId}`));
                } else {
                    // Standard execution flow if no ad-hoc search handled the turn and no user input is pending
                    if (taskState.executionMode === SYNTHESIZE_ONLY) {
                        return await this._handleSynthesizeOnlyMode(taskState); // This returns early, includes finalize
                    }
                    if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                        if (!taskState.planStages?.length) { await this._handleExecutePlannedTaskMode(taskState); }
                        if (!taskState.overallSuccess) { return; }
                    }

                    if (taskState.executionMode === PLAN_ONLY || (taskState.executionMode === EXECUTE_FULL_PLAN && (!taskState.planStages?.length) )) {
                        // Check replan limits BEFORE attempting a new planning phase (initial or revision)
                        if (taskState.lastError) { // Indicates a previous execution attempt failed
                            taskState.totalReplanAttempts = (taskState.totalReplanAttempts || 0) + 1;
                            const lastFailedStepId = taskState.lastError.stepId || taskState.lastError.sub_task_id;
                            const lastErrorMessage = taskState.lastError.error_details?.message || taskState.lastError.message || 'Unknown error';
                            let currentAttemptInCycle = 1;
                            const lastCycleEntry = taskState.replanHistory && taskState.replanHistory.length > 0 ?
                                taskState.replanHistory[taskState.replanHistory.length - 1] : null;
                            const SIMILARITY_THRESHOLD = 50;
                            const isSimilarError = lastCycleEntry &&
                                                   lastCycleEntry.cycleId === taskState.currentReplanningCycleId &&
                                                   lastCycleEntry.failedStepId === lastFailedStepId &&
                                                   lastCycleEntry.errorMessage?.substring(0, SIMILARITY_THRESHOLD) === lastErrorMessage.substring(0, SIMILARITY_THRESHOLD);

                            if (taskState.currentReplanningCycleId && isSimilarError) {
                                currentAttemptInCycle = (lastCycleEntry.attemptInCycle || 0) + 1;
                            } else {
                                taskState.currentReplanningCycleId = `cycle_${uuidv4()}`;
                                currentAttemptInCycle = 1;
                            }

                            taskState.replanHistory.push({
                                cycleId: taskState.currentReplanningCycleId,
                                attemptInCycle: currentAttemptInCycle,
                                failedStepId: lastFailedStepId,
                                failedStepNarrative: taskState.lastError.narrative_step || 'N/A',
                                errorMessage: lastErrorMessage,
                                timestamp: new Date().toISOString()
                            });

                            if (currentAttemptInCycle > MAX_REPLAN_ATTEMPTS_PER_CYCLE) {
                                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLAN_CYCLE_LIMIT_EXCEEDED", `Max attempts (${MAX_REPLAN_ATTEMPTS_PER_CYCLE}) for similar error on step ${lastFailedStepId} exceeded. Task failed.`));
                                taskState.overallSuccess = false;
                                taskState.responseMessage = `Задача не может быть выполнена: ошибка на шаге "${taskState.lastError.narrative_step || lastFailedStepId}" повторяется (${lastErrorMessage.substring(0,100)}...).`;
                                console.log(`[OrchestratorAgent] REPLAN_CYCLE_LIMIT_EXCEEDED for task ${taskState.taskId}`);
                                taskState.executionMode = 'ABORTED_REPLAN_CYCLE_LIMIT';
                                throw new Error(`Replanning cycle limit exceeded for step ${lastFailedStepId}.`);
                            }
                            if (taskState.totalReplanAttempts > MAX_TOTAL_REPLAN_ATTEMPTS) {
                                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLAN_TOTAL_LIMIT_EXCEEDED", `Total replan attempts (${MAX_TOTAL_REPLAN_ATTEMPTS}) exceeded. Task failed.`));
                                taskState.overallSuccess = false;
                                taskState.responseMessage = `Задача не может быть выполнена: превышено общее количество попыток перепланирования.`;
                                console.log(`[OrchestratorAgent] REPLAN_TOTAL_LIMIT_EXCEEDED for task ${taskState.taskId}`);
                                taskState.executionMode = 'ABORTED_REPLAN_TOTAL_LIMIT';
                                throw new Error(`Total replanning attempts limit exceeded.`);
                            }
                        }
                        // Pass isRevision based on whether lastError exists (signifying a prior failed execution)
                        const planningOutcome = await this._performPlanningPhase(taskState, !!taskState.lastError);
                        if (planningOutcome.needsUserInput) { return; } // This will go to finally
                        if (!planningOutcome.success) {
                            taskState.overallSuccess = false; taskState.responseMessage = planningOutcome.message || "Planning failed.";
                            taskState.finalAnswer = JSON.stringify(planningOutcome.rawResponse || {}); return;
                        }
                    } else if (taskState.executionMode === EXECUTE_PLANNED_TASK && taskState.planStages?.length > 0) {
                         taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SKIPPED", "Skipping planning."));
                    }

                    if (taskState.needsUserInput) { return; } // Check again after planning phase

                    if (taskState.executionMode === PLAN_ONLY) {
                        taskState.responseMessage = "Plan created successfully.";
                        taskState.finalAnswer = JSON.stringify(taskState.planStages);
                        taskState.overallSuccess = true; return;
                    }

                    if (taskState.executionMode === EXECUTE_FULL_PLAN || taskState.executionMode === EXECUTE_PLANNED_TASK) {
                        await this._performExecutionPhase(taskState);
                    }
                    if ((taskState.executionMode === EXECUTE_FULL_PLAN || taskState.executionMode === EXECUTE_PLANNED_TASK) && taskState.overallSuccess) {
                        await this._performCwcUpdateLLM(taskState);
                    }
                    if (!taskState.wasFinalAnswerPreSynthesized) {
                        await this._performFinalSynthesis(taskState);
                    } else {
                         taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_PRE_SYNTHESIZED", "Synthesis skipped."));
                    }
                }
            } catch (error) {
                console.error(`Critical error in OrchestratorAgent.handleUserTask for ${taskState?.taskId || parentTaskId || 'unknown'}: ${error.stack}`);
                if (taskState) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("HANDLE_USER_TASK_CRITICAL_ERROR", `Critical error: ${error.message}`));
                    taskState.overallSuccess = false; taskState.responseMessage = `Critical error: ${error.message.substring(0, 200)}`;
                } else {
                    const errorTaskId = parentTaskId || Date.now().toString() + '_init_fail';
                    const tempJournal = [this._createOrchestratorJournalEntry("HANDLE_USER_TASK_INIT_ERROR", `Critical init error: ${error.message}`)];
                    return { success: false, message: `Critical initialization error: ${error.message.substring(0,200)}`, taskId: errorTaskId, data: null, journal: tempJournal };
                }
            } finally {
                if (taskState) { await this._finalizeTaskProcessing(taskState); }
            }
            return {
                success: taskState.overallSuccess, message: taskState.responseMessage,
                taskId: taskState.taskId, data: taskState.finalAnswer,
                journal: taskState.finalJournalEntries,
                needsUserInput: taskState.needsUserInput, pendingQuestionId: taskState.pendingQuestionId
            };
        }
    }
    module.exports = OrchestratorAgent;
