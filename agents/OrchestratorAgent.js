// OrchestratorAgent.js
    import fs from 'fs-extra';
    import path from 'path';
    import PlanExecutor from '../core/PlanExecutor.js';
    import { PlanManager } from './PlanManager.js';
    import { EXECUTE_FULL_PLAN, PLAN_ONLY, SYNTHESIZE_ONLY, EXECUTE_PLANNED_TASK } from '../utils/constants.js';
    import MemoryManager from '../core/MemoryManager.js';
    import ConfigManager from '../core/ConfigManager.js';
    import { loadTaskState } from '../utils/taskStateUtil.js';
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

        async _processUserClarification(taskState) {
            if (!taskState.needsUserInput || !taskState.pendingQuestionId) return;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_CHECK_STARTED", \`Checking for response to QID \${taskState.pendingQuestionId}\`));
            const chatHistory = await taskState.memoryManager.getChatHistory(taskState.taskDirPath, { sort_order: 'asc' });
            const agentQuestionMessage = chatHistory.find(msg => msg.sender?.id === 'OrchestratorAgent' && msg.content?.questionDetails?.questionId === taskState.pendingQuestionId);

            if (!agentQuestionMessage) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_ERROR", \`Agent's question \${taskState.pendingQuestionId} not found.\`));
                return;
            }
            const agentQuestionTimestamp = new Date(agentQuestionMessage.timestamp);
            const userResponse = chatHistory.find(msg => msg.sender?.role === 'user' && new Date(msg.timestamp) > agentQuestionTimestamp);

            if (userResponse?.content?.text) {
                const userAnswerText = userResponse.content.text;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_RECEIVED", \`User responded to \${taskState.pendingQuestionId}: "\${userAnswerText.substring(0,100)}..."\`));
                taskState.currentOriginalTask += \`\n\nUser Clarification (for QID \${taskState.pendingQuestionId}): \${userAnswerText}\`;
                taskState.needsUserInput = false;
                taskState.pendingQuestionId = null;
                taskState.responseMessage = 'User clarification processed. Resuming task.';
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_PROCESSED", "User input processed."));
            } else {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_CLARIFICATION_NOT_FOUND", \`No new user response for \${taskState.pendingQuestionId}.\`));
                taskState.responseMessage = agentQuestionMessage.content.text;
                taskState.overallSuccess = false;
            }
        }

        async _initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, existingState = null) {
            // ... (Implementation from Turn 37 - no changes in this step)
            let taskId, taskDirPath, finalJournalEntries, currentWorkingContext, uploadedFilePaths, planStages,
                lastExecutionContext, currentOriginalTask, needsUserInput, pendingQuestionId, responseMessage,
                currentWebSearchResults, lastError;

            if (existingState) {
                taskId = existingState.taskId;
                taskDirPath = existingState.taskDirPath;
                finalJournalEntries = existingState.finalJournalEntries || [this._createOrchestratorJournalEntry("TASK_RESUMED", \`Task \${taskId} resumed.\`)];
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
            } else {
                taskId = taskIdToLoad ? taskIdToLoad.split('_')[1] : Date.now().toString();
                const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
                const datedTasksDirPath = path.join(baseTaskDir, new Date().toISOString().split('T')[0]);
                taskDirPath = path.join(datedTasksDirPath, \`task_\${taskId}\`);

                await fs.ensureDir(taskDirPath);
                await fs.ensureDir(path.join(taskDirPath, 'uploaded_files'));
                await this.memoryManager.initializeTaskMemory(taskDirPath);

                finalJournalEntries = [this._createOrchestratorJournalEntry("TASK_INITIALIZED", \`Task \${taskId} (\${executionMode}) initialized.\`, { parentTaskId, taskIdToLoad })];
                currentWorkingContext = 'No CWC generated yet.';
                currentOriginalTask = userTaskString;
                uploadedFilePaths = []; planStages = null; lastExecutionContext = null;
                needsUserInput = false; pendingQuestionId = null; responseMessage = '';
                currentWebSearchResults = null; lastError = null;

                if (taskIdToLoad && executionMode !== EXECUTE_FULL_PLAN && executionMode !== PLAN_ONLY) {
                    const loadTaskDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskIdToLoad.split('_')[1]}\`);
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
                         finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOAD_FAILED", \`Could not load CWC: \${error.message}\`, { taskIdToLoad }));
                    }
                }
                const taskDefinitionContent = \`# Task: \${taskId}\nUser Task: \${currentOriginalTask}\nMode: \${executionMode}\`;
                await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', taskDefinitionContent);
                if (currentOriginalTask?.trim()) {
                    await this.memoryManager.addChatMessage(taskDirPath, {taskId, senderId: parentTaskId || 'user_initial', role: 'user', content: {type:'text', text:currentOriginalTask}});
                }
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

        async _notifyAndExecuteSearch(taskState, searchQuery) {
            // ... (Implementation from Turn 39 - no changes in this step, but it now has a subsequent step)
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("WEB_SEARCH_INITIATED", \`Search query: "\${searchQuery}"\`));
            const searchNotificationText = \`Performing web search for: "\${searchQuery}"...\`;
            const agentSearchNotificationMessage = {
                taskId: taskState.taskId, senderId: 'OrchestratorAgent', role: 'assistant',
                content: { type: 'agent_status', text: searchNotificationText }
            };
            const savedNotification = await taskState.memoryManager.addChatMessage(taskState.taskDirPath, agentSearchNotificationMessage);
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_NOTIFIED_OF_SEARCH", \`Notification sent, chat msg ID: \${savedNotification.id}\`));
            // taskState.responseMessage = searchNotificationText; // This will be overwritten by search results or summary

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("WEB_SEARCH_EXECUTION_STARTED", \`Executing WebSearchTool for: "\${searchQuery}"\`));
            taskState.currentWebSearchResults = null;
            taskState.lastError = null;

            const searchStepId = \`adhoc_search_\${uuidv4().substring(0,8)}\`;
            const singleStepPlan = [[ { stepId: searchStepId, tool_name: "WebSearchTool", sub_task_input: { query: searchQuery }, narrative_step: \`Perform web search for: \${searchQuery}\`, assigned_agent_role: "ResearchAgent" } ]];

            try {
                const searchExecutionResult = await taskState.planExecutor.executePlan( singleStepPlan, taskState.taskId, taskState.currentOriginalTask );
                if (searchExecutionResult.journalEntries?.length) taskState.finalJournalEntries.push(...searchExecutionResult.journalEntries);
                if (searchExecutionResult.success && searchExecutionResult.executionContext?.length > 0) {
                    const lastStepOutcome = searchExecutionResult.executionContext[0];
                    if (lastStepOutcome.stepId === searchStepId && lastStepOutcome.status === "COMPLETED") {
                        taskState.currentWebSearchResults = lastStepOutcome.processed_result_data || lastStepOutcome.raw_result_data;
                        const resultsCount = Array.isArray(taskState.currentWebSearchResults) ? taskState.currentWebSearchResults.length : (taskState.currentWebSearchResults ? 1 : 0);
                        taskState.responseMessage = \`Web search for "\${searchQuery}" completed. Found \${resultsCount} results. Summarizing...\`; // Temp message
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("WEB_SEARCH_EXECUTION_SUCCESS", \`Query: "\${searchQuery}", Results: \${resultsCount}\`));
                        taskState.currentOriginalTask += \`\n\nSystem Note: Web search for "\${searchQuery}" yielded \${resultsCount} results. Raw results (first ~1KB):\n\${JSON.stringify(taskState.currentWebSearchResults).substring(0, 1000)}...\`;
                    } else { throw new Error(lastStepOutcome.error_details?.message || "WebSearchTool step did not complete successfully."); }
                } else { throw new Error(searchExecutionResult.failedStepDetails?.error_details?.message || "Web search execution failed."); }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("WEB_SEARCH_EXECUTION_ERROR", \`Error: \${error.message}\`, { query: searchQuery }));
                taskState.lastError = { message: error.message, source: "WebSearchToolExecution" };
                taskState.responseMessage = \`Failed to execute web search for "\${searchQuery}".\`;
            }
            return taskState;
        }

        async _summarizeAndPresentSearchResults(taskState, searchQuery) {
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_PROCESSING_STARTED", \`Processing search results for query: "\${searchQuery}"\`));
            let messageText;

            if (taskState.lastError) {
                messageText = \`There was an error during the web search for "\${searchQuery}": \${taskState.lastError.message}\`;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_PROCESSING_ERROR", messageText));
            } else if (!taskState.currentWebSearchResults || (Array.isArray(taskState.currentWebSearchResults) && taskState.currentWebSearchResults.length === 0)) {
                messageText = \`Sorry, the web search for "\${searchQuery}" did not yield any results.\`;
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_PROCESSING_NO_RESULTS", messageText));
            } else {
                const topResults = Array.isArray(taskState.currentWebSearchResults)
                    ? taskState.currentWebSearchResults.slice(0, 5)
                    : [taskState.currentWebSearchResults]; // Handle if results is single object

                const formattedResultsString = topResults.map((res, index) =>
                    \`Result \${index + 1}:\nTitle: \${res.title || 'N/A'}\nLink: \${res.link || 'N/A'}\nSnippet: \${res.snippet || 'N/A'}\`
                ).join('\n\n');

                const summarizationSystemPrompt = "You are an AI assistant. Your task is to summarize the provided web search results in the context of the original user query.";
                const summarizationUserPrompt = \`Original search query: "\${searchQuery}"

Search Results (Top \${topResults.length}):
\${formattedResultsString}

Please provide a concise summary of these search results (2-4 sentences). If possible, directly answer the user's implicit question that led to this search. Highlight 1-2 most relevant sources (titles) if they are critical for the answer. Do not just list the results.\`;

                const summaryMessages = [
                    { role: 'system', content: summarizationSystemPrompt },
                    { role: 'user', content: summarizationUserPrompt }
                ];

                try {
                    const summaryModel = taskState.aiService.baseConfig?.summarizationModel || taskState.aiService.baseConfig?.defaultModel || 'claude-3-haiku-20240307';
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_SUMMARIZATION_INVOKED", \`Invoking LLM (\${summaryModel}) for search result summarization.\`));

                    const preparedContext = await taskState.aiService.prepareContextForModel(summaryMessages, { modelName: summaryModel });
                    const summarizedText = await taskState.aiService.completeChat(preparedContext || summaryMessages, { model: summaryModel, temperature: 0.4 });

                    if (summarizedText?.trim()) {
                        messageText = summarizedText.trim();
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_SUMMARIZATION_SUCCESS", \`Summarized search results: \${messageText.substring(0, 200)}...\`));
                    } else {
                        messageText = "I found some search results, but encountered an issue summarizing them. You can review the raw data that was added to the task context.";
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_SUMMARIZATION_EMPTY", "LLM returned empty summary."));
                    }
                } catch (error) {
                    messageText = \`I found search results, but an error occurred while summarizing them: \${error.message}. You can review the raw data added to the task context.\`;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_SUMMARIZATION_ERROR", \`Error: \${error.message}\`));
                    taskState.lastError = { message: \`Summarization error: \${error.message}\`, source: "SummarizationLLM" };
                }
            }

            const agentResponseMessage = {
                taskId: taskState.taskId,
                senderId: 'OrchestratorAgent',
                role: 'assistant',
                content: { type: 'text', text: messageText }
            };
            await taskState.memoryManager.addChatMessage(taskState.taskDirPath, agentResponseMessage);
            taskState.responseMessage = messageText; // This will be the final message for this turn
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SEARCH_RESULTS_PRESENTED_TO_USER", "Final search summary/status sent to user."));
            return taskState;
        }

        async _handleSynthesizeOnlyMode(taskState) { /* ... no change ... */ }
        async _handleExecutePlannedTaskMode(taskState) { /* ... no change ... */ }
        async _performPlanningPhase(taskState) { /* ... no change ... */ }
        async _performExecutionPhase(taskState) { /* ... no change ... */ }
        async _performCwcUpdateLLM(taskState) { /* ... no change ... */ }
        async _performFinalSynthesis(taskState) { /* ... no change ... */ }
        async _finalizeTaskProcessing(taskState) { /* ... no change ... */ }

        async handleUserTask(userTaskString, uploadedFiles, parentTaskId = null, taskIdToLoad = null, executionMode = EXECUTE_FULL_PLAN) {
            let taskState;
            let loadedStateForResumption = null;

            if (taskIdToLoad) { /* ... state loading logic from Turn 37 ... */ }

            try {
                taskState = await this._initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode, loadedStateForResumption);

                if (userTaskString && (!loadedStateForResumption || userTaskString !== loadedStateForResumption.userTaskString)) {
                     await this.memoryManager.addChatMessage(taskState.taskDirPath, { taskId: taskState.taskId, senderId: parentTaskId || 'user_resuming_prompt', role: 'user', content: { type: 'text', text: userTaskString } });
                }
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                if (!loadedStateForResumption || uploadedFiles?.length > 0) {
                    await this._processAndSaveUploadedFiles(uploadedFiles, taskState);
                }

                // --- Ad-hoc Search Query Classification & Execution ---
                // TODO: Implement LLM-based classification of taskState.currentOriginalTask or latest user message.
                // This is a placeholder for where that logic would go.
                let classifiedSearchQuery = null; // Example: "benefits of AI in software engineering"
                // if (taskState.currentOriginalTask.toLowerCase().includes("search for:")) { // Dummy trigger
                //    classifiedSearchQuery = taskState.currentOriginalTask.substring(taskState.currentOriginalTask.toLowerCase().indexOf("search for:") + "search for:".length).trim();
                // }

                if (classifiedSearchQuery) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("ADHOC_SEARCH_TRIGGERED", \`Ad-hoc search triggered for query: \${classifiedSearchQuery}\`));
                    taskState = await this._notifyAndExecuteSearch(taskState, classifiedSearchQuery);
                    taskState = await this._summarizeAndPresentSearchResults(taskState, classifiedSearchQuery);
                    // After search and presentation, the agent's turn for this specific ad-hoc query is done.
                    // The taskState.responseMessage is now the summary (or error/no results message).
                    // We might want to set overallSuccess based on whether the summary was positive.
                    // For now, if summarization happened, consider this interaction path successful.
                    taskState.overallSuccess = !taskState.lastError; // Success if search and summary had no major errors
                    return; // Goes to finally block
                }
                // --- End Ad-hoc Search ---

                if (taskState.executionMode === SYNTHESIZE_ONLY) { return await this._handleSynthesizeOnlyMode(taskState); }
                if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                    if (!taskState.planStages?.length) { await this._handleExecutePlannedTaskMode(taskState); }
                    if (!taskState.overallSuccess) { return; }
                }
                if (taskState.needsUserInput) { return; } // Check after clarification processing

                if (taskState.executionMode === PLAN_ONLY || (taskState.executionMode === EXECUTE_FULL_PLAN && (!taskState.planStages?.length) )) {
                    const planningOutcome = await this._performPlanningPhase(taskState);
                    if (planningOutcome.needsUserInput) { return; }
                    if (!planningOutcome.success) {
                        taskState.overallSuccess = false; taskState.responseMessage = planningOutcome.message || "Planning failed.";
                        taskState.finalAnswer = JSON.stringify(planningOutcome.rawResponse || {}); return;
                    }
                } else if (taskState.executionMode === EXECUTE_PLANNED_TASK && taskState.planStages?.length > 0) {
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SKIPPED", "Skipping planning."));
                }

                if (taskState.needsUserInput) { return; } // Check after planning (clarifying question)

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
            } catch (error) {
                console.error(\`Critical error in OrchestratorAgent.handleUserTask for \${taskState?.taskId || parentTaskId || 'unknown'}: \${error.stack}\`);
                if (taskState) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("HANDLE_USER_TASK_CRITICAL_ERROR", \`Critical error: \${error.message}\`));
                    taskState.overallSuccess = false; taskState.responseMessage = \`Critical error: \${error.message.substring(0, 200)}\`;
                } else { /* ... error handling for no taskState ... */
                    const errorTaskId = parentTaskId || Date.now().toString() + '_init_fail';
                    const tempJournal = [this._createOrchestratorJournalEntry("HANDLE_USER_TASK_INIT_ERROR", \`Critical init error: \${error.message}\`)];
                    return { success: false, message: \`Critical initialization error: \${error.message.substring(0,200)}\`, taskId: errorTaskId, data: null, journal: tempJournal };
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
    export default OrchestratorAgent;
