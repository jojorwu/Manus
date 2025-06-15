// Сохранить все оригинальные импорты (fs, path, PlanExecutor, PlanManager, AIService, OpenAIAPIService, GeminiAPIService, ClaudeAPIService, GroqApiService,ollamaApiService, AnthropicAPIService, MistralAPIService)
    import fs from 'fs-extra';
    import path from 'path';
    import crypto from 'crypto';
    import PlanExecutor from '../core/PlanExecutor.js';
    import { PlanManager } from './PlanManager.js'; // Assuming PlanManager is in the same directory, adjust if different
    // import { AIService } from '../services/AIService.js'; // AIService itself might not be directly used if specific services are always chosen
    // Specific AI services - these are used by OrchestratorAgent or passed to other components
    // import OpenAIAPIService from '../services/OpenAIAPIService.js';
    // import GeminiAPIService from '../services/GeminiAPIService.js';
    // ... other AI service imports
    import { EXECUTE_FULL_PLAN, PLAN_ONLY, SYNTHESIZE_ONLY, EXECUTE_PLANNED_TASK } from '../utils/constants.js';
    import MemoryManager from '../core/MemoryManager.js';
    import ConfigManager from '../core/ConfigManager.js'; // If used for loading agentCapabilities.json
    // import ReportGenerator from '../core/ReportGenerator.js'; // If used
    // import TaskQueue from '../core/TaskQueue.js'; // Not directly used by OrchestratorAgent methods, but by PlanExecutor
    import { loadTaskState } from '../utils/taskStateUtil.js'; // saveTaskState, saveTaskJournal are used in _finalizeTaskProcessing


    class OrchestratorAgent {
        constructor(activeAIService, taskQueue, memoryManager, reportGenerator, agentCapabilities, resultsQueue, savedTasksBaseDir) {
            this.aiService = activeAIService;
            this.taskQueue = taskQueue; // This is subTaskQueue
            this.memoryManager = memoryManager;
            this.reportGenerator = reportGenerator; // May be null
            this.agentCapabilities = agentCapabilities; // This is agentApiKeysConfig from index.js, might need to load more from ConfigManager
            this.resultsQueue = resultsQueue;
            this.savedTasksBaseDir = savedTasksBaseDir;

            // TODO: Load full agent capabilities (roles, tools) using ConfigManager if this.agentCapabilities is just API keys
            // For now, PlanManager receives agentApiKeysConfig. It might need more.
            this.planManager = new PlanManager(activeAIService, this.agentCapabilities);
            this.planExecutor = new PlanExecutor(
                this.taskQueue,
                this.resultsQueue,
                this.aiService,
                {}, // tools - PlanExecutor instantiates its own for now.
                this.savedTasksBaseDir
            );
            this.configManager = new ConfigManager(); // For loading configs if needed.
            console.log(\`OrchestratorAgent initialized with AI Service: \${activeAIService.constructor.name}, PlanExecutor configured.\`);
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

        async _initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode) {
            const taskId = taskIdToLoad ? taskIdToLoad.split('_')[1] : Date.now().toString();
            // Ensure datedTasksDirPath is robust, handles potential empty process.cwd() if run in unusual envs
            const baseTaskDir = this.savedTasksBaseDir || path.join(process.cwd(), 'tasks');
            const datedTasksDirPath = path.join(baseTaskDir, new Date().toISOString().split('T')[0]);
            const taskDirPath = path.join(datedTasksDirPath, \`task_\${taskId}\`);

            await fs.ensureDir(taskDirPath); // Use fs-extra's ensureDir
            await fs.ensureDir(path.join(taskDirPath, 'uploaded_files'));

            const finalJournalEntries = [this._createOrchestratorJournalEntry("TASK_INITIALIZED", \`Task \${taskId} (\${executionMode}) initialized.\`, { parentTaskId, taskIdToLoad })];
            console.log(\`OrchestratorAgent: Task \${taskId} initialized. Mode: \${executionMode}, User Task: '\${userTaskString?.substring(0,100)+'...'}', Parent Task ID: \${parentTaskId || 'N/A'}, Task ID to Load: \${taskIdToLoad || 'N/A'}\`);

            let currentWorkingContext = 'No CWC (Current Working Context) has been generated yet for this task.';
            if (taskIdToLoad) {
                // Construct path relative to baseTaskDir or datedTasksDirPath consistently
                const loadTaskDir = path.join(baseTaskDir, new Date().toISOString().split('T')[0], \`task_\${taskIdToLoad.split('_')[1]}\`); // Assuming it's from today for simplicity, or need better path logic
                try {
                    const loadedCwc = await this.memoryManager.loadMemory(loadTaskDir, 'cwc.md');
                    if (loadedCwc) {
                        currentWorkingContext = loadedCwc;
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "Existing CWC loaded.", { taskIdToLoad }));
                    }
                } catch (error) {
                    console.warn(\`Could not load existing CWC for task \${taskIdToLoad}: \${error.message}\`);
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOAD_FAILED", \`Could not load existing CWC: \${error.message}\`, { taskIdToLoad, error: error.message }));
                }
            }

            const taskDefinitionContent = \`# Task Definition for Task ID: \${taskId}\n\n**User Task:**\n\${userTaskString}\n\n**Execution Mode:** \${executionMode}\n\`;
            await this.memoryManager.overwriteMemory(taskDirPath, 'task_definition.md', taskDefinitionContent);
            finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_DEFINITION_SAVED", "Task definition saved."));

            if (userTaskString && userTaskString.trim() !== '') {
                await this.memoryManager.addChatMessage(taskDirPath, { role: 'user', content: userTaskString });
                finalJournalEntries.push(this._createOrchestratorJournalEntry("USER_TASK_LOGGED_TO_CHAT", "User task logged to chat history."));
            }

            const tokenizerFn = this.aiService.getTokenizer ? this.aiService.getTokenizer() : (text) => text.split(' ').length; // Fallback tokenizer
            const maxTokenLimitForContextAssembly = this.aiService.getMaxContextTokens ? this.aiService.getMaxContextTokens() * 0.8 : 32000;

            // TODO: Properly load workerAgentCapabilities using ConfigManager
            // For now, this.agentCapabilities (from constructor, likely API keys) is passed.
            // PlanManager needs actual roles/tools definitions. This is a temporary placeholder.
            const workerAgentCapabilitiesConfig = this.agentCapabilities;


            return {
                taskId,
                parentTaskIdFromCall: parentTaskId,
                taskDirPath, // Simplified, datedTasksDirPath can be derived if needed
                stateFilePath: path.join(taskDirPath, 'task_state.json'),
                journalFilePath: path.join(taskDirPath, 'orchestrator_journal.json'),
                finalJournalEntries,
                currentWorkingContext,
                userTaskString,
                executionMode,
                taskIdToLoad, // Keep taskIdToLoad in taskState for other methods
                tokenizerFn,
                maxTokenLimitForContextAssembly,
                uploadedFilePaths: [],
                planStages: null,
                overallSuccess: false, // Start with false, explicitly set to true on success paths
                lastExecutionContext: null,
                finalAnswer: '',
                responseMessage: '',
                currentOriginalTask: userTaskString, // Retain the original task string
                // Constants and configs that might be useful for helper methods
                CHAT_HISTORY_LIMIT: 20,
                DEFAULT_MEGA_CONTEXT_TTL: 3600,
                DEFAULT_GEMINI_CACHED_CONTENT_TTL: 3600,
                MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE: 1024,
                MAX_ERRORS_FOR_CWC_PROMPT: 3,
                // Core services access
                aiService: this.aiService,
                memoryManager: this.memoryManager,
                planManager: this.planManager,
                planExecutor: this.planExecutor,
                workerAgentCapabilities: workerAgentCapabilitiesConfig, // Placeholder for actual capabilities
            };
        }

        async _processAndSaveUploadedFiles(uploadedFiles, taskState) {
            if (uploadedFiles && uploadedFiles.length > 0) {
                const uploadedFilesDir = path.join(taskState.taskDirPath, 'uploaded_files');
                // fs.ensureDirSync(uploadedFilesDir); // ensureDir is async, already called in _initializeTaskEnvironment

                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SAVING_UPLOADED_FILES", \`Saving \${uploadedFiles.length} files.\`, { count: uploadedFiles.length }));
                for (const file of uploadedFiles) {
                    try {
                        const safeFileName = path.basename(file.name);
                        const absoluteFilePath = path.join(uploadedFilesDir, safeFileName);
                        await fs.writeFile(absoluteFilePath, file.content);
                        const relativeFilePathForContext = path.join('uploaded_files', safeFileName); // Relative to taskDirPath
                        taskState.uploadedFilePaths.push(relativeFilePathForContext);
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_SUCCESS", \`Saved: \${relativeFilePathForContext}\`, { fileName: file.name }));
                    } catch (uploadError) {
                        console.error(\`Error saving uploaded file '\${file.name}' for task \${taskState.taskId}: \${uploadError.message}\`);
                        taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FILE_SAVE_ERROR", \`Error saving \${file.name}: \${uploadError.message}\`, { fileName: file.name, error: uploadError.message }));
                    }
                }
            }
        }

        async _handleSynthesizeOnlyMode(taskState) {
            if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_ERROR", "taskIdToLoad is required for SYNTHESIZE_ONLY mode."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for SYNTHESIZE_ONLY mode.";
                // This return is for the special early exit from handleUserTask
                return { success: false, message: taskState.responseMessage, parentTaskId: taskState.parentTaskIdFromCall, taskId: taskState.taskId, journal: taskState.finalJournalEntries, data: null };
            }

            // Assuming dated path might be different, so reconstruct path to task to load
            // This logic needs to be robust if tasks can be from different dates.
            // For now, assuming task_state.json is at the root of the specific task_XXXX directory.
            const taskToLoadDir = path.dirname(taskState.taskDirPath); // up to .../tasks/YYYY-MM-DD/
            const loadPath = path.join(taskToLoadDir, \`task_\${taskState.taskIdToLoad.split('_')[1]}\`, 'task_state.json');

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
            // taskState.planStages = loadedState.plan || []; // Not strictly needed for synthesis-only from prior state
            taskState.lastExecutionContext = loadedState.executionContext || []; // Crucial for synthesis

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIZE_ONLY_STATE_LOADED", \`State loaded for taskId \${taskState.taskIdToLoad}. Original task: "\${taskState.currentOriginalTask}"\`));

            // Call the main synthesis method
            await this._performFinalSynthesis(taskState);

            // _performFinalSynthesis updates taskState.finalAnswer, taskState.responseMessage, and taskState.overallSuccess (implicitly true if it runs past checks)
            return {
                success: taskState.overallSuccess,
                message: taskState.responseMessage,
                parentTaskId: taskState.parentTaskIdFromCall,
                taskId: taskState.taskId,
                journal: taskState.finalJournalEntries,
                data: taskState.finalAnswer
            };
        }

        async _handleExecutePlannedTaskMode(taskState) {
            if (!taskState.taskIdToLoad) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_ERROR", "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode."));
                taskState.overallSuccess = false;
                taskState.responseMessage = "taskIdToLoad is required for EXECUTE_PLANNED_TASK mode.";
                return; // Modifies taskState, doesn't return early from main flow
            }

            const taskToLoadDir = path.dirname(taskState.taskDirPath);
            const loadPath = path.join(taskToLoadDir, \`task_\${taskState.taskIdToLoad.split('_')[1]}\`, 'task_state.json');
            const loadResult = await loadTaskState(loadPath);

            if (!loadResult.success || !loadResult.taskState || !loadResult.taskState.plan || loadResult.taskState.plan.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_LOAD_FAILED", \`Failed to load state or no plan found for taskId \${taskState.taskIdToLoad}.\`, { path: loadPath }));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Failed to load state or no plan found for EXECUTE_PLANNED_TASK (taskId: \${taskState.taskIdToLoad}).\`;
                return;
            }

            const loadedState = loadResult.taskState;
            // If user provided a new task string for EXECUTE_PLANNED_TASK, prioritize it. Otherwise, use loaded task.
            taskState.currentOriginalTask = taskState.userTaskString || loadedState.userTaskString || "";
            taskState.planStages = loadedState.plan;
            taskState.currentWorkingContext = loadedState.currentWorkingContext || taskState.currentWorkingContext;
            // taskState.lastExecutionContext = loadedState.executionContext || []; // Let current execution build its own context

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTE_PLANNED_STATE_LOADED", \`State and plan loaded for taskId \${taskState.taskIdToLoad}. Plan stages: \${taskState.planStages.length}\`));
            taskState.overallSuccess = true; // Mark as success for now, subsequent phases will run
        }

        async _performPlanningPhase(taskState) {
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan.", { executionMode: taskState.executionMode }));

            // These capabilities should ideally be loaded from a config file via ConfigManager
            const knownAgentRoles = (taskState.workerAgentCapabilities?.roles || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (taskState.workerAgentCapabilities?.roles || []).forEach(agent => {
                if (agent.role && Array.isArray(agent.tools)) {
                    knownToolsByRole[agent.role] = agent.tools.map(t => typeof t === 'string' ? t : t.name);
                }
            });

            let memoryContextForPlanning = {};
            try {
                // Using assembleMegaContext for comprehensive context gathering
                const contextSpecification = {
                    systemPrompt: "You are an AI assistant responsible for planning complex tasks. Create a detailed, step-by-step plan. Each step must specify an agent role and a tool for that agent. Ensure references to outputs of previous steps are correctly formatted as @{outputs.step_id.field_name}.",
                    includeTaskDefinition: true,
                    uploadedFilePaths: taskState.uploadedFilePaths,
                    maxLatestKeyFindings: 5, // Adjust as needed
                    keyFindingsRelevanceQuery: taskState.currentOriginalTask,
                    chatHistory: await taskState.memoryManager.getChatHistory(taskState.taskDirPath, taskState.CHAT_HISTORY_LIMIT),
                    maxTokenLimit: taskState.maxTokenLimitForContextAssembly * 0.7, // Reserve some tokens for plan manager's own additions
                    customPreamble: "Please generate a plan based on the following context:",
                    enableMegaContextCache: true,
                    megaContextCacheTTLSeconds: taskState.DEFAULT_MEGA_CONTEXT_TTL,
                    originalUserTask: taskState.currentOriginalTask,
                    currentWorkingContext: taskState.currentWorkingContext // Pass current CWC to planning
                };
                const megaContextResult = await taskState.memoryManager.assembleMegaContext(taskState.taskDirPath, contextSpecification, taskState.tokenizerFn);

                if (megaContextResult.success) {
                    memoryContextForPlanning.megaContext = megaContextResult.contextString;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_SUCCESS", \`Mega context for planning: \${megaContextResult.tokenCount} tokens.\`, { fromCache: megaContextResult.fromCache, tokenCount: megaContextResult.tokenCount }));

                    // Gemini Caching (if applicable)
                    if (taskState.aiService.getServiceName?.() === 'GeminiService' && typeof taskState.aiService.createCachedContent === 'function') {
                        const planningModelName = (taskState.aiService.baseConfig?.planningModel) || (taskState.aiService.defaultModel) || 'gemini-1.5-pro-latest';
                        const supportedCacheModels = ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest'];
                        if (supportedCacheModels.includes(planningModelName) && megaContextResult.tokenCount >= taskState.MIN_TOKEN_THRESHOLD_FOR_GEMINI_CACHE) {
                            // ... (Gemini caching logic as previously implemented) ...
                        }
                    }
                } else {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("MEGA_CONTEXT_ASSEMBLY_FAILURE", \`Planning context assembly failed: \${megaContextResult.error}\`, { error: megaContextResult.error }));
                    // Fallback to simpler context if mega context fails
                    memoryContextForPlanning.taskDefinition = await taskState.memoryManager.loadMemory(taskState.taskDirPath, 'task_definition.md', { defaultValue: taskState.currentOriginalTask });
                }
            } catch (memError) {
                console.warn(\`Error preparing planning context: \${memError.message}\`);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("MEMORY_CONTEXT_ERROR", \`Planning context prep failed: \${memError.message}\`, { error: memError.message }));
                memoryContextForPlanning.taskDefinition = taskState.currentOriginalTask; // Basic fallback
            }

            const planResult = await taskState.planManager.getPlan(taskState.currentOriginalTask, knownAgentRoles, knownToolsByRole, memoryContextForPlanning, taskState.currentWorkingContext);

            if (!planResult.success || !planResult.plan || planResult.plan.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", \`Planning failed: \${planResult.message || 'No plan generated'}\`, { error: planResult.message, rawResponse: planResult.rawResponse }));
                // Set overallSuccess to false only if planning is critical for this mode
                return { success: false, message: planResult.message || "Planning failed to produce a valid plan.", rawResponse: planResult.rawResponse };
            }

            taskState.planStages = planResult.plan;
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", \`Plan obtained. Stages: \${taskState.planStages.length}\`, { count: taskState.planStages.length, source: planResult.source }));

            // Save CWC after planning, as PlanManager might have updated it (though it shouldn't directly)
            // await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
            // It's better to save current_working_context.json if that's the standard
            await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });


            return { success: true };
        }

        async _performExecutionPhase(taskState) {
            if (!taskState.planStages || taskState.planStages.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_SKIPPED_NO_PLAN", "Execution skipped as no plan was available."));
                taskState.overallSuccess = false; // Crucial: if no plan, execution can't succeed
                taskState.responseMessage = "Execution skipped as no plan was available.";
                return taskState;
            }

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_INVOKED", "Attempting to execute plan.", { planStageCount: taskState.planStages.length }));

            try {
                const executionResult = await taskState.planExecutor.executePlan(
                    taskState.planStages,
                    taskState.taskId, // parentTaskId for PlanExecutor context
                    taskState.currentOriginalTask
                );

                taskState.lastExecutionContext = executionResult.executionContext || [];
                if (executionResult.journalEntries && executionResult.journalEntries.length > 0) {
                    taskState.finalJournalEntries.push(...executionResult.journalEntries);
                }
                taskState.overallSuccess = executionResult.success; // This is the key outcome

                if (executionResult.updatesForWorkingContext) {
                    taskState.executionKeyFindings = executionResult.updatesForWorkingContext.keyFindings || [];
                    taskState.executionErrorsEncountered = executionResult.updatesForWorkingContext.errorsEncountered || [];
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_CONTEXT_UPDATES_RECEIVED",
                        \`Received \${taskState.executionKeyFindings.length} key findings and \${taskState.executionErrorsEncountered.length} errors from execution.\`,
                        { findingsCount: taskState.executionKeyFindings.length, errorsCount: taskState.executionErrorsEncountered.length }
                    ));
                }

                if (executionResult.finalAnswerSynthesized && executionResult.finalAnswer) {
                    taskState.finalAnswer = executionResult.finalAnswer;
                    taskState.wasFinalAnswerPreSynthesized = true;
                    taskState.responseMessage = "Final answer synthesized during plan execution.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_FINAL_ANSWER_PRE_SYNTHESIZED", taskState.responseMessage));
                }

                if (!executionResult.success) {
                    taskState.failedStepDetails = executionResult.failedStepDetails;
                    taskState.responseMessage = `Execution failed: ${taskState.failedStepDetails?.error_details?.message || 'Unknown error during execution.'}`;
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_FAILED", taskState.responseMessage, { failureDetails: taskState.failedStepDetails }));
                } else {
                    taskState.responseMessage = "Plan executed successfully.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_COMPLETED", taskState.responseMessage));
                }

            } catch (error) {
                console.error(\`Critical error during PlanExecutor.executePlan for task \${taskState.taskId}: \${error.stack}\`);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_PHASE_CRITICAL_ERROR", \`Critical error: \${error.message}\`, { error: error.stack }));
                taskState.overallSuccess = false;
                taskState.responseMessage = \`Critical error during plan execution: \${error.message}\`;
                taskState.lastExecutionContext = taskState.lastExecutionContext || [];
                taskState.lastExecutionContext.push({
                    stepId: "EXECUTION_CRASH", narrative_step: "Critical error during plan execution", status: "FAILED",
                    error_details: { message: error.message, stack: error.stack }
                });
            }
            return taskState;
        }

        async _performCwcUpdateLLM(taskState) {
            if (!taskState.lastExecutionContext || taskState.lastExecutionContext.length === 0) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SKIPPED_NO_EXECUTION_CONTEXT", "Skipping CWC update as there is no execution context."));
                return taskState;
            }
            if (!taskState.overallSuccess) { // Also skip if execution failed
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SKIPPED_EXECUTION_FAILED", "Skipping CWC update as execution was not successful."));
                return taskState;
            }

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_STARTED", "Starting CWC update process."));

            try {
                let findingsText = "No new key findings from the last execution phase.";
                if (taskState.executionKeyFindings && taskState.executionKeyFindings.length > 0) {
                    findingsText = "Key Findings from Last Execution:\n" + taskState.executionKeyFindings.map(f =>
                        \`- Finding (Tool: \${f.sourceToolName}, Step: "\${f.sourceStepNarrative}"): \${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}\`
                    ).join("\n");
                }

                let errorsText = "No errors encountered in the last execution phase.";
                if (taskState.executionErrorsEncountered && taskState.executionErrorsEncountered.length > 0) {
                    errorsText = "Errors Encountered in Last Execution:\n" + taskState.executionErrorsEncountered.map(e =>
                        \`- Error (Tool: \${e.sourceToolName}, Step: "\${e.sourceStepNarrative}"): \${e.errorMessage}\`
                    ).join("\n");
                }

                const cwcSystemPrompt = \`You are an AI assistant helping to maintain a Current Working Context (CWC) for a complex task.
Based on the information provided below (Original Task, Previous CWC, Execution History, recent Key Findings, and Errors), update the CWC.
The CWC should be a concise summary of the task's current state, critical information gathered, what was just attempted, and what needs to be done next or what the current focus should be.
Output only the updated CWC text. Do not include any preamble or explanation.
The CWC should be a single block of text.

Previous CWC:
\${taskState.currentWorkingContext}
---
Original User Task:
\${taskState.currentOriginalTask}
---
Summary of Last Execution Phase (Overall Success: \${taskState.overallSuccess}):
\${findingsText}
\${errorsText}
---
Full Execution History (last few steps, if available):
\${JSON.stringify(taskState.lastExecutionContext.slice(-5), null, 2)}
---
Based on all the above, provide the updated CWC text:\`;

                const cwcModel = taskState.aiService.baseConfig?.cwcUpdateModel || taskState.aiService.baseConfig?.defaultModel || 'gpt-3.5-turbo';
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_INVOKED", "Invoking LLM for CWC update.", { model: cwcModel }));

                const newCwcText = await taskState.aiService.generateText(cwcSystemPrompt, { model: cwcModel, temperature: 0.5 });

                if (newCwcText && newCwcText.trim() !== "") {
                    taskState.currentWorkingContext = newCwcText.trim();
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                    // Also update the JSON version if it's the standard
                    await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_SUCCESS", "CWC updated and saved.", { newCwcPreview: taskState.currentWorkingContext.substring(0, 200) + "..." }));
                } else {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_EMPTY_RESPONSE", "LLM returned empty response for CWC update. CWC not changed."));
                }
            } catch (error) {
                console.error(\`Error during CWC update for task \${taskState.taskId}: \${error.stack}\`);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_ERROR", \`Error updating CWC: \${error.message}\`, { error: error.stack }));
            }
            return taskState;
        }

        async _performFinalSynthesis(taskState) {
            if (!taskState.overallSuccess) {
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_NOT_SUCCESSFUL", "Skipping final synthesis as overall task was not successful."));
                taskState.finalAnswer = taskState.finalAnswer || "Task was not successful, no final answer synthesized.";
                taskState.responseMessage = taskState.responseMessage || "Task failed before final synthesis.";
                return taskState;
            }
            if (!taskState.lastExecutionContext || taskState.lastExecutionContext.length === 0) {
                // This condition might be too strict if a task can succeed without execution context (e.g. simple retrieval or already synthesized)
                // However, for a typical flow requiring synthesis from execution, it's valid.
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_NO_EXECUTION_CONTEXT", "Skipping final synthesis as there is no execution context."));
                taskState.finalAnswer = taskState.finalAnswer || "No execution context available to synthesize a final answer.";
                taskState.responseMessage = taskState.responseMessage || "Task completed, but no specific data for final synthesis.";
                return taskState;
            }

            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_STARTED", "Starting final synthesis process."));
            try {
                const synthesisSystemPrompt = \`You are an AI assistant tasked with generating a final, comprehensive answer for the user based on the task's execution.
Review the Original User Task, the Current Working Context (CWC), and the Execution History.
Synthesize a final response that directly addresses the user's original request.
If the task was to generate content, provide that content. If it was a question, answer it clearly.
Present the information in a clean, user-friendly format.

Original User Task:
\${taskState.currentOriginalTask}
---
Current Working Context (CWC):
\${taskState.currentWorkingContext}
---
Execution History (summary of key steps and their outcomes):
\${JSON.stringify(taskState.lastExecutionContext.map(step => ({ step: step.narrative_step, status: step.status, result_preview: String(step.processed_result_data || step.raw_result_data).substring(0, 200) + (String(step.processed_result_data || step.raw_result_data).length > 200 ? '...' : '') })), null, 2)}
---
Based on all the above, provide the final answer to the user:\`;

                const synthesisModel = taskState.aiService.baseConfig?.synthesisModel || taskState.aiService.baseConfig?.defaultModel || 'gpt-4';
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_LLM_INVOKED", "Invoking LLM for final synthesis.", { model: synthesisModel }));

                const newFinalAnswer = await taskState.aiService.generateText(synthesisSystemPrompt, { model: synthesisModel, temperature: 0.6 });

                if (newFinalAnswer && newFinalAnswer.trim() !== "") {
                    taskState.finalAnswer = newFinalAnswer.trim();
                    taskState.responseMessage = "Final answer synthesized successfully.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SUCCESS", taskState.responseMessage, { answerPreview: taskState.finalAnswer.substring(0, 200) + "..." }));
                    await taskState.memoryManager.addChatMessage(taskState.taskDirPath, { role: 'assistant', content: taskState.finalAnswer });
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CHAT_MESSAGE_LOGGED_FINAL_ANSWER", "Final synthesized answer logged to chat."));
                } else {
                    taskState.finalAnswer = taskState.finalAnswer || "LLM returned an empty response during final synthesis.";
                    taskState.responseMessage = taskState.responseMessage || "Final synthesis resulted in an empty answer.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_EMPTY_RESPONSE", "LLM returned empty response for final synthesis."));
                }
            } catch (error) {
                console.error(\`Error during final synthesis for task \${taskState.taskId}: \${error.stack}\`);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ERROR", \`Error during final synthesis: \${error.message}\`, { error: error.stack }));
                taskState.finalAnswer = taskState.finalAnswer || \`An error occurred during final synthesis: \${error.message}\`;
                taskState.responseMessage = taskState.responseMessage || "Failed to synthesize final answer due to an error.";
            }
            return taskState;
        }

        async _finalizeTaskProcessing(taskState) {
            taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZING_TASK", "Finalizing task processing."));
            try {
                // Save journal
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'orchestrator_journal.json', taskState.finalJournalEntries, { isJson: true });

                // Save final state
                const finalStateToSave = {
                    taskId: taskState.taskId,
                    parentTaskId: taskState.parentTaskIdFromCall,
                    executionMode: taskState.executionMode,
                    userTaskString: taskState.userTaskString, // The initial user task string
                    currentOriginalTask: taskState.currentOriginalTask, // Could be same as userTaskString or modified if task was loaded
                    overallSuccess: taskState.overallSuccess,
                    finalAnswer: taskState.finalAnswer,
                    responseMessage: taskState.responseMessage,
                    plan: taskState.planStages,
                    executionContext: taskState.lastExecutionContext,
                    currentWorkingContext: taskState.currentWorkingContext, // Save the latest CWC
                    savedUploadedFilePaths: taskState.uploadedFilePaths,
                    timestamp: new Date().toISOString(),
                    // Optionally add failedStepDetails if it exists
                    ...(taskState.failedStepDetails && { failedStepDetails: taskState.failedStepDetails }),
                };
                // Use taskState.stateFilePath which is already constructed
                await fs.writeJson(taskState.stateFilePath, finalStateToSave, { spaces: 2 });
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_STATE_SAVED", "Final task state saved.", { path: taskState.stateFilePath }));

            } catch (saveError) {
                console.error(\`Error saving final task state/journal for \${taskState.taskId}: \${saveError.message}\`);
                 taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINALIZE_SAVE_ERROR", \`Error saving state/journal: \${saveError.message}\`, { error: saveError.message }));
            }
        }

        async handleUserTask(userTaskString, uploadedFiles, parentTaskId = null, taskIdToLoad = null, executionMode = EXECUTE_FULL_PLAN) {
            let taskState;
            try {
                taskState = await this._initializeTaskEnvironment(userTaskString, parentTaskId, taskIdToLoad, executionMode);

                // Initial CWC save (as JSON, if that's the standard)
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'current_working_context.json', { CWC: taskState.currentWorkingContext, lastUpdated: new Date().toISOString() }, { isJson: true });
                // Also save as cwc.md for consistency if it's used elsewhere or for easier human reading
                await taskState.memoryManager.overwriteMemory(taskState.taskDirPath, 'cwc.md', taskState.currentWorkingContext);
                taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_INITIAL_SAVE", "Initial CWC saved."));

                await this._processAndSaveUploadedFiles(uploadedFiles, taskState);

                // Mode-specific handlers
                if (taskState.executionMode === SYNTHESIZE_ONLY) {
                    // _handleSynthesizeOnlyMode now calls _performFinalSynthesis and returns a final-like object
                    return await this._handleSynthesizeOnlyMode(taskState);
                }

                if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                    await this._handleExecutePlannedTaskMode(taskState);
                    if (!taskState.overallSuccess) { // If loading plan/state failed
                        // _finalizeTaskProcessing will be called in finally
                        return { success: false, message: taskState.responseMessage, taskId: taskState.taskId, data: null, journal: taskState.finalJournalEntries };
                    }
                    // If successful, it flows into the main execution pipeline
                }

                // Planning (if not just executing an already loaded plan)
                if (taskState.executionMode === PLAN_ONLY || (taskState.executionMode === EXECUTE_FULL_PLAN && (!taskState.planStages || taskState.planStages.length === 0) )) {
                    const planningOutcome = await this._performPlanningPhase(taskState);
                    if (!planningOutcome.success) {
                        taskState.overallSuccess = false;
                        taskState.responseMessage = planningOutcome.message || "Planning failed.";
                        taskState.finalAnswer = JSON.stringify(planningOutcome.rawResponse || {});
                         // No further processing, finalize and return
                        return; // Exits try, goes to finally
                    }
                } else if (taskState.executionMode === EXECUTE_PLANNED_TASK) {
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_SKIPPED", "Skipping planning phase as a plan was loaded for EXECUTE_PLANNED_TASK."));
                }

                if (taskState.executionMode === PLAN_ONLY) {
                    taskState.responseMessage = "Plan created and saved.";
                    taskState.finalAnswer = JSON.stringify(taskState.planStages);
                    taskState.overallSuccess = true;
                    return; // Exits try, goes to finally
                }

                // Execution (if applicable)
                if (taskState.executionMode === EXECUTE_FULL_PLAN || taskState.executionMode === EXECUTE_PLANNED_TASK) {
                    await this._performExecutionPhase(taskState);
                    // If execution failed, overallSuccess will be false.
                }

                // CWC Update (if execution happened and was successful)
                if ((taskState.executionMode === EXECUTE_FULL_PLAN || taskState.executionMode === EXECUTE_PLANNED_TASK) && taskState.overallSuccess) {
                    await this._performCwcUpdateLLM(taskState);
                }

                // Final Synthesis (if not done by execution, and not SYNTHESIZE_ONLY mode)
                if (!taskState.wasFinalAnswerPreSynthesized && taskState.overallSuccess) {
                    // _performFinalSynthesis has its own checks for overallSuccess and lastExecutionContext
                    await this._performFinalSynthesis(taskState);
                } else if (taskState.wasFinalAnswerPreSynthesized) {
                    // Message already set by _performExecutionPhase
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_PRE_SYNTHESIZED", "Final synthesis skipped as answer was pre-synthesized during execution."));
                } else if (!taskState.overallSuccess) {
                    taskState.responseMessage = taskState.responseMessage || "Task failed before final synthesis stage.";
                    taskState.finalAnswer = taskState.finalAnswer || "Task execution failed, no final answer could be synthesized.";
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_FAILURE", taskState.responseMessage));
                } else {
                     taskState.responseMessage = taskState.responseMessage || "Task completed, but no specific data for final synthesis.";
                     taskState.finalAnswer = taskState.finalAnswer || "No specific information was generated by the execution to synthesize a final answer.";
                     taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED_NO_DATA", taskState.responseMessage));
                }

            } catch (error) {
                console.error(\`Critical error in OrchestratorAgent.handleUserTask for taskId \${taskState ? taskState.taskId : parentTaskId || 'unknown'}: \${error.stack}\`);
                if (taskState) {
                    taskState.finalJournalEntries.push(this._createOrchestratorJournalEntry("HANDLE_USER_TASK_CRITICAL_ERROR", \`Critical error: \${error.message}\`, { stack: error.stack }));
                    taskState.overallSuccess = false;
                    taskState.responseMessage = \`Critical error: \${error.message.substring(0, 200)}\`; // Avoid overly long messages
                } else {
                    // Error happened before taskState could be initialized
                    const errorTaskId = parentTaskId || Date.now().toString() + '_init_fail';
                    const tempJournal = [this._createOrchestratorJournalEntry("HANDLE_USER_TASK_INIT_ERROR", \`Critical error during taskState init: \${error.message}\`, { stack: error.stack })];
                    try { // Best effort to save a minimal journal
                        const errDatedTasksDirPath = path.join(this.savedTasksBaseDir || path.join(process.cwd(), 'tasks'), new Date().toISOString().split('T')[0]);
                        const errTaskDirPath = path.join(errDatedTasksDirPath, \`task_\${errorTaskId}\`);
                        await fs.ensureDir(errTaskDirPath);
                        await fs.writeJson(path.join(errTaskDirPath, 'orchestrator_journal.json'), tempJournal, { spaces: 2 });
                    } catch (e) { console.error("Failed to save error journal for pre-init failure", e); }
                    return { success: false, message: \`Critical initialization error: \${error.message.substring(0,200)}\`, taskId: errorTaskId, data: null, journal: tempJournal };
                }
            } finally {
                if (taskState) { // Ensure taskState exists before trying to finalize
                    await this._finalizeTaskProcessing(taskState);
                }
            }

            return {
                success: taskState.overallSuccess,
                message: taskState.responseMessage,
                taskId: taskState.taskId,
                data: taskState.finalAnswer,
                journal: taskState.finalJournalEntries,
            };
        }
    }

    export default OrchestratorAgent;
