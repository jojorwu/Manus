// OrchestratorAgent.js
    import fs from 'fs-extra';
    import path from 'path';
    // import crypto from 'crypto'; // No longer needed here if Gemini service handles its cache display name hashing
    import PlanExecutor from '../core/PlanExecutor.js';
    import { PlanManager } from './PlanManager.js';
    import { EXECUTE_FULL_PLAN, PLAN_ONLY, SYNTHESIZE_ONLY, EXECUTE_PLANNED_TASK } from '../utils/constants.js';
    import MemoryManager from '../core/MemoryManager.js';
    import ConfigManager from '../core/ConfigManager.js';
    import { loadTaskState } from '../utils/taskStateUtil.js';

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

        async _initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode) {
            const taskId = taskIdToLoad ? taskIdToLoad.split('_')[1] : Date.now().toString();
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const datedTasksDirPath = path.join(baseTaskDir, new Date().toISOString().split('T')[0]);
            const taskDirPath = path.join(datedTasksDirPath, \`task_\${taskId}\`);

            await fs.ensureDir(taskDirPath);
            await fs.ensureDir(path.join(taskDirPath, 'uploaded_files'));

            const finalJournalEntries = [this._createOrchestratorJournalEntry("TASK_INITIALIZED", \`Task \${taskId} (\${executionMode}) initialized.\`, { parentTaskId, taskIdToLoad })];

            let currentWorkingContext = 'No CWC (Current Working Context) has been generated yet for this task.';
            if (taskIdToLoad) {
                const loadTaskDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskIdToLoad.split('_')[1]}\`);
                try {
                    const loadedCwc = await this.memoryManager.loadMemory(loadTaskDir, 'cwc.md'); // Prioritize cwc.md
                    if (loadedCwc) {
                        currentWorkingContext = loadedCwc;
                    } else { // Fallback to json if cwc.md is not found or empty
                        const loadedCwcJson = await this.memoryManager.loadMemory(loadTaskDir, 'current_working_context.json', {isJson: true});
                        if (loadedCwcJson && loadedCwcJson.CWC) currentWorkingContext = loadedCwcJson.CWC;
                    }
                    if (currentWorkingContext !== 'No CWC (Current Working Context) has been generated yet for this task.') {
                         finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "Existing CWC loaded.", { taskIdToLoad }));
                    }
                } catch (error) {
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOAD_FAILED", \`Could not load existing CWC: \${error.message}\`, { taskIdToLoad, error: error.message }));
                }
            }

            const taskDefinitionContent = \`# Task Definition for Task ID: \${taskId}\n\n**User Task:**\n\${userTaskString}\n\n**Execution Mode:** \${executionMode}\n\`;
            await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', taskDefinitionContent);
            finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_DEFINITION_SAVED", "Task definition saved."));

            if (userTaskString && userTaskString.trim() !== '') {
                await this.memoryManager.addChatMessage(taskDirPath, { role: 'user', content: userTaskString });
            }

            const tokenizerFn = this.aiService.getTokenizer();
            const maxTokenLimitForContextAssembly = (this.aiService.getMaxContextTokens() || 32000) * 0.8;
            const workerAgentCapabilitiesConfig = this.agentCapabilities; // Placeholder for more robust loading

            return {
                taskId, parentTaskIdFromCall: parentTaskId, taskDirPath,
                stateFilePath: path.join(taskDirPath, 'task_state.json'),
                journalFilePath: path.join(taskDirPath, 'orchestrator_journal.json'),
                finalJournalEntries, currentWorkingContext, userTaskString, executionMode, taskIdToLoad,
                tokenizerFn, maxTokenLimitForContextAssembly, uploadedFilePaths: [], planStages: null,
                overallSuccess: false, lastExecutionContext: null, finalAnswer: '', responseMessage: '',
                currentOriginalTask: userTaskString, CHAT_HISTORY_LIMIT: 20, DEFAULT_MEGA_CONTEXT_TTL: 3600,
                DEFAULT_GEMINI_CACHED_CONTENT_TTL: 3600, MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE: 1024,
                aiService: this.aiService, memoryManager: this.memoryManager,
                planManager: this.planManager, planExecutor: this.planExecutor,
                workerAgentCapabilities: workerAgentCapabilitiesConfig,
            };
        }

        async _processAndSaveUploadedFiles(uploadedFiles, taskState) {
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
            // ... (Implementation as per Turn 20 - largely unchanged, relies on _performFinalSynthesis)
            if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_ERROR", "taskIdToLoad is required for SYNTHESIZE_ONLY mode."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for SYNTHESIZE_ONLY mode.";
                return { success: false, message: taskState.responseMessage, parentTaskId: taskState.parentTaskIdFromCall, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: null };
            }
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const taskToLoadDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskState.taskIdToLoad.split('_')[1]}\`);
            const loadPath = path.join(taskToLoadDir, 'task_state.json');
            const loadResult = await loadTaskState(loadPath);

            if (!loadResult.success || !loadResult.taskState) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_LOAD_FAILED", \`Failed to load state for taskId \${taskState.taskIdToLoad}.\`, { path: loadPath }));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Failed to load state for SYNTHESIZE_ONLY (taskId: \${taskState.taskIdToLoad}).\`;
                return { success: false, message: taskState.responseMessage, parentTaskId: taskState.parentTaskIdFromCall, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: null };
            }

            const loadedState = loadResult.taskState;
            taskState.currentOriginalTask = loadedState.userTaskString || loadedState.currentOriginalTask || taskState.userTaskString;
            taskState.currentWorkingContext = loadedState.currentWorkingContext || taskState.currentWorkingContext;
            taskState.lastExecutionContext = loadedState.executionContext || [];
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_STATE_LOADED", \`State loaded for taskId \${taskState.taskIdToLoad}.\`));
            await this._performFinalSynthesis(taskState);
            return { success: taskState.overallSuccess, message: taskState.responseMessage, parentTaskId: taskState.parentTaskIdFromCall, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: taskState.finalAnswer };
        }

        async _handleExecutePlannedTaskMode(taskState) {
            // ... (Implementation as per Turn 20 - largely unchanged)
            if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_ERROR", "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode.";
                return;
            }
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const taskToLoadDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskState.taskIdToLoad.split('_')[1]}\`);
            const loadPath = path.join(taskToLoadDir, 'task_state.json');
            const loadResult = await loadTaskState(loadPath);

            if (!loadResult.success || !loadResult.taskState || !loadResult.taskState.plan || loadResult.taskState.plan.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_LOAD_FAILED", \`Failed to load state or no plan found for taskId \${taskState.taskIdToLoad}.\`, { path: loadPath }));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Failed to load state or no plan found for EXECUTE_PLANNED_TASK (taskId: \${taskState.taskIdToLoad}).\`;
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
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan."));
            const knownAgentRoles = (taskState.workerAgentCapabilities?.roles || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (taskState.workerAgentCapabilities?.roles || []).forEach(agent => {
                if (agent.role && Array.isArray(agent.tools)) {
                    knownToolsByRole[agent.role] = agent.tools.map(t => typeof t === 'string' ? t : t.name);
                }
            });

            let llmContextForPlanning;
            let cacheHandleForPlanning = null;

            const planningSystemPrompt = "You are an AI assistant responsible for planning complex tasks. Create a detailed, step-by-step plan. Each step must specify an agent role and a tool for that agent. Ensure references to outputs of previous steps are correctly formatted as @{outputs.step_id.field_name}.";
            const contextSpecification = {
                systemPrompt: planningSystemPrompt, // Will be handled by prepareContextForModel if service supports it, or combined by PlanManager
                includeTaskDefinition: true, uploadedFilePaths: taskState.uploadedFilePaths,
                maxLatestKeyFindings: 5, keyFindingsRelevanceQuery: taskState.currentOriginalTask,
                chatHistory: await taskState.memoryManager.getChatHistory(taskState.taskDirPath, taskState.CHAT_HISTORY_LIMIT),
                maxTokenLimit: taskState.maxTokenLimitForContextAssembly * 0.7,
                customPreamble: "Please generate a plan based on the following context:",
                enableMegaContextCache: false, // assembleMegaContext's own cache, not Gemini's Content Caching
                originalUserTask: taskState.currentOriginalTask,
                currentWorkingContext: taskState.currentWorkingContext,
            };
            const megaContextResult = await taskState.memoryManager.assembleMegaContext(taskState.taskDirPath, contextSpecification, taskState.tokenizerFn);

            if (!megaContextResult.success) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", \`Planning context assembly failed: \${megaContextResult.error}\`));
                return { success: false, message: "Failed to assemble context for planning." };
            }
            llmContextForPlanning = megaContextResult.contextString; // This is the primary text content

            const planningModelName = taskState.aiService.baseConfig?.planningModel || taskState.aiService.baseConfig?.defaultModel || 'gemini-1.5-pro-latest';

            // The main content is llmContextForPlanning (string from assembleMegaContext)
            // The system prompt for planning is planningSystemPrompt.
            // These will be passed to prepareContextForModel.
            const prepOptions = {
                modelName: planningModelName,
                systemMessage: planningSystemPrompt, // Pass system prompt via options
                cacheConfig: { // Relevant for services like Gemini that support content caching
                    ttlSeconds: taskState.DEFAULT_GEMINI_CACHED_CONTENT_TTL,
                    displayName: \`plan_ctx_\${taskState.taskId.substring(0,10)}\`, // Services can use this if they need a display name
                    // taskId could also be part of cacheConfig if needed by service's prepareContextForModel
                }
            };

            // `prepareContextForModel` will handle service-specific formatting (e.g., creating Content[] for Gemini, Messages[] for OpenAI/Anthropic)
            // and caching for services like Gemini.
            // For Gemini, contextParts could be the main user content string, and systemMessage is in options.
            // For OpenAI/Anthropic, contextParts could be the main user content string, and systemMessage from options is prepended.
            const preparedOutput = await taskState.aiService.prepareContextForModel(llmContextForPlanning, prepOptions);

            const llmParamsForPlanManager = { model: planningModelName, temperature: 0.4 };
            let actualContextForPlanManager = llmContextForPlanning; // Default to the raw string context

            if (preparedOutput) {
                if (preparedOutput.cacheName) { // Indicates Gemini caching was successful
                    llmParamsForPlanManager.cacheHandle = preparedOutput; // Pass the whole cache handle
                    // For Gemini with cache, the 'actualContentForPlanManager' (prompt for the LLM call)
                    // might just be the latest turn or specific instructions, not the whole cached content.
                    // However, PlanManager currently expects 'megaContext' to be the main context.
                    // This part needs PlanManager to be aware of how to use cacheHandle.
                    // For now, we still pass the original llmContextForPlanning as megaContext.
                    // The AI service's generateText/completeChat will use the cacheHandle + new content.
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_CONTEXT_PREPARED_WITH_CACHE", \`AI Service prepared context with cache: \${preparedOutput.cacheName}\`));
                } else {
                    // If not a cacheHandle, preparedOutput is likely the formatted context (e.g., messages array for OpenAI/Anthropic)
                    actualContextForPlanManager = preparedOutput;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_CONTEXT_PREPARED", "AI Service prepared context for planning."));
                }
            }
            // Else, if preparedOutput is null/undefined, use raw llmContextForPlanning and no cacheHandle.

            const memoryContextForPlanManager = {
                megaContext: actualContextForPlanManager, // This is now potentially a messages array or string
                llmParams: llmParamsForPlanManager
            };

            const planResult = await taskState.planManager.getPlan(
                taskState.currentOriginalTask,
                knownAgentRoles,
                knownToolsByRole,
                memoryContextForPlanManager, // Contains megaContext string and llmParams (with potential cacheHandle)
                taskState.currentWorkingContext
            );

            if (!planResult.success || !planResult.plan || planResult.plan.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", \`Planning failed: \${planResult.message || 'No plan generated'}\`));
                return { success: false, message: planResult.message || "Planning failed.", rawResponse: planResult.rawResponse };
            }

            taskState.planStages = planResult.plan;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", \`Plan obtained. Stages: \${taskState.planStages.length}\`));
            await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
            return { success: true };
        }

        async _performExecutionPhase(taskState) {
            // ... (Implementation as per Turn 20 - largely unchanged)
            if (!taskState.planStages || taskState.planStages.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_SKIPPED_NO_PLAN", "Execution skipped as no plan was available."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "Execution skipped as no plan was available.";
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_INVOKED", "Attempting to execute plan.", { planStageCount: taskState.planStages.length }));
            try {
                const executionResult = await taskState.planExecutor.executePlan(taskState.planStages, taskState.taskId, taskState.currentOriginalTask);
                taskState.lastExecutionContext = executionResult.executionContext || [];
                if (executionResult.journalEntries?.length) taskState.finalJournalEntries.push(...executionResult.journalEntries);
                taskState.overallSuccess = executionResult.success;
                if (executionResult.updatesForWorkingContext) {
                    taskState.executionKeyFindings = executionResult.updatesForWorkingContext.keyFindings || [];
                    taskState.executionErrorsEncountered = executionResult.updatesForWorkingContext.errorsEncountered || [];
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_CONTEXT_UPDATES_RECEIVED", \`Received \${taskState.executionKeyFindings.length} key findings and \${taskState.executionErrorsEncountered.length} errors.\`));
                }
                if (executionResult.finalAnswerSynthesized && executionResult.finalAnswer) {
                    taskState.finalAnswer = executionResult.finalAnswer;
                    taskState.wasFinalAnswerPreSynthesized = true;
                    taskState.responseMessage = "Final answer synthesized during plan execution.";
                }
                if (!executionResult.success) {
                    taskState.failedStepDetails = executionResult.failedStepDetails;
                    taskState.responseMessage = \`Execution failed: \${taskState.failedStepDetails?.error_details?.message || 'Unknown error'}\`;
                } else {
                    taskState.responseMessage = "Plan executed successfully.";
                }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_CRITICAL_ERROR", \`Critical error: \${error.message}\`));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Critical error during plan execution: \${error.message}\`;
                (taskState.lastExecutionContext = taskState.lastExecutionContext || []).push({ stepId: "EXECUTION_CRASH", narrative_step: "Critical error", status: "FAILED", error_details: { message: error.message }});
            }
            return taskState;
        }

        async _performCwcUpdateLLM(taskState) {
            if (!taskState.lastExecutionContext?.length || !taskState.overallSuccess) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SKIPPED", "Skipped CWC update due to no execution context or prior failure."));
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_STARTED", "Starting CWC update."));
            try {
                const findingsText = taskState.executionKeyFindings?.length ? "Key Findings:\n" + taskState.executionKeyFindings.map(f => \`- \${f.sourceStepNarrative}: \${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}\`).join("\n") : "No new key findings.";
                const errorsText = taskState.executionErrorsEncountered?.length ? "Errors:\n" + taskState.executionErrorsEncountered.map(e => \`- \${e.sourceStepNarrative}: \${e.errorMessage}\`).join("\n") : "No new errors.";
                const cwcPromptParts = [
                    {role: "system", content: "You are an AI assistant. Update the Current Working Context (CWC) based on the provided information. The CWC should be a concise summary of the task's current state, critical information, and next steps. Output only the updated CWC text."},
                    {role: "user", content: \`Previous CWC:\n\${taskState.currentWorkingContext}\n\nOriginal Task:\n\${taskState.currentOriginalTask}\n\nLast Execution Summary (Success: \${taskState.overallSuccess}):\n\${findingsText}\n\${errorsText}\n\nExecution History (last 5 steps):\n\${JSON.stringify(taskState.lastExecutionContext.slice(-5), null, 2)}\n\nProvide the updated CWC text:\`}
                ];

                const cwcModel = taskState.aiService.baseConfig?.cwcUpdateModel || taskState.aiService.baseConfig?.defaultModel || 'claude-3-haiku-20240307'; // Default to a fast model
                const preparedContext = await taskState.aiService.prepareContextForModel(cwcPromptParts, { modelName: cwcModel });

                const newCwcText = await taskState.aiService.completeChat(preparedContext || cwcPromptParts, { model: cwcModel, temperature: 0.5 });

                if (newCwcText?.trim()) {
                    taskState.currentWorkingContext = newCwcText.trim();
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SUCCESS", "CWC updated and saved."));
                } else {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_EMPTY_RESPONSE", "LLM returned empty CWC response."));
                }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_ERROR", \`Error updating CWC: \${error.message}\`));
            }
            return taskState;
        }

        async _performFinalSynthesis(taskState) {
            if (!taskState.overallSuccess || !taskState.lastExecutionContext?.length) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", "Skipped final synthesis due to prior failure or no execution context."));
                taskState.finalAnswer = taskState.finalAnswer || "Task not fully successful or no execution data for synthesis.";
                taskState.responseMessage = taskState.responseMessage || "Synthesis skipped.";
                return taskState;
            }
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_STARTED", "Starting final synthesis."));
            try {
                const synthesisPromptParts = [
                    {role: "system", content: "You are an AI assistant. Generate a final, comprehensive answer based on the task's execution. Address the user's original request directly. Present information clearly."},
                    {role: "user", content: \`Original User Task:\n\${taskState.currentOriginalTask}\n\nCurrent Working Context (CWC):\n\${taskState.currentWorkingContext}\n\nExecution History Summary:\n\${JSON.stringify(taskState.lastExecutionContext.map(s => ({step: s.narrative_step, status: s.status, result_preview: String(s.processed_result_data || s.raw_result_data).substring(0,100)})), null, 2)}\n\nProvide the final answer:\`}
                ];
                const synthesisModel = taskState.aiService.baseConfig?.synthesisModel || taskState.aiService.baseConfig?.defaultModel || 'claude-3-sonnet-20240229'; // Default to a capable model
                const preparedContext = await taskState.aiService.prepareContextForModel(synthesisPromptParts, { modelName: synthesisModel });
                const newFinalAnswer = await taskState.aiService.completeChat(preparedContext || synthesisPromptParts, { model: synthesisModel, temperature: 0.6 });

                if (newFinalAnswer?.trim()) {
                    taskState.finalAnswer = newFinalAnswer.trim();
                    taskState.responseMessage = "Final answer synthesized successfully.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SUCCESS", "Final answer synthesized."));
                    await taskState.memoryManager.addChatMessage(taskState.taskDirPath, { role: 'assistant', content: taskState.finalAnswer });
                } else {
                    taskState.finalAnswer = taskState.finalAnswer || "LLM returned empty final answer.";
                    taskState.responseMessage = taskState.responseMessage || "Final synthesis resulted in an empty answer.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_EMPTY_RESPONSE", "LLM returned empty final answer."));
                }
            } catch (error) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ERROR", \`Error during final synthesis: \${error.message}\`));
                taskState.finalAnswer = taskState.finalAnswer || \`Error during synthesis: \${error.message}\`;
                taskState.responseMessage = taskState.responseMessage || "Failed to synthesize final answer.";
            }
            return taskState;
        }

        async _finalizeTaskProcessing(taskState) {
            // ... (Implementation as per Turn 20 - largely unchanged)
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZING_TASK", "Finalizing task processing."));
            try {
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'orchestrator_journal.json', taskState.finalJournalEntries, { isJson: true });
                const finalStateToSave = {
                    taskId: taskState.taskId, parentTaskId: taskState.parentTaskIdFromCall, executionMode: taskState.executionMode,
                    userTaskString: taskState.userTaskString, currentOriginalTask: taskState.currentOriginalTask,
                    overallSuccess: taskState.overallSuccess, finalAnswer: taskState.finalAnswer, responseMessage: taskState.responseMessage,
                    plan: taskState.planStages, executionContext: taskState.lastExecutionContext,
                    currentWorkingContext: taskState.currentWorkingContext, savedUploadedFilePaths: taskState.uploadedFilePaths,
                    timestamp: new Date().toISOString(),
                    ...(taskState.failedStepDetails && { failedStepDetails: taskState.failedStepDetails }),
                };
                await fs.writeJson(taskState.stateFilePath, finalStateToSave, { spaces: 2 });
            } catch (saveError) {
                 taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZE_SAVE_ERROR", \`Error saving state/journal: \${saveError.message}\`));
            }
        }

        async handleUserTask(userTaskString, uploadedFiles, parentTaskId = null, taskIdToLoad = null, executionMode = EXECUTE_FULL_PLAN) {
            let taskState;
            try {
                taskState = await this._initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode);
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                await this._processAndSaveUploadedFiles(uploadedFiles, taskState);

                if (taskState.executionMode === SYNTHESIZE_ONLY) {
                    return await this._handleSynthesizeOnlyMode(taskState);
                }
                if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                    await this._handleExecutePlannedTaskMode(taskState);
                    if (!taskState.overallSuccess) {
                        return { success: false, message: taskState.responseMessage, taskId: taskState.taskId, data: null, journal: taskState.finalJournalEntries };
                    }
                }

                if (taskState.executionMode === PLAN_ONLY || (taskState.executionMode === EXECUTE_FULL_PLAN && (!taskState.planStages || taskState.planStages.length === 0) )) {
                    const planningOutcome = await this._performPlanningPhase(taskState);
                    if (!planningOutcome.success) {
                        taskState.overallSuccess = false;
                        taskState.responseMessage = planningOutcome.message || "Planning failed.";
                        taskState.finalAnswer = JSON.stringify(planningOutcome.rawResponse || {});
                        return;
                    }
                } else if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SKIPPED", "Skipping planning as plan was loaded."));
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

                if (!taskState.wasFinalAnswerPreSynthesized) { // If not presynthesized and not SYNTHESIZE_ONLY
                    await this._performFinalSynthesis(taskState); // This method now handles its own preconditions (overallSuccess, lastExecutionContext)
                } else {
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_PRE_SYNTHESIZED", "Final synthesis skipped as answer was pre-synthesized."));
                }

            } catch (error) {
                console.error(\`Critical error in OrchestratorAgent.handleUserTask for taskId \${taskState?.taskId || parentTaskId || 'unknown'}: \${error.stack}\`);
                if (taskState) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("HANDLE_USER_TASK_CRITICAL_ERROR", \`Critical error: \${error.message}\`));
                    taskState.overallSuccess = false;
                    taskState.responseMessage = \`Critical error: \${error.message.substring(0, 200)}\`;
                } else {
                    const errorTaskId = parentTaskId || Date.now().toString() + '_init_fail';
                    const tempJournal = [this._createOrchestratorJournalEntry("HANDLE_USER_TASK_INIT_ERROR", \`Critical error during init: \${error.message}\`)];
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
            };
        }
    }
    export default OrchestratorAgent;
