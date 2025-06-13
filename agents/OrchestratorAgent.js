const fs = require('fs');
const path = require('path');
const { saveTaskState, loadTaskState, saveTaskJournal } = require('../utils/taskStateUtil');
const PlanManager = require('../core/PlanManager');
const PlanExecutor = require('../core/PlanExecutor');
// uuidv4 is not directly used by OrchestratorAgent after refactoring.
// It's used by PlanExecutor for sub-task IDs it generates.

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
        console.log("OrchestratorAgent: Worker capabilities loaded successfully.");
    } catch (error) {
        console.error(`OrchestratorAgent: Failed to load worker capabilities. Error: ${error.message}`);
        this.workerAgentCapabilities = [];
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

  async handleUserTask(userTaskString, parentTaskId, taskIdToLoad = null, executionMode = "EXECUTE_FULL_PLAN") {
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

    try {
        if (executionMode === "SYNTHESIZE_ONLY") {
            finalJournalEntries.push(this._createOrchestratorJournalEntry("SYNTHESIS_STARTED", "Starting task synthesis from loaded state.", { parentTaskId, taskIdToLoad }));
            // ... (SYNTHESIZE_ONLY logic as previously defined, ensuring CWC loading and usage in prompt, and journal updates)
            if (!taskIdToLoad) { /* ... error handling ... */ }
            // ... load state ...
            const loadResult = await loadTaskState(path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${taskIdToLoad}.json`)); // Placeholder path
            if (!loadResult.success || !loadResult.taskState) { /* ... error handling ... */ return { success: false, message: "Failed to load state for SYNTHESIZE_ONLY."}; }
            loadedState = loadResult.taskState;
            currentOriginalTask = loadedState.userTaskString;
            if (loadedState.currentWorkingContext) {
                currentWorkingContext = loadedState.currentWorkingContext;
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                currentWorkingContext.summaryOfProgress = "Resuming task for synthesis from loaded state.";
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "CWC loaded from state.", { parentTaskId }));
            }
            // ... rest of SYNTHESIZE_ONLY logic including synthesis prompt with CWC ...
            const synthesisPrompt = `Original task: "${currentOriginalTask}". Execution context: ${JSON.stringify(loadedState.executionContext)}. Current Working Context: ${JSON.stringify(currentWorkingContext)}. Synthesize the final answer.`;
            const finalAnswer = await this.llmService(synthesisPrompt);
            finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_COMPLETED", "Synthesis complete.", { parentTaskId }));
            // ... (save journal and return)
            await saveTaskJournal(parentTaskId, finalJournalEntries, path.join(__dirname, '..', 'saved_tasks'));
            return { success: true, finalAnswer, originalTask: currentOriginalTask, executedPlan: loadedState.executionContext, plan: loadedState.plan, currentWorkingContext };
        }

        // Handling for PLAN_ONLY, EXECUTE_FULL_PLAN, EXECUTE_PLANNED_TASK
        if (executionMode === "EXECUTE_PLANNED_TASK") {
            if (!taskIdToLoad) { /* ... error handling ... */ }
            // ... load state ...
            const loadResult = await loadTaskState(path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${taskIdToLoad}.json`)); // Placeholder path
            if (!loadResult.success || !loadResult.taskState) { /* ... error handling ... */ return { success: false, message: "Failed to load state for EXECUTE_PLANNED_TASK."};}
            loadedState = loadResult.taskState;
            currentOriginalTask = userTaskString || loadedState.userTaskString;
            planStages = loadedState.plan || [];
            if (loadedState.currentWorkingContext) {
                currentWorkingContext = loadedState.currentWorkingContext;
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                currentWorkingContext.summaryOfProgress = "Resuming task for execution from loaded plan.";
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_LOADED", "CWC loaded from state for planned execution.", { parentTaskId }));
            }
            if (!planStages || planStages.length === 0) { /* ... error: no plan to execute ... */ }
        }

        if (executionMode === "EXECUTE_FULL_PLAN" || (executionMode === "PLAN_ONLY" && !templatePlan)) { // Check if templatePlan is defined if that logic is separate
             finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_STARTED", "Attempting to get a plan.", { parentTaskId, executionMode }));
            const knownAgentRoles = (this.workerAgentCapabilities || []).map(agent => agent.role);
            const knownToolsByRole = {};
            (this.workerAgentCapabilities || []).forEach(agent => { knownToolsByRole[agent.role] = agent.tools.map(t => t.name); });

            planResult = await this.planManager.getPlan(currentOriginalTask, knownAgentRoles, knownToolsByRole);

            if (!planResult.success) {
                finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_FAILED", `Planning failed: ${planResult.message}`, { parentTaskId, error: planResult.message }));
                currentWorkingContext.summaryOfProgress = `Planning failed: ${planResult.message}`;
                currentWorkingContext.errorsEncountered.push({ errorId: `err-plan-${parentTaskId}`, sourceStepNarrative: "Planning", sourceToolName: "PlanManager", errorMessage: planResult.message, timestamp: new Date().toISOString()});
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                const errorState = { taskId: parentTaskId, userTaskString: currentOriginalTask, status: "FAILED_PLANNING", plan: [], executionContext: [], finalAnswer: null, errorSummary: { reason: planResult.message }, rawLLMResponse: planResult.rawResponse, currentWorkingContext };
                await saveTaskState(errorState, path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${parentTaskId}.json`)); // Placeholder path
                await saveTaskJournal(parentTaskId, finalJournalEntries, path.join(__dirname, '..', 'saved_tasks'));
                return { success: false, message: planResult.message, taskId: parentTaskId, originalTask: currentOriginalTask, rawResponse: planResult.rawResponse };
            }
            planStages = planResult.plan;
            finalJournalEntries.push(this._createOrchestratorJournalEntry("PLANNING_COMPLETED", `Plan successfully obtained from ${planResult.source}. Stages: ${planStages.length}`, { parentTaskId, source: planResult.source }));
            currentWorkingContext.summaryOfProgress = `Planning completed. Plan has ${planStages.length} stages.`;
            currentWorkingContext.nextObjective = "Execute plan.";
            currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED", "CWC updated after planning.", { parentTaskId, summary: currentWorkingContext.summaryOfProgress }));
        }

        if (executionMode === "PLAN_ONLY") {
            currentWorkingContext.summaryOfProgress = `Plan generated successfully from ${planResult.source}. Task complete (PLAN_ONLY).`;
            currentWorkingContext.nextObjective = "Plan available for review or execution.";
            const taskStateToSave = { taskId: parentTaskId, userTaskString: currentOriginalTask, status: "PLAN_GENERATED", plan: planStages, executionContext: [], finalAnswer: null, errorSummary: null, plan_source: planResult.source, raw_llm_response: planResult.rawResponse, currentWorkingContext };
            await saveTaskState(taskStateToSave, path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${parentTaskId}.json`)); // Placeholder path
            finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_COMPLETED_SUCCESSFULLY", "PLAN_ONLY task completed.", { parentTaskId }));
            await saveTaskJournal(parentTaskId, finalJournalEntries, path.join(__dirname, '..', 'saved_tasks'));
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
                    break; // Exit replanning loop
                } else {
                    // Execution attempt failed
                    const failureDetails = currentExecutionResult.failedStepDetails ?
                        { narrative: currentExecutionResult.failedStepDetails.narrative_step, tool: currentExecutionResult.failedStepDetails.tool_name, error: currentExecutionResult.failedStepDetails.error_details } :
                        { error: "Unknown failure details" };
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("EXECUTION_ATTEMPT_FAILED", `Execution attempt ${currentAttempt + 1} failed.`, { parentTaskId, attemptNumber: currentAttempt + 1, failureDetails }));
                    currentWorkingContext.summaryOfProgress = `Execution attempt ${currentAttempt + 1} failed. Error during step: '${failureDetails.narrative || 'unknown step'}'. Details: ${JSON.stringify(failureDetails.error).substring(0,100)}...`;

                    if (currentAttempt >= MAX_REVISIONS) {
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("MAX_REVISIONS_REACHED", "Maximum replanning attempts reached. Task failed.", { parentTaskId }));
                        overallTaskSuccessFlag = false;
                        break; // Exit loop, task has definitively failed
                    } else {
                        // Try to replan
                        finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_STARTED", `Attempting replanning. Revision ${currentAttempt + 1}.`, { parentTaskId, revisionAttempt: currentAttempt + 1 }));
                        currentWorkingContext.nextObjective = `Replanning attempt ${currentAttempt + 1} due to execution failure.`;
                        currentWorkingContext.lastUpdatedAt = new Date().toISOString();

                        // Ensure failedStepDetails is structured as PlanManager expects
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
                            currentWorkingContext,
                            lastExecutionContext, // context from the failed attempt
                            structuredFailedStepInfo, // details of the failed step
                            planForNextAttempt, // the plan that just failed (useful for LLM to see what it tried)
                            true, // isRevision
                            currentAttempt + 1 // revisionAttemptNumber
                        );

                        if (newPlanResult.success && newPlanResult.plan && newPlanResult.plan.length > 0) {
                            planForNextAttempt = newPlanResult.plan;
                            planStages = newPlanResult.plan; // Update planStages for saving state later
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_SUCCESS", `Replanning successful. New plan generated by ${newPlanResult.source}.`, { parentTaskId, source: newPlanResult.source, newPlanStageCount: planForNextAttempt.length }));
                            currentWorkingContext.summaryOfProgress = `Replanning attempt ${currentAttempt + 1} successful. New plan generated. Previous errors: ${currentWorkingContext.errorsEncountered.length}.`;
                            currentWorkingContext.nextObjective = "Execute the revised plan.";
                            // Loop continues to next attempt with the new plan
                        } else {
                            finalJournalEntries.push(this._createOrchestratorJournalEntry("REPLANNING_FAILED", `Replanning failed: ${newPlanResult.message || 'No new plan could be generated.'}`, { parentTaskId, reason: newPlanResult.message, rawResponse: newPlanResult.rawResponse }));
                            currentWorkingContext.summaryOfProgress = `Replanning attempt ${currentAttempt + 1} failed. ${newPlanResult.message || 'No new plan could be generated.'}`;
                            overallTaskSuccessFlag = false;
                            break; // Exit loop, task has definitively failed as replanning also failed
                        }
                    }
                }
            }
            // After the loop, set overallSuccess and executionContext based on the loop's outcome
            overallSuccess = overallTaskSuccessFlag;
            executionContext = lastExecutionContext;
            executionResult = lastExecutionResult; // executionResult now holds the outcome of the last attempt

            finalJournalEntries.push(this._createOrchestratorJournalEntry(overallSuccess ? "EXECUTION_CYCLE_COMPLETED_SUCCESS" : "EXECUTION_CYCLE_COMPLETED_FAILURE", `Execution/replanning cycle finished. Overall Success: ${overallSuccess}`, { parentTaskId, overallSuccess }));

            // CWC summary has been updated within the loop.
            // The next CWC update (LLM-based) will use the latest state of currentWorkingContext.
            // Errors and findings have also been accumulated in currentWorkingContext.
            currentWorkingContext.lastUpdatedAt = new Date().toISOString();
            if (lastExecutionResult.updatesForWorkingContext) {
                // This check is mostly redundant as CWC is updated within the loop directly
                // but ensures no data loss if lastExecutionResult had some pending updates not caught by direct CWC mutation.
                // However, the primary CWC update mechanism is now within the loop.
                // Key findings and errors are already part of currentWorkingContext.
            }
            // Final CWC summary reflects the outcome of the execution cycle.
            currentWorkingContext.nextObjective = overallSuccess ? "Synthesize final answer." : "Task failed after execution/replanning attempts.";
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_POST_EXECUTION_CYCLE", currentWorkingContext.summaryOfProgress, { parentTaskId, findingCount: currentWorkingContext.keyFindings.length, errorCount: currentWorkingContext.errorsEncountered.length }));

            // --- LLM-based CWC Update ---
            // This section will now use the CWC that has been updated throughout the execution/replanning loop.
            finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_START", "Attempting LLM update for CWC summary and next objective post-execution cycle.", { parentTaskId }));
            const MAX_FINDINGS_FOR_CWC_PROMPT = 5;
            const MAX_ERRORS_FOR_CWC_PROMPT = 3;

            const recentFindingsSummary = currentWorkingContext.keyFindings.slice(-MAX_FINDINGS_FOR_CWC_PROMPT).map(f => ({ narrative: f.sourceStepNarrative, tool: f.sourceToolName, dataPreview: String(f.data).substring(0,100)+"..." }) );
            const recentErrorsSummary = currentWorkingContext.errorsEncountered.slice(-MAX_ERRORS_FOR_CWC_PROMPT).map(e => ({ narrative: e.sourceStepNarrative, tool: e.sourceToolName, error: e.errorMessage}));

            const cwcUpdatePrompt = `The overall user task is: "${currentOriginalTask}".
The previous summary of progress was: "${currentWorkingContext.summaryOfProgress}".
The previous next objective was: "${currentWorkingContext.nextObjective}".
Recent plan execution overall success: ${overallSuccess}.
Recent key findings:
${JSON.stringify(recentFindingsSummary, null, 2)}
Recent errors encountered:
${JSON.stringify(recentErrorsSummary, null, 2)}

Based on this, provide an updated summary of progress and the immediate next objective for the overall task.
Return ONLY a JSON object with two keys: "updatedSummaryOfProgress" (string) and "updatedNextObjective" (string).
Example: { "updatedSummaryOfProgress": "Data gathered, some errors occurred.", "updatedNextObjective": "Synthesize findings considering errors." }`;

            try {
                const cwcUpdateResponse = await this.llmService(cwcUpdatePrompt);
                const parsedCwcUpdate = JSON.parse(cwcUpdateResponse);

                if (parsedCwcUpdate && parsedCwcUpdate.updatedSummaryOfProgress && parsedCwcUpdate.updatedNextObjective) {
                    currentWorkingContext.summaryOfProgress = parsedCwcUpdate.updatedSummaryOfProgress;
                    currentWorkingContext.nextObjective = parsedCwcUpdate.updatedNextObjective;
                    currentWorkingContext.lastUpdatedAt = new Date().toISOString();
                    finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATED_BY_LLM", "CWC summary and next objective updated by LLM.", { parentTaskId, newSummary: currentWorkingContext.summaryOfProgress, newObjective: currentWorkingContext.nextObjective }));
                } else {
                    throw new Error("LLM response for CWC update missing required fields.");
                }
            } catch (cwcLlmError) {
                console.error(`OrchestratorAgent: Error updating CWC with LLM: ${cwcLlmError.message}`);
                finalJournalEntries.push(this._createOrchestratorJournalEntry("CWC_UPDATE_LLM_ERROR", `LLM CWC update failed: ${cwcLlmError.message}`, { parentTaskId, error: cwcLlmError.message }));
                // CWC summary and nextObjective remain as they were (simple programmatic updates)
            }
            // --- End of LLM-based CWC Update ---
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
Current Working Context:
${JSON.stringify(currentWorkingContext, null, 2)}
---
Based on the original user task, execution history, and current working context, synthesize a comprehensive answer.`;
                try {
                    finalAnswer = await this.llmService(synthesisPrompt);
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
        }
         // This block handles cases where synthesis was skipped due to pre-synthesized answer, or no execution/overall failure
         else if (!wasFinalAnswerPreSynthesized) {
            if (!overallSuccess) { // This implies execution failed
                 responseMessage = "One or more sub-tasks failed. Unable to provide a final synthesized answer.";
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_ABORTED", responseMessage, { parentTaskId }));
            } else { // No overall success, but also no specific data to synthesize, or no execution context
                 responseMessage = "No execution steps were performed or no actionable data produced; no final answer synthesized.";
                 finalJournalEntries.push(this._createOrchestratorJournalEntry("FINAL_SYNTHESIS_SKIPPED", responseMessage, { parentTaskId }));
            }
            if (currentWorkingContext) { // Update CWC for these non-synthesis scenarios too
                currentWorkingContext.summaryOfProgress = responseMessage;
                currentWorkingContext.nextObjective = "Task finished with no new answer synthesized by Orchestrator.";
                currentWorkingContext.lastUpdatedAt = new Date().toISOString();
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

        // Ensure final CWC update before saving state
        if(currentWorkingContext) currentWorkingContext.lastUpdatedAt = new Date().toISOString();


        await saveTaskState(taskStateToSave, path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${parentTaskId}.json`));
        finalJournalEntries.push(this._createOrchestratorJournalEntry(overallSuccess ? "TASK_COMPLETED_SUCCESSFULLY" : "TASK_FAILED_FINAL", `Task processing finished. Overall Success: ${overallSuccess}`, { parentTaskId, finalStatus: taskStatusToSave }));
        await saveTaskJournal(parentTaskId, finalJournalEntries, path.join(__dirname, '..', 'saved_tasks'));

        return { success: overallSuccess, message: responseMessage, originalTask: currentOriginalTask, plan: planStages, executedPlan: executionContext, finalAnswer, currentWorkingContext };

    } catch (error) {
        console.error(`OrchestratorAgent: Critical unhandled error in handleUserTask for ParentTaskID ${parentTaskId}: ${error.message}`, error.stack);
        finalJournalEntries.push(this._createOrchestratorJournalEntry("TASK_PROCESSING_ERROR", `Critical unhandled error: ${error.message}`, { parentTaskId, errorStack: error.stack }));
        currentWorkingContext.summaryOfProgress = `Critical unhandled error: ${error.message}`;
        currentWorkingContext.errorsEncountered.push({ errorId: `err-critical-${parentTaskId}`, sourceStepNarrative: "Orchestrator System", sourceToolName: "handleUserTask", errorMessage: error.message, timestamp: new Date().toISOString() });
        currentWorkingContext.lastUpdatedAt = new Date().toISOString();

        const errorStateForSave = {
            taskId: parentTaskId, userTaskString: currentOriginalTask || userTaskString, status: "CRITICAL_ERROR",
            plan: planStages || [], executionContext: executionResult ? executionResult.executionContext : [], finalAnswer: null,
            errorSummary: { reason: `Critical unhandled error: ${error.message}` },
            currentWorkingContext
        };
        // Attempt to save state and journal even on critical error
        try {
            await saveTaskState(errorStateForSave, path.join(__dirname, '..', 'saved_tasks', `tasks_${new Date().toISOString().slice(5,7)}${new Date().toISOString().slice(8,10)}${new Date().toISOString().slice(0,4)}`, `task_state_${parentTaskId}.json`)); // Placeholder path
            await saveTaskJournal(parentTaskId, finalJournalEntries, path.join(__dirname, '..', 'saved_tasks'));
        } catch (saveError) {
            console.error(`OrchestratorAgent: Failed to save state/journal during critical error handling: ${saveError.message}`);
        }
        return { success: false, message: `Internal Server Error: ${error.message}`, taskId: parentTaskId, originalTask: currentOriginalTask || userTaskString, finalAnswer: null, currentWorkingContext };
    }
  }
}

module.exports = OrchestratorAgent;
