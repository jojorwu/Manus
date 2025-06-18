// OrchestratorAgent.js
    import fs from 'fs-extra';
    import path from 'path';
    import PlanExecutor from '../core/PlanExecutor.js';
    import { PlanManager } from './PlanManager.js';
    import { EXECUTE_FULL_PLAN, PLAN_ONLY, SYNTHESIZE_ONLY, EXECUTE_PLANNED_TASK } from '../utils/constants.js';
    import MemoryManager from '../core/MemoryManager.js';
    import ConfigManager from '../core/ConfigManager.js';
    import { loadTaskState } from '../utils/taskStateUtil.js'; // getTaskStateFilePath might be useful too
    import { v4 as uuidv4 } from 'uuid';

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
                {}, this.savedTasksBaseDir
            );
            this.configManager = new ConfigManager();
            console.log(\`OrchestratorAgent initialized with AI Service: \${this.aiService.getServiceName()}, PlanExecutor configured.\`);
        }

        _createOrchestratorJournalEntry(type, message, details = {}) {
            return { timestamp: new Date().toISOString(), type, source: "OrchestratorAgent", message, details };
        }

        // New method to process user's clarification
        async _processUserClarification(taskState) {
            if (!taskState.needsUserInput || !taskState.pendingQuestionId) {
                return; // Should not be called if no input is needed
            }

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_CHECK_STARTED", \`Checking for user response to question \${taskState.pendingQuestionId}\`));

            const chatHistory = await taskState.memoryManager.getChatHistory(taskState.taskDirPath, { sort_order: 'asc' });

            const agentQuestionMessage = chatHistory.find(
                msg => msg.sender?.id === 'OrchestratorAgent' &&
                       msg.content?.questionDetails?.questionId === taskState.pendingQuestionId
            );

            if (!agentQuestionMessage) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_ERROR", \`Agent's question \${taskState.pendingQuestionId} not found in history. Will ask again if needed.\`));
                // Keep needsUserInput true, planning phase might ask again or logic might need adjustment
                return;
            }

            const agentQuestionTimestamp = new Date(agentQuestionMessage.timestamp);
            const userResponse = chatHistory.find(
                msg => msg.sender?.role === 'user' &&
                       new Date(msg.timestamp) > agentQuestionTimestamp &&
                       (msg.relatedToMessageId === agentQuestionMessage.id || !msg.relatedToMessageId) // Simplistic: take first user msg after question, ideally check relatedToMessageId
            );

            if (userResponse && userResponse.content?.text) {
                const userAnswerText = userResponse.content.text;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_RECEIVED", \`User responded to \${taskState.pendingQuestionId}: "\${userAnswerText.substring(0, 100)}..."\`, { questionId: taskState.pendingQuestionId }));

                // Integrate the answer
                const clarificationText = \`\n\nUser Clarification (for QID \${taskState.pendingQuestionId}): \${userAnswerText}\`;
                taskState.currentOriginalTask = (taskState.currentOriginalTask || "") + clarificationText;

                // Log this integrated clarification back to chat as a user message for context continuity for LLM
                // This assumes the original user response might have been simple, and we are augmenting it for context.
                // Or, we can assume the original userResponse is sufficient if it's already detailed.
                // For this implementation, let's assume the user's direct response is what we use.
                // We've updated currentOriginalTask; this will be used in subsequent LLM calls.

                // Reset flags
                taskState.needsUserInput = false;
                taskState.pendingQuestionId = null;
                taskState.responseMessage = 'User clarification processed. Resuming task.'; // Internal status
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_PROCESSED", "User input processed, proceeding with task."));

            } else {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_NOT_FOUND", \`No new user response found for question \${taskState.pendingQuestionId} since \${agentQuestionTimestamp.toISOString()}.\`));
                // needsUserInput remains true, so the task will effectively pause again.
                // The responseMessage should still be the agent's question.
                taskState.responseMessage = agentQuestionMessage.content.text;
                taskState.overallSuccess = false; // Ensure it's marked as not successful for this turn
            }
        }

        async _initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, existingState = null) {
            let taskId, taskDirPath, finalJournalEntries, currentWorkingContext, uploadedFilePaths, planStages,
                lastExecutionContext, currentOriginalTask, needsUserInput, pendingQuestionId, responseMessage;

            if (existingState) {
                taskId = existingState.taskId;
                taskDirPath = existingState.taskDirPath;
                finalJournalEntries = existingState.finalJournalEntries || [this._createOrchestratorJournalEntry("TASK_RESUMED", \`Task \${taskId} resumed.\`)];
                currentWorkingContext = existingState.currentWorkingContext || 'No CWC loaded on resume.';
                uploadedFilePaths = existingState.savedUploadedFilePaths || []; // Ensure this key matches what's saved
                planStages = existingState.plan || null;
                lastExecutionContext = existingState.executionContext || null;
                currentOriginalTask = existingState.currentOriginalTask || userTaskString; // Prioritize existing
                needsUserInput = existingState.needsUserInput || false;
                pendingQuestionId = existingState.pendingQuestionId || null;
                responseMessage = existingState.responseMessage || '';
                // If resuming and user input was just processed, userTaskString might be the new input.
                // However, currentOriginalTask was updated with clarification.
                // The passed userTaskString is the *original* input from the API for this call.
                // If clarification was processed, currentOriginalTask now includes it.
            } else {
                taskId = taskIdToLoad ? taskIdToLoad.split('_')[1] : Date.now().toString();
                const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                // TODO: This date logic is problematic for loading tasks not created "today".
                // Needs a robust way to find task directories, possibly by removing date folders or querying metadata.
                const datedTasksDirPath = path.join(baseTaskDir, new Date().toISOString().split('T')[0]);
                taskDirPath = path.join(datedTasksDirPath, \`task_\${taskId}\`);

                await fs.ensureDir(taskDirPath);
                await fs.ensureDir(path.join(taskDirPath, 'uploaded_files'));
                await this.memoryManager.initializeTaskMemory(taskDirPath); // Ensures chat_messages.json exists

                finalJournalEntries = [this._createOrchestratorJournalEntry("TASK_INITIALIZED", \`Task \${taskId} (\${executionMode}) initialized.\`, { parentTaskId, taskIdToLoad })];
                currentWorkingContext = 'No CWC (Current Working Context) has been generated yet for this task.';
                currentOriginalTask = userTaskString;
                uploadedFilePaths = [];
                planStages = null;
                lastExecutionContext = null;
                needsUserInput = false;
                pendingQuestionId = null;
                responseMessage = '';

                if (taskIdToLoad) { // This logic is for loading CWC if it's a *new session* for an *old task ID* (e.g. EXECUTE_PLANNED_TASK)
                                    // Not for general state resumption which is handled by existingState.
                    const loadTaskDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskIdToLoad.split('_')[1]}\`);
                    try {
                        const loadedCwc = await this.memoryManager.loadMemory(loadTaskDir, 'cwc.md');
                        if (loadedCwc) currentWorkingContext = loadedCwc;
                        else { /* ... CWC JSON fallback ... */ }
                        if (currentWorkingContext !== 'No CWC (Current Working Context) has been generated yet for this task.') {
                             finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "Existing CWC loaded for new session.", { taskIdToLoad }));
                        }
                    } catch (error) { /* ... CWC load error ... */ }
                }
                const taskDefinitionContent = \`# Task Definition for Task ID: \${taskId}\n\n**User Task:**\n\${currentOriginalTask}\n\n**Execution Mode:** \${executionMode}\n\`;
                await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', taskDefinitionContent);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_DEFINITION_SAVED", "Task definition saved."));

                if (currentOriginalTask && currentOriginalTask.trim() !== '') {
                    const initialUserMessage = {
                        taskId: taskId, senderId: parentTaskId || 'user_initial_prompt', role: 'user',
                        content: { type: 'text', text: currentOriginalTask },
                    };
                    await this.memoryManager.addChatMessage(taskDirPath, initialUserMessage);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_TASK_LOGGED_TO_CHAT", "User task logged to chat."));
                }
            }

            const tokenizerFn = this.aiService.getTokenizer();
            const maxTokenLimitForContextAssembly = (this.aiService.getMaxContextTokens() || 32000) * 0.8;

            return {
                taskId, parentTaskIdFromCall: parentTaskId, taskDirPath,
                stateFilePath: path.join(taskDirPath, 'task_state.json'),
                journalFilePath: path.join(taskDirPath, 'orchestrator_journal.json'),
                finalJournalEntries, currentWorkingContext,
                userTaskString: userTaskString, // The original userTaskString for this specific handleUserTask call
                executionMode, taskIdToLoad,
                tokenizerFn, maxTokenLimitForContextAssembly, uploadedFilePaths, planStages,
                overallSuccess: existingState ? existingState.overallSuccess : false, // Preserve success if resuming, else false
                lastExecutionContext,
                finalAnswer: existingState ? existingState.finalAnswer : '',
                responseMessage: responseMessage || (existingState ? existingState.responseMessage : ''),
                currentOriginalTask, // This now includes clarifications if any were processed
                CHAT_HISTORY_LIMIT: 20, DEFAULT_MEGA_CONTEXT_TTL: 3600,
                DEFAULT_GEMINI_CACHED_CONTENT_TTL: 3600, MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE: 1024,
                aiService: this.aiService, memoryManager: this.memoryManager,
                planManager: this.planManager, planExecutor: this.planExecutor,
                workerAgentCapabilities: this.agentCapabilities, // Use constructed agentCapabilities
                needsUserInput, pendingQuestionId,
            };
        }

        async _processAndSaveUploadedFiles(uploadedFiles, taskState) {
            // ... (no change from previous version)
            if (uploadedFiles && uploadedFiles.length > 0) {
                const uploadedFilesDir = path.join(taskState.taskDirPath, 'uploaded_files');
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SAVING_UPLOADED_FILES", \`Saving \${uploadedFiles.length} files.\`));
                for (const file of uploadedFiles) {
                    try {
                        const safeFileName = path.basename(file.name);
                        const absoluteFilePath = path.join(uploadedFilesDir, safeFileName);
                        await fs.writeFile(absoluteFilePath, file.content);
                        taskState.uploadedFilePaths.push(path.join('uploaded_files', safeFileName));
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_SUCCESS", \`Saved: \${safeFileName}\`));
                    } catch (uploadError) {
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_ERROR", \`Error saving \${file.name}: \${uploadError.message}\`));
                    }
                }
            }
        }

        async _handleSynthesizeOnlyMode(taskState) {
            // ... (no change from previous version)
            if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_ERROR", "taskIdToLoad is required."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for SYNTHESIZE_ONLY mode.";
                return { success: false, message: taskState.responseMessage, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: null };
            }
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const taskToLoadDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskState.taskIdToLoad.split('_')[1]}\`);
            const loadPath = path.join(taskToLoadDir, 'task_state.json');
            const loadResult = await loadTaskState(loadPath);

            if (!loadResult.success || !loadResult.taskState) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_LOAD_FAILED", \`Failed to load state for taskId \${taskState.taskIdToLoad}.\`));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Failed to load state for SYNTHESIZE_ONLY (taskId: \${taskState.taskIdToLoad}).\`;
                return { success: false, message: taskState.responseMessage, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: null };
            }

            const loadedState = loadResult.taskState;
            taskState.currentOriginalTask = loadedState.userTaskString || loadedState.currentOriginalTask || taskState.userTaskString;
            taskState.currentWorkingContext = loadedState.currentWorkingContext || taskState.currentWorkingContext;
            taskState.lastExecutionContext = loadedState.executionContext || [];
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_STATE_LOADED", \`State loaded for taskId \${taskState.taskIdToLoad}.\`));
            await this._performFinalSynthesis(taskState);
            return { success: taskState.overallSuccess, message: taskState.responseMessage, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: taskState.finalAnswer };
        }

        async _handleExecutePlannedTaskMode(taskState) {
            // ... (no change from previous version)
             if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_ERROR", "taskIdToLoad is required."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode.";
                return;
            }
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const taskToLoadDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskState.taskIdToLoad.split('_')[1]}\`);
            const loadPath = path.join(taskToLoadDir, 'task_state.json');
            const loadResult = await loadTaskState(loadPath);

            if (!loadResult.success || !loadResult.taskState || !loadResult.taskState.plan?.length) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_LOAD_FAILED", \`Failed to load state or plan for taskId \${taskState.taskIdToLoad}.\`));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Failed to load state or plan for EXECUTE_PLANNED_TASK (taskId: \${taskState.taskIdToLoad}).\`;
                return;
            }

            const loadedState = loadResult.taskState;
            taskState.currentOriginalTask = taskState.userTaskString || loadedState.userTaskString || "";
            taskState.planStages = loadedState.plan;
            taskState.currentWorkingContext = loadedState.currentWorkingContext || taskState.currentWorkingContext;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_STATE_LOADED", \`State and plan loaded for taskId \${taskState.taskIdToLoad}.\`));
            taskState.overallSuccess = true;
        }

        async _performPlanningPhase(taskState) {
            // If resuming and input was needed, it should have been processed before this phase.
            // The clarifying question logic is at the beginning of this method.
            const taskText = (taskState.currentOriginalTask || "").toLowerCase();
            const fileKeywords = ["файл", "документ", "pdf", "file", "document", "attachment", "загрузка"];
            const mentionsFile = fileKeywords.some(keyword => taskText.includes(keyword));

            // Only ask if not already waiting for input for this specific type of question,
            // and if the original task (before potential clarifications) also mentioned files.
            // This prevents re-asking if clarification didn't provide files.
            if (mentionsFile && (!taskState.uploadedFilePaths || taskState.uploadedFilePaths.length === 0) && !taskState.needsUserInput) {
                const questionId = \`q_file_\${uuidv4().substring(0,8)}\`;
                const agentQuestionText = "It looks like your task might involve a file, but no files were attached. Could you please upload the relevant file(s) or clarify if it's not needed for this task by describing the file content or confirming it's not required?";

                const agentMessage = {
                    taskId: taskState.taskId, senderId: 'OrchestratorAgent', role: 'assistant',
                    content: { type: 'agent_question', text: agentQuestionText, questionDetails: { questionId } }
                };
                await taskState.memoryManager.addChatMessage(taskState.taskDirPath, agentMessage);

                taskState.needsUserInput = true;
                taskState.pendingQuestionId = questionId;
                taskState.responseMessage = agentQuestionText;
                taskState.overallSuccess = false;
                taskState.finalAnswer = null;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CLARIFYING_QUESTION_ASKED", agentQuestionText, { questionId }));
                return { success: false, needsUserInput: true, message: agentQuestionText };
            }
            // ... rest of planning phase from previous turn (Turn 35) ...
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan."));
            const knownAgentRoles = (taskState.workerAgentCapabilities?.roles || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (taskState.workerAgentCapabilities?.roles || []).forEach(agent => {
                if (agent.role && Array.isArray(agent.tools)) {
                    knownToolsByRole[agent.role] = agent.tools.map(t => typeof t === 'string' ? t : t.name);
                }
            });

            const planningSystemPrompt = "You are an AI assistant ...";
            const contextSpecification = {
                systemPrompt: planningSystemPrompt,
                includeTaskDefinition: true, uploadedFilePaths: taskState.uploadedFilePaths,
                maxLatestKeyFindings: 5, keyFindingsRelevanceQuery: taskState.currentOriginalTask,
                chatHistory: await taskState.memoryManager.getChatHistory(taskState.taskDirPath, {limit: taskState.CHAT_HISTORY_LIMIT, sort_order: 'desc'}),
                maxTokenLimit: taskState.maxTokenLimitForContextAssembly * 0.7,
                customPreamble: "Please generate a plan based on the following context:",
                originalUserTask: taskState.currentOriginalTask,
                currentWorkingContext: taskState.currentWorkingContext,
            };
            const megaContextResult = await taskState.memoryManager.assembleMegaContext(taskState.taskDirPath, contextSpecification, taskState.tokenizerFn);

            if (!megaContextResult.success) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", \`Planning context failed: \${megaContextResult.error}\`));
                return { success: false, message: "Failed to assemble context for planning." };
            }

            const llmContextForPlanning = megaContextResult.contextString;
            const planningModelName = taskState.aiService.baseConfig?.planningModel || taskState.aiService.baseConfig?.defaultModel || 'gpt-4-turbo';

            const prepOptions = {
                modelName: planningModelName,
                systemMessage: planningSystemPrompt,
                cacheConfig: {
                    ttlSeconds: taskState.DEFAULT_GEMINI_CACHED_CONTENT_TTL,
                    displayName: \`plan_ctx_\${taskState.taskId.substring(0,10)}\`
                }
            };

            const preparedOutput = await taskState.aiService.prepareContextForModel(llmContextForPlanning, prepOptions);
            const llmParamsForPlanManager = { model: planningModelName, temperature: 0.4 };
            let actualContextForPlanManager = llmContextForPlanning;

            if (preparedOutput) {
                if (preparedOutput.cacheName) {
                    llmParamsForPlanManager.cacheHandle = preparedOutput;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_CONTEXT_PREPARED_WITH_CACHE", \`Using cache: \${preparedOutput.cacheName}\`));
                } else {
                    actualContextForPlanManager = preparedOutput;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_CONTEXT_PREPARED", "Service prepared context."));
                }
            }

            const memoryContextForPlanManager = { megaContext: actualContextForPlanManager, llmParams: llmParamsForPlanManager };
            const planResult = await taskState.planManager.getPlan(
                taskState.currentOriginalTask, knownAgentRoles, knownToolsByRole,
                memoryContextForPlanManager, taskState.currentWorkingContext
            );

            if (!planResult.success || !planResult.plan?.length) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", \`Planning failed: \${planResult.message || 'No plan'}\`));
                return { success: false, message: planResult.message || "Planning failed.", rawResponse: planResult.rawResponse };
            }

            taskState.planStages = planResult.plan;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", \`Plan obtained. Stages: \${taskState.planStages.length}\`));
            await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
            return { success: true };
        }

        async _performExecutionPhase(taskState) {
            // ... (no change from previous version)
             if (!taskState.planStages?.length) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_SKIPPED_NO_PLAN", "No plan to execute."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "Execution skipped: no plan.";
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_INVOKED", "Executing plan."));
            try {
                const executionResult = await taskState.planExecutor.executePlan(taskState.planStages, taskState.taskId, taskState.currentOriginalTask);
                taskState.lastExecutionContext = executionResult.executionContext || [];
                if (executionResult.journalEntries?.length) taskState.finalJournalEntries.push(...executionResult.journalEntries);
                taskState.overallSuccess = executionResult.success;
                if (executionResult.updatesForWorkingContext) {
                    taskState.executionKeyFindings = executionResult.updatesForWorkingContext.keyFindings || [];
                    taskState.executionErrorsEncountered = executionResult.updatesForWorkingContext.errorsEncountered || [];
                }
                if (executionResult.finalAnswerSynthesized && executionResult.finalAnswer) {
                    taskState.finalAnswer = executionResult.finalAnswer;
                    taskState.wasFinalAnswerPreSynthesized = true;
                    taskState.responseMessage = "Answer synthesized during execution.";
                }
                taskState.responseMessage = executionResult.success ? "Plan executed." : \`Execution failed: \${executionResult.failedStepDetails?.error_details?.message || 'Unknown error'}\`;
                if(!executionResult.success) taskState.failedStepDetails = executionResult.failedStepDetails;
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_CRITICAL_ERROR", \`Critical error: \${error.message}\`));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Critical execution error: \${error.message}\`;
                (taskState.lastExecutionContext = taskState.lastExecutionContext || []).push({ stepId: "EXECUTION_CRASH", narrative_step: "Critical error", status: "FAILED", error_details: { message: error.message }});
            }
            return taskState;
        }

        async _performCwcUpdateLLM(taskState) {
            // ... (no change from previous version)
            if (!taskState.lastExecutionContext?.length || !taskState.overallSuccess) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SKIPPED", "CWC update skipped."));
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_STARTED", "Updating CWC."));
            try {
                const findingsText = taskState.executionKeyFindings?.length ? "Key Findings:\n" + taskState.executionKeyFindings.map(f => \`- \${f.sourceStepNarrative}: \${JSON.stringify(f.data)}\`).join("\n") : "No new key findings.";
                const errorsText = taskState.executionErrorsEncountered?.length ? "Errors:\n" + taskState.executionErrorsEncountered.map(e => \`- \${e.sourceStepNarrative}: \${e.errorMessage}\`).join("\n") : "No new errors.";
                const cwcPromptParts = [
                    {role: "system", content: "Update CWC based on provided info (task, prev CWC, execution summary, history). Output only updated CWC text."},
                    {role: "user", content: \`Prev CWC:\n\${taskState.currentWorkingContext}\nTask:\n\${taskState.currentOriginalTask}\nExec Summary (Success: \${taskState.overallSuccess}):\n\${findingsText}\n\${errorsText}\nHistory (last 5):\n\${JSON.stringify(taskState.lastExecutionContext.slice(-5), null, 2)}\nUpdated CWC:\`}
                ];
                const cwcModel = taskState.aiService.baseConfig?.cwcUpdateModel || taskState.aiService.baseConfig?.defaultModel || 'claude-3-haiku-20240307';
                const preparedContext = await taskState.aiService.prepareContextForModel(cwcPromptParts, { modelName: cwcModel });
                const newCwcText = await taskState.aiService.completeChat(preparedContext || cwcPromptParts, { model: cwcModel, temperature: 0.5 });

                if (newCwcText?.trim()) {
                    taskState.currentWorkingContext = newCwcText.trim();
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, ts: new Date().toISOString() }, { isJson: true });
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SUCCESS", "CWC updated."));
                } else {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_EMPTY_RESPONSE", "Empty CWC response."));
                }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_ERROR", \`Error: \${error.message}\`));
            }
            return taskState;
        }

        async _performFinalSynthesis(taskState) {
            // ... (no change from previous version regarding addChatMessage for agent's final answer)
            if (!taskState.overallSuccess || !taskState.lastExecutionContext?.length) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", "Synthesis skipped."));
                taskState.finalAnswer = taskState.finalAnswer || "Task not fully successful or no data for synthesis.";
                taskState.responseMessage = taskState.responseMessage || "Synthesis skipped.";
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_STARTED", "Starting final synthesis."));
            try {
                const synthesisPromptParts = [
                    {role: "system", content: "Generate a final answer based on task, CWC, and execution history. Address user's request directly."},
                    {role: "user", content: \`Task:\n\${taskState.currentOriginalTask}\nCWC:\n\${taskState.currentWorkingContext}\nExec History:\n\${JSON.stringify(taskState.lastExecutionContext.map(s=>({s:s.narrative_step, st:s.status, r:String(s.processed_result_data||s.raw_result_data).substring(0,100)})),null,2)}\nFinal Answer:\`}
                ];
                const synthesisModel = taskState.aiService.baseConfig?.synthesisModel || taskState.aiService.baseConfig?.defaultModel || 'claude-3-sonnet-20240229';
                const preparedContext = await taskState.aiService.prepareContextForModel(synthesisPromptParts, { modelName: synthesisModel });
                const newFinalAnswer = await taskState.aiService.completeChat(preparedContext || synthesisPromptParts, { model: synthesisModel, temperature: 0.6 });

                if (newFinalAnswer?.trim()) {
                    taskState.finalAnswer = newFinalAnswer.trim();
                    taskState.responseMessage = "Final answer synthesized.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SUCCESS", "Answer synthesized."));

                    const agentMessage = {
                        taskId: taskState.taskId,
                        senderId: 'OrchestratorAgent',
                        role: 'assistant',
                        content: { type: 'text', text: taskState.finalAnswer },
                    };
                    await taskState.memoryManager.addChatMessage(taskState.taskDirPath, agentMessage);
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_ANSWER_LOGGED_TO_CHAT", "Final answer logged to chat."));

                } else {
                    taskState.finalAnswer = taskState.finalAnswer || "LLM returned empty answer.";
                    taskState.responseMessage = taskState.responseMessage || "Empty synthesis.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_EMPTY_RESPONSE", "Empty synthesis response."));
                }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ERROR", \`Error: \${error.message}\`));
                taskState.finalAnswer = taskState.finalAnswer || \`Synthesis error: \${error.message}\`;
                taskState.responseMessage = taskState.responseMessage || "Synthesis failed.";
            }
            return taskState;
        }

        async _finalizeTaskProcessing(taskState) {
            // ... (no change from previous version regarding saving needsUserInput flags)
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZING_TASK", "Finalizing task."));
            try {
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'orchestrator_journal.json', taskState.finalJournalEntries, { isJson: true });
                const finalStateToSave = {
                    taskId: taskState.taskId, parentTaskId: taskState.parentTaskIdFromCall, executionMode: taskState.executionMode,
                    userTaskString: taskState.userTaskString, currentOriginalTask: taskState.currentOriginalTask,
                    overallSuccess: taskState.overallSuccess, finalAnswer: taskState.finalAnswer, responseMessage: taskState.responseMessage,
                    plan: taskState.planStages, executionContext: taskState.lastExecutionContext,
                    currentWorkingContext: taskState.currentWorkingContext, savedUploadedFilePaths: taskState.uploadedFilePaths,
                    needsUserInput: taskState.needsUserInput, pendingQuestionId: taskState.pendingQuestionId,
                    timestamp: new Date().toISOString(),
                    ...(taskState.failedStepDetails && { failedStepDetails: taskState.failedStepDetails }),
                };
                await fs.writeJson(taskState.stateFilePath, finalStateToSave, { spaces: 2 });
            } catch (saveError) {
                 taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZE_SAVE_ERROR", \`Save error: \${saveError.message}\`));
            }
        }

        async handleUserTask(userTaskString, uploadedFiles, parentTaskId = null, taskIdToLoad = null, executionMode = EXECUTE_FULL_PLAN) {
            let taskState;
            let loadedStateForResumption = null;

            // --- Attempt to load existing state if taskIdToLoad is provided ---
            if (taskIdToLoad) {
                // This needs a robust way to map taskIdToLoad to its full path including date.
                // Assuming taskIdToLoad is just the ID part (e.g., timestamp)
                // For now, this path reconstruction is a placeholder and might fail for tasks not from "today"
                // or if taskIdToLoad format is different.
                // TODO: Implement robust task path discovery for resuming tasks.
                const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                let potentialTaskDirPath;
                try {
                    // Attempt to find the task directory - this is complex if dated folders are used and date isn't known.
                    // Simplification: Assume taskIdToLoad might be the direct folder name OR needs a date prefix.
                    // This example assumes it's just the ID and tries "today's" dated folder.
                    const todayDate = new Date().toISOString().split('T')[0];
                    potentialTaskDirPath = path.join(baseTaskDir, todayDate, \`task_\${taskIdToLoad}\`);
                    // Check if this path exists, if not, maybe try without date, or other known date patterns.
                    // This is a simplified check:
                    if (!await fs.pathExists(potentialTaskDirPath)) {
                         // Fallback: Try to find it in a non-dated structure or other common patterns if any.
                         // For this stub, we'll just log a warning if the "today" path doesn't exist.
                         console.warn(\`Potential task path \${potentialTaskDirPath} not found directly. State loading might fail if task is from a different date.\`);
                         // A real implementation would require a metadata store or directory scanning to locate the task dir.
                    }

                    const stateFilePath = path.join(potentialTaskDirPath, 'task_state.json');
                    if (await fs.pathExists(stateFilePath)) {
                        const stateResult = await loadTaskState(stateFilePath);
                        if (stateResult.success && stateResult.taskState) {
                            loadedStateForResumption = stateResult.taskState;
                            console.log(\`Resuming task \${taskIdToLoad} from state. NeedsUserInput: \${loadedStateForResumption.needsUserInput}\`);
                            // If resuming a task that was waiting for input, process the clarification.
                            if (loadedStateForResumption.needsUserInput && loadedStateForResumption.pendingQuestionId) {
                                // Ensure taskDirPath is correctly set in loadedState for _processUserClarification
                                loadedStateForResumption.taskDirPath = potentialTaskDirPath;
                                await this._processUserClarification(loadedStateForResumption);
                            }
                        }
                    } else {
                        console.warn(\`No state file found at \${stateFilePath} for taskIdToLoad: \${taskIdToLoad}\`);
                    }
                } catch (e) {
                    console.warn(\`Error loading state for taskIdToLoad \${taskIdToLoad}: \${e.message}\`);
                }
            }
            // --- End of state loading attempt ---

            try {
                // Initialize taskState, using loadedStateForResumption if available
                taskState = await this._initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, loadedStateForResumption);

                // If clarification was processed, userTaskString for THIS execution might be different from currentOriginalTask
                // currentOriginalTask in taskState now contains the appended clarification.
                // The original userTaskString (from API for this call) is also in taskState.userTaskString.

                if (!existingState && userTaskString) { // Only log initial user message if not resuming from a state that already did
                     await this.memoryManager.addChatMessage(taskState.taskDirPath, {
                        taskId: taskState.taskId, senderId: parentTaskId || 'user_initial_prompt', role: 'user',
                        content: { type: 'text', text: userTaskString } // Log the specific input for this call
                    });
                }


                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);

                // Only process uploaded files if this is not a resumption where files might have been processed.
                // If loadedStateForResumption exists, assume files were handled or are part of its state.
                if (!loadedStateForResumption && uploadedFiles && uploadedFiles.length > 0) {
                    await this._processAndSaveUploadedFiles(uploadedFiles, taskState);
                }


                if (taskState.executionMode === SYNTHESIZE_ONLY) {
                    return await this._handleSynthesizeOnlyMode(taskState);
                }
                if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                    // _initializeTaskEnvironment would have loaded plan if existingState was passed with it.
                    // _handleExecutePlannedTaskMode ensures plan is loaded if not already.
                    if (!taskState.planStages || taskState.planStages.length === 0) { // If plan wasn't in existingState
                        await this._handleExecutePlannedTaskMode(taskState);
                    }
                    if (!taskState.overallSuccess) { return; } // Goes to finally
                }

                // If after processing clarification, input is still needed, pause.
                if (taskState.needsUserInput) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_PAUSED_AWAITING_INPUT", \`Task paused, awaiting user input for: \${taskState.pendingQuestionId}\`));
                    return; // Goes to finally
                }

                if (taskState.executionMode === PLAN_ONLY || (taskState.executionMode === EXECUTE_FULL_PLAN && (!taskState.planStages?.length) )) {
                    const planningOutcome = await this._performPlanningPhase(taskState);
                    if (planningOutcome.needsUserInput) {
                        return;
                    }
                    if (!planningOutcome.success) {
                        taskState.overallSuccess = false;
                        taskState.responseMessage = planningOutcome.message || "Planning failed.";
                        taskState.finalAnswer = JSON.stringify(planningOutcome.rawResponse || {});
                        return;
                    }
                } else if (taskState.executionMode === EXECUTE_PLANNED_TASK && taskState.planStages?.length > 0) {
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SKIPPED", "Skipping planning as plan was loaded."));
                }

                if (taskState.needsUserInput) { // Re-check after planning, as planning might ask a question
                    return;
                }

                if (taskState.executionMode === PLAN_ONLY) {
                    taskState.responseMessage = "Plan created and saved.";
                    taskState.finalAnswer = JSON.stringify(taskState.planStages);
                    taskState.overallSuccess = true;
                    return;
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
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_PRE_SYNTHESIZED", "Synthesis skipped, answer pre-synthesized."));
                }

            } catch (error) {
                console.error(\`Critical error in OrchestratorAgent.handleUserTask for \${taskState?.taskId || parentTaskId || 'unknown'}: \${error.stack}\`);
                if (taskState) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("HANDLE_USER_TASK_CRITICAL_ERROR", \`Critical error: \${error.message}\`));
                    taskState.overallSuccess = false;
                    taskState.responseMessage = \`Critical error: \${error.message.substring(0, 200)}\`;
                } else {
                    const errorTaskId = parentTaskId || Date.now().toString() + '_init_fail';
                    const tempJournal = [this._createOrchestratorJournalEntry("HANDLE_USER_TASK_INIT_ERROR", \`Critical init error: \${error.message}\`)];
                    try {
                        const errBaseDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                        const errDatedDir = path.join(errBaseDir, new Date().toISOString().split('T')[0]);
                        const errTaskDir = path.join(errDatedDir, \`task_\${errorTaskId}\`);
                        await fs.ensureDir(errTaskDir);
                        await fs.writeJson(path.join(errTaskDir, 'orchestrator_journal.json'), tempJournal, { spaces: 2 });
                    } catch (e) { console.error("Failed to save error journal for pre-init failure", e); }
                    return { success: false, message: \`Critical initialization error: \${error.message.substring(0,200)}\`, taskId: errorTaskId, data: null, journal: tempJournal };
                }
            } finally {
                if (taskState) {
                    await this._finalizeTaskProcessing(taskState);
                }
            }
            return {
                success: taskState.overallSuccess, message: taskState.responseMessage,
                taskId: taskState.taskId, data: taskState.finalAnswer,
                journal: taskState.finalJournalEntries,
                needsUserInput: taskState.needsUserInput,
                pendingQuestionId: taskState.pendingQuestionId
            };
        }
    }
    export default OrchestratorAgent;
