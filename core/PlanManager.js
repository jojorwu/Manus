// core/PlanManager.js
const fs = require('fs');
const path = require('path');
const { escapeRegExp } = require('../utils/localization'); // Import the escape function

// Helper function moved to module scope
function findInvalidOutputReferences(input, currentStepId, outputRefRegex) {
    if (typeof input === 'string') {
        const potentialRefs = input.match(/@{outputs\.([^}]+)}/g);
        if (potentialRefs) {
            for (const ref of potentialRefs) {
                outputRefRegex.lastIndex = 0;
                if (!outputRefRegex.test(ref)) {
                    return `Invalid output reference syntax in: "${ref}" for stepId '${currentStepId}'. Must be @{outputs.ID.result_data} or @{outputs.ID.processed_result_data}.`;
                }
            }
        }
    } else if (Array.isArray(input)) {
        for (const item of input) {
            const error = findInvalidOutputReferences(item, currentStepId, outputRefRegex);
            if (error) return error;
        }
    } else if (typeof input === 'object' && input !== null) {
        for (const key in input) {
            // eslint-disable-next-line security/detect-object-injection -- 'key' is from 'input' (plan data). Function is recursive and performs read-only validation checks.
            const error = findInvalidOutputReferences(input[key], currentStepId, outputRefRegex);
            if (error) return error;
        }
    }
    return null; // No error
}

class PlanManager {
    constructor(aiService, agentCapabilities, planTemplatesPath) { // Changed llmService to aiService
        this.aiService = aiService; // Changed llmService to aiService
        this.agentCapabilities = agentCapabilities; // Full capabilities object/array
        this.planTemplatesPath = planTemplatesPath; // Base path for templates, e.g., path.join(__dirname, '..', 'config', 'plan_templates')
        this.planTemplates = [];
        this.loadPlanTemplates();
    }

    loadPlanTemplates() {
        // Adapted from OrchestratorAgent.loadPlanTemplates()
        const templatesDir = this.planTemplatesPath;
        this.planTemplates = []; // Reset before loading
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- templatesDir is a constructor-set base path.
            if (!fs.existsSync(templatesDir)) {
                console.warn(`PlanManager: Plan templates directory not found at ${templatesDir}. No templates loaded.`);
                return;
            }
            // These definitions might need to be passed in or made more generic if they change often
            const templateDefinitions = [
                { name: "weather_query", fileName: "weather_query_template.json", regex: /^(?:what is the )?weather (?:in )?(.+)/i, paramMapping: { CITY_NAME: 1 } },
                { name: "calculator", fileName: "calculator_template.json", regex: /^(?:calculate|what is) ([\d\s+\-*/().^%]+)/i, paramMapping: { EXPRESSION: 1 } }
            ];
            for (const def of templateDefinitions) {
                const filePath = path.join(templatesDir, def.fileName);
                // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is constructed from a base path and statically defined filenames.
                if (fs.existsSync(filePath)) {
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is constructed from a base path and statically defined filenames.
                    const templateContent = fs.readFileSync(filePath, 'utf8');
                    this.planTemplates.push({ name: def.name, regex: def.regex, paramMapping: def.paramMapping, template: JSON.parse(templateContent) });
                    console.log(`PlanManager: Loaded plan template '${def.name}' from ${def.fileName}`);
                } else {
                    console.warn(`PlanManager: Plan template file ${def.fileName} not found in ${templatesDir}`);
                }
            }
        } catch (error) {
            console.error(`PlanManager: Error loading plan templates: ${error.message}`);
            this.planTemplates = [];
        }
    }

    async tryGetPlanFromTemplate(userTaskString) {
        // Adapted from OrchestratorAgent.tryGetPlanFromTemplate()
        if (!this.planTemplates || this.planTemplates.length === 0) return null;
        for (const templateInfo of this.planTemplates) {
            const match = templateInfo.regex.exec(userTaskString);
            if (match) {
                console.log(`PlanManager: Matched plan template '${templateInfo.name}' for task.`);
                let populatedTemplateString = JSON.stringify(templateInfo.template);
                for (const placeholder in templateInfo.paramMapping) {
                    if (Object.prototype.hasOwnProperty.call(templateInfo.paramMapping, placeholder)) {
                        // eslint-disable-next-line security/detect-object-injection -- 'placeholder' is a key from 'templateInfo.paramMapping', which is part of statically defined templateDefinitions. Safe.
                        const groupIndex = templateInfo.paramMapping[placeholder];
                        // eslint-disable-next-line security/detect-object-injection -- match is a regex exec array, groupIndex is an integer from static config. Array access by integer is safe.
                        const value = match[groupIndex] ? match[groupIndex].trim() : "";
                        // Security: Sanitize placeholder for use in RegExp.
                        const sanitizedPlaceholder = escapeRegExp(placeholder);
                        populatedTemplateString = populatedTemplateString.replace(new RegExp(`{{${sanitizedPlaceholder}}}`, 'g'), value); // eslint-disable-line security/detect-non-literal-regexp
                    }
                }
                try {
                    return JSON.parse(populatedTemplateString);
                } catch (e) {
                    console.error(`PlanManager: Error parsing populated template '${templateInfo.name}'. Error: ${e.message}`);
                    return null;
                }
            }
        }
        return null;
    }

    async parseAndValidatePlan(jsonStringResponse, knownAgentRoles, knownToolsByRole) {
        // Adapted from global parseSubTaskPlanResponse in OrchestratorAgent.js
        const MAX_RAW_RESPONSE_LENGTH = 500;
        let cleanedString = jsonStringResponse;

        if (typeof jsonStringResponse !== 'string') {
            const detailsString = String(jsonStringResponse);
            const trimmedDetails = detailsString.length > MAX_RAW_RESPONSE_LENGTH ? detailsString.substring(0, MAX_RAW_RESPONSE_LENGTH) + "..." : detailsString;
            return { success: false, message: "LLM did not return a string response for the plan.", details: trimmedDetails, stages: [], rawResponse: jsonStringResponse };
        }

        try {
            if (cleanedString.startsWith('```json')) {
                cleanedString = cleanedString.substring(7);
                if (cleanedString.endsWith('```')) {
                    cleanedString = cleanedString.slice(0, -3);
                }
            }
            cleanedString = cleanedString.trim();
            const parsedStages = JSON.parse(cleanedString);

            if (!Array.isArray(parsedStages)) {
                return { success: false, message: "LLM plan is not a JSON array of stages.", rawResponse: cleanedString, stages: [] };
            }
            // Allow empty plan for "unachievable task" scenario in replanning.
            // OrchestratorAgent will handle this (e.g., if planStages is empty after this call).
            if (parsedStages.length === 0 && cleanedString.trim() !== "[]") { // check if it's genuinely empty vs bad parse for non-array
                return { success: false, message: "LLM plan is empty (no stages), but not an empty array '[]'.", rawResponse: cleanedString, stages: [] };
            }
             if (parsedStages.length === 0 && cleanedString.trim() === "[]") {
                console.log("PlanManager: Parsed an empty plan ('[]'). This is treated as a valid plan indicating no actions to take or task unachievable.");
                return { success: true, stages: [], rawResponse: cleanedString, isEmptyPlan: true };
            }


            const allStepIds = new Set();
            let totalSteps = 0;
            const outputRefRegex = /@{outputs\.([a-zA-Z0-9_.-]+)\.(result_data|processed_result_data)}/g; // g for multiple matches in one string

            for (const stage of parsedStages) {
                if (!Array.isArray(stage)) {
                    return { success: false, message: "Invalid stage in plan: not an array.", rawResponse: cleanedString, stages: [] };
                }
                // Allow empty stages within a non-empty plan
                // if (stage.length === 0) {
                //     return { success: false, message: "Invalid stage in plan: stage is empty.", rawResponse: cleanedString, stages: [] };
                // }
                for (const subTask of stage) {
                    totalSteps++;
                    if (typeof subTask !== 'object' || subTask === null) {
                        return { success: false, message: "Invalid sub-task structure: not an object.", rawResponse: cleanedString, stages: [] };
                    }

                    // Validate stepId
                    if (!subTask.stepId || typeof subTask.stepId !== 'string' || subTask.stepId.trim() === "") {
                        return { success: false, message: `Missing or invalid 'stepId' (must be a non-empty string) in sub-task: ${JSON.stringify(subTask).substring(0,100)}...`, rawResponse: cleanedString, stages: [] };
                    }
                    allStepIds.add(subTask.stepId);

                    // Validate narrative_step
                    if (!subTask.narrative_step || typeof subTask.narrative_step !== 'string' || !subTask.narrative_step.trim()) {
                        return { success: false, message: `Missing or empty 'narrative_step' for stepId '${subTask.stepId}'.`, rawResponse: cleanedString, stages: [] };
                    }

                    // Validate assigned_agent_role and tool_name
                    if (subTask.assigned_agent_role === "Orchestrator") {
                        const allowedOrchestratorTools = ["ExploreSearchResults", "LLMStepExecutor", "FileSystemTool", "FileDownloaderTool"]; // Renamed GeminiStepExecutor
                        if (!allowedOrchestratorTools.includes(subTask.tool_name)) {
                            return { success: false, message: `Invalid 'tool_name': ${subTask.tool_name} for Orchestrator role (stepId: ${subTask.stepId}). Allowed: ${allowedOrchestratorTools.join(", ")}.`, rawResponse: cleanedString, stages: [] };
                        }

                        if (subTask.tool_name === "LLMStepExecutor") { // Validation for LLMStepExecutor
                            if (!subTask.sub_task_input || (typeof subTask.sub_task_input.prompt !== 'string' && typeof subTask.sub_task_input.prompt_template !== 'string' && !Array.isArray(subTask.sub_task_input.messages))) {
                                return { success: false, message: `'prompt' (string), 'prompt_template' (string), or 'messages' (array) is required in sub_task_input for LLMStepExecutor (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                            if (subTask.sub_task_input.model !== undefined && typeof subTask.sub_task_input.model !== 'string') {
                                return { success: false, message: `'model' in sub_task_input for LLMStepExecutor must be a string if provided (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                        } else if (subTask.tool_name === "FileSystemTool" || subTask.tool_name === "FileDownloaderTool") {
                            if (!subTask.sub_task_input || typeof subTask.sub_task_input.operation !== 'string') {
                                return { success: false, message: `'operation' is required in sub_task_input for Orchestrator tool ${subTask.tool_name} (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                            if (!subTask.sub_task_input.params || typeof subTask.sub_task_input.params !== 'object') {
                                return { success: false, message: `'params' object is required in sub_task_input for Orchestrator tool ${subTask.tool_name} (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                        }

                        if (subTask.tool_name === "FileSystemTool") {
                            const fsOps = ["create_file", "read_file", "append_to_file", "list_files", "overwrite_file", "create_pdf_from_text"];
                            if (!fsOps.includes(subTask.sub_task_input.operation)) {
                                return { success: false, message: `Invalid 'operation': ${subTask.sub_task_input.operation} for FileSystemTool (stepId: ${subTask.stepId}). Allowed: ${fsOps.join(", ")}`, rawResponse: cleanedString, stages: [] };
                            }
                            const opsRequiringStaticFilenameOrDir = {
                                "create_file": ["filename"], "read_file": ["filename"], "append_to_file": ["filename"],
                                "overwrite_file": ["filename"], "create_pdf_from_text": ["filename"], "list_files": ["directory"]
                            };
                            if (opsRequiringStaticFilenameOrDir[subTask.sub_task_input.operation]) {
                                const params = subTask.sub_task_input.params;
                                for (const paramName of opsRequiringStaticFilenameOrDir[subTask.sub_task_input.operation]) {
                                     if (params[paramName] !== undefined && (typeof params[paramName] !== 'string' || params[paramName].startsWith("@{outputs."))) {
                                        return { success: false, message: `'params.${paramName}' must be a string (not an output reference) for FileSystemTool operation '${subTask.sub_task_input.operation}' (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                                    }
                                }
                            }
                             if ((subTask.sub_task_input.operation === "create_file" ||
                                 subTask.sub_task_input.operation === "read_file" ||
                                 subTask.sub_task_input.operation === "append_to_file" ||
                                 subTask.sub_task_input.operation === "overwrite_file" ||
                                 subTask.sub_task_input.operation === "create_pdf_from_text") &&
                                (!subTask.sub_task_input.params || typeof subTask.sub_task_input.params.filename !== 'string')) {
                                return { success: false, message: `'params.filename' (string) is required for FileSystemTool operation '${subTask.sub_task_input.operation}' (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                            if (subTask.sub_task_input.operation === "create_pdf_from_text") {
                                if (!subTask.sub_task_input.params.filename.toLowerCase().endsWith('.pdf')) {
                                    return { success: false, message: `'params.filename' for 'create_pdf_from_text' must end with '.pdf' (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                                }
                                if (typeof subTask.sub_task_input.params.text_content !== 'string') {
                                    return { success: false, message: `'params.text_content' (string or output reference) is required for 'create_pdf_from_text' (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                                }
                                // ... other PDF params validation ...
                            }
                            if ((subTask.sub_task_input.operation === "create_file" ||
                                 subTask.sub_task_input.operation === "append_to_file" ||
                                 subTask.sub_task_input.operation === "overwrite_file") &&
                                (typeof subTask.sub_task_input.params.content !== 'string')
                               ) {
                                 if (subTask.sub_task_input.operation !== "append_to_file" || subTask.sub_task_input.params.content === undefined) {
                                     return { success: false, message: `'params.content' (string or output reference) is required for FileSystemTool operation '${subTask.sub_task_input.operation}' (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                                 }
                            }
                        }
                        if (subTask.tool_name === "FileDownloaderTool") {
                            if (subTask.sub_task_input.operation !== "download_file") {
                                return { success: false, message: `Invalid 'operation': ${subTask.sub_task_input.operation} for FileDownloaderTool (stepId: ${subTask.stepId}). Must be 'download_file'.`, rawResponse: cleanedString, stages: [] };
                            }
                            if (!subTask.sub_task_input.params || typeof subTask.sub_task_input.params.url !== 'string') {
                                return { success: false, message: `'params.url' (string or output reference) is required for FileDownloaderTool (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                            if (subTask.sub_task_input.params && subTask.sub_task_input.params.filename !== undefined && (typeof subTask.sub_task_input.params.filename !== 'string' || subTask.sub_task_input.params.filename.startsWith("@{outputs."))) {
                                return { success: false, message: `'params.filename' if provided, must be a string (not an output reference) for FileDownloaderTool (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                            }
                        }

                    } else if (!knownAgentRoles.includes(subTask.assigned_agent_role)) {
                        // eslint-disable-next-line security/detect-object-injection -- subTask.assigned_agent_role is used in a string for an error message, not for property access. Safe.
                        return { success: false, message: `Invalid or unknown 'assigned_agent_role': ${subTask.assigned_agent_role} for stepId '${subTask.stepId}'.`, rawResponse: cleanedString, stages: [] };
                    } else { // Worker agent roles
                        // eslint-disable-next-line security/detect-object-injection -- subTask.assigned_agent_role is validated by knownAgentRoles.includes() check above.
                        const agentTools = knownToolsByRole[subTask.assigned_agent_role];
                        if (!subTask.tool_name || typeof subTask.tool_name !== 'string' || !agentTools || !agentTools.includes(subTask.tool_name)) {
                            // eslint-disable-next-line security/detect-object-injection -- subTask.tool_name and subTask.assigned_agent_role are used in a string for an error message. Safe.
                            return { success: false, message: `Invalid or unknown 'tool_name': ${subTask.tool_name} for role ${subTask.assigned_agent_role} (stepId: ${subTask.stepId}).`, rawResponse: cleanedString, stages: [] };
                        }
                    }

                    if (typeof subTask.sub_task_input !== 'object' || subTask.sub_task_input === null) {
                        return { success: false, message: `Invalid 'sub_task_input': must be an object for stepId '${subTask.stepId}'.`, rawResponse: cleanedString, stages: [] };
                    }

                    // Validate output reference syntax within sub_task_input
                    const refValidationError = findInvalidOutputReferences(subTask.sub_task_input, subTask.stepId, outputRefRegex);
                    if (refValidationError) {
                        return { success: false, message: refValidationError, rawResponse: cleanedString, stages: [] };
                    }
                }
            }

            if (totalSteps > 0 && allStepIds.size !== totalSteps) { // Only if there are steps, check for duplicates
                return { success: false, message: "Duplicate 'stepId' found in the plan. All stepIds must be unique.", rawResponse: cleanedString, stages: [] };
            }

            return { success: true, stages: parsedStages, rawResponse: cleanedString };
        } catch (e) {
            const trimmedRawResponse = cleanedString.length > MAX_RAW_RESPONSE_LENGTH ? cleanedString.substring(0, MAX_RAW_RESPONSE_LENGTH) + "..." : cleanedString;
            console.error("PlanManager: Error parsing sub-task plan JSON:", e.message, "Raw response:", trimmedRawResponse);
            return { success: false, message: "Failed to parse LLM plan: " + e.message, rawResponse: trimmedRawResponse, stages: [] };
        }
    }

    _buildRevisionContextPrompt(userTaskString, currentCWC, latestKeyFindings, latestErrors, failedStepInfo, remainingPlanStages, executionContextSoFar, revisionAttemptNumber, replanErrorHistory = null) {
        let revisionContext = `This is a replanning attempt (Attempt #${revisionAttemptNumber}) due to a failure in a previous execution.\n`; // This line is updated by the new instructions, but we keep it as a base
        revisionContext = ""; // Start fresh for the new instruction format

        // The new instruction format incorporates revisionAttemptNumber directly.
        // revisionContext += `Original User Task: '${userTaskString}'\n\n`; // Original task is part of the new instructions

        if (currentCWC) { // currentCWC no longer has keyFindings or errorsEncountered directly
            revisionContext += "Current Working Context (CWC) Summary:\n";
            revisionContext += `Overall Progress: ${currentCWC.summaryOfProgress || 'Not available.'}\n`;
            revisionContext += "---\n";
        }

        if (latestKeyFindings && latestKeyFindings.length > 0) {
            revisionContext += `Recent Key Findings (up to ${latestKeyFindings.length}):
${JSON.stringify(latestKeyFindings, null, 2)}
---
`;
        }
        if (latestErrors && latestErrors.length > 0) {
            revisionContext += `Recent Errors Encountered (up to ${latestErrors.length}):
${JSON.stringify(latestErrors, null, 2)}
---
`;
        }

        if (failedStepInfo) {
            revisionContext += "Information about the failed step:\n";
            revisionContext += `Narrative: ${failedStepInfo.narrative_step || 'N/A'}\n`;
            revisionContext += `Agent Role: ${failedStepInfo.assigned_agent_role || 'N/A'}\n`;
            revisionContext += `Tool: ${failedStepInfo.tool_name || 'N/A'}\n`;
            revisionContext += `Input: ${JSON.stringify(failedStepInfo.sub_task_input, null, 2)}\n`;
            revisionContext += `Error Message: ${failedStepInfo.errorMessage || 'N/A'}\n`;
            revisionContext += "---\n";
        }

        if (remainingPlanStages && remainingPlanStages.length > 0) {
            try {
                const remainingPlanString = JSON.stringify(remainingPlanStages, null, 2);
                if (remainingPlanString.length < 2000) { // Keep context concise
                    revisionContext += `Remaining plan stages from previous attempt:\n${remainingPlanString}\n---\n`;
                }
            } catch (e) { console.warn("PlanManager: Could not stringify remainingPlanStages for revision prompt."); }
        }

        if (executionContextSoFar && executionContextSoFar.length > 0) {
            try {
                // Limit to last 3-5 steps to keep context manageable, assuming more recent is more relevant for immediate failure.
                const recentContextString = JSON.stringify(executionContextSoFar.slice(-5), null, 2); // Changed from -3 to -5 for a bit more context
                revisionContext += `Recent execution context (last ${Math.min(5, executionContextSoFar.length)} steps/results):\n${recentContextString}\n---\n`;
            } catch (e) { console.warn("PlanManager: Could not stringify executionContextSoFar for revision prompt."); }
        }

        if (replanErrorHistory && replanErrorHistory.length > 0) {
            revisionContext += "History of attempts in the current replanning cycle:\n";
            for (const attempt of replanErrorHistory) {
                revisionContext += `- Attempt ${attempt.attemptInCycle}: Failed on step "${attempt.failedStepNarrative}" with error "${attempt.errorMessage}"\n`;
            }
            revisionContext += "---\n";
        }

        revisionContext += `Instruction: This is replanning attempt number ${revisionAttemptNumber}.
    You are provided with:
    1. The original user task.
    2. Available agent capabilities and tools.
    3. Information about the most recent failed step ('Information about the failed step').
    4. History of attempts in the current replanning cycle (if any, under 'History of attempts in the current replanning cycle'). This shows recent errors for the same underlying issue.
    5. Broader execution context and previously successful steps (under 'Recent execution context').
    6. Potentially, parts of the plan that were remaining before this failure.

    Your goal is to generate a revised plan to achieve the original user task.

    CRITICAL CONSIDERATIONS FOR REPLANNING:
    - Analyze the 'Information about the failed step' and the 'History of attempts in the current replanning cycle' very carefully.
    - If the same step or similar errors are repeating in the current cycle, DO NOT simply retry the same action. You MUST propose a significantly different approach to overcome the obstacle OR determine if the task is unachievable.
    - If you've tried different approaches for the same obstacle and it's still failing (as shown in the history), it's highly likely the task is unachievable with the current capabilities.

    ACTIONS TO TAKE:
    A. If you can devise a NEW, genuinely different strategy to overcome the specific error(s) encountered:
        - Generate a new plan (or modify the remaining plan).
        - Ensure your new plan explicitly addresses the reason for the previous failure(s).
        - Leverage any useful results from 'Recent execution context'.
    B. If, after considering the failure history (especially repeated failures on the same step/issue), you determine the task is unachievable or cannot be reliably fixed:
        - Return an empty JSON array: []
        - Alternatively, return a plan with a single step using 'LLMStepExecutor' with 'isFinalAnswer: true'. The prompt for this step should clearly explain to the user why the task is considered unachievable, referencing the persistent errors. Example: { "prompt": "The task cannot be completed because attempts to process X consistently fail due to Y. All available methods have been exhausted.", "isFinalAnswer": true }.

    Твой новый план должен (если ты не выбираешь вариант B):
    а) Учитывать причину предыдущего сбоя (из 'Information about the failed step' и 'History of attempts...').
    б) Предложить конкретные изменения или АЛЬТЕРНАТИВНЫЕ шаги для обхода проблемы. Не повторяй слепо предыдущие неудачные действия.
    в) Если проблема не в конкретном шаге, а в общей стратегии, ПЕРЕСМОТРЕТЬ СТРАТЕГИЮ.
    г) Если предыдущие шаги (из 'Recent execution context') дали полезные результаты, старайся их ИСПОЛЬЗОВАТЬ в новом плане, чтобы не делать лишнюю работу.
    д) НЕ ЗАЦИКЛИВАЙСЯ на создании неработающих планов. Если после ${revisionAttemptNumber} попыток (и особенно если история текущего цикла показывает повторы) задача не решается, признай ее невыполнимой (вариант B).
    `;
        return revisionContext;
    }

    _buildBasePlanningPrompt(formattedAgentCapabilitiesString, orchestratorSpecialActionsDescription, planFormatInstructions, PRINCIPLES_OF_GOOD_PLANNING) {
        return `
${PRINCIPLES_OF_GOOD_PLANNING}

Available agent capabilities:
---
${formattedAgentCapabilitiesString}
---
${orchestratorSpecialActionsDescription}
---
${planFormatInstructions}`;
    }

    _getLLMCallParams(memoryContext, originalPlanningPrompt, userTaskString, isRevision, revisionAttemptNumber, basePromptSection) {
        let llmCallPromptToUse = originalPlanningPrompt;

        // Determine the model for the LLM call, defaulting appropriately
        let defaultModelForService = 'gpt-4'; // General default
        if (this.aiService.getServiceName && this.aiService.getServiceName() === 'GeminiService') {
            defaultModelForService = 'gemini-1.5-pro-latest'; // Gemini specific default
        }
        const paramsForLLM = {
            model: (this.aiService.baseConfig && this.aiService.baseConfig.planningModel) || defaultModelForService
        };

        // Check if running with GeminiService and if OrchestratorAgent has prepared a CachedContent.
        if (this.aiService.getServiceName && this.aiService.getServiceName() === 'GeminiService' &&
            memoryContext && memoryContext.isMegaContextCachedByGemini === true &&
            memoryContext.geminiCachedContentName) {

            console.log(`PlanManager: Gemini CachedContent (Name: ${memoryContext.geminiCachedContentName}) found. Using short prompt for planning.`);

            if (isRevision) {
                llmCallPromptToUse = `Original User Task: '${userTaskString}'.
This is a replanning attempt (Attempt #${revisionAttemptNumber}).
Detailed context including previous attempt's failure, execution history, CWC, key findings, and errors has been provided in the cached content.
Instruction: Based on ALL available information (original task, cached context, and the specific details of the previous failure), generate a revised plan.
${basePromptSection}`;
            } else {
                llmCallPromptToUse = `User Task: '${userTaskString}'.
The necessary context (task definition, uploaded files, key findings, chat history) has been provided and is cached.
${basePromptSection}
Based on the cached context and the user task, generate a plan.`;
            }
            paramsForLLM.cachedContentName = memoryContext.geminiCachedContentName;
        }
        return { llmCallPromptToUse, paramsForLLM };
    }

    async getPlan(
        userTaskString,
        knownAgentRoles,
        knownToolsByRole,
        memoryContext = null, // New parameter
        currentCWC = null,
        executionContextSoFar = null,
        failedStepInfo = null,
        remainingPlanStages = null,
        isRevision = false,
        revisionAttemptNumber = 0,
        latestKeyFindings = [], // New parameter
        latestErrors = [],      // New parameter
        replanErrorHistory = null // New parameter
    ) {
        let initialPromptSection = `User task: '${userTaskString}'.`;
        if (memoryContext && memoryContext.taskDefinition && memoryContext.taskDefinition !== userTaskString) {
            initialPromptSection = `Original task definition from memory: "${memoryContext.taskDefinition}"
Current user request (if refining or different): "${userTaskString}"`;
        } else if (memoryContext && memoryContext.taskDefinition) {
            initialPromptSection = `User task (from memory): "${memoryContext.taskDefinition}"`;
        }

        let memoryContextPromptSection = "";
        if (memoryContext) {
            if (memoryContext.retrievedKeyDecisions && memoryContext.retrievedKeyDecisions.trim() !== "") {
                memoryContextPromptSection += `

Previously noted key decisions and learnings:
---
${memoryContext.retrievedKeyDecisions}
---`;
            }
            if (memoryContext.retrievedCwcSnapshot && Object.keys(memoryContext.retrievedCwcSnapshot).length > 0) {
                const cwcSnap = memoryContext.retrievedCwcSnapshot;
                let cwcSummaryForPrompt = `

Snapshot of relevant prior working context (summary):
- Prior Progress Summary: ${cwcSnap.summaryOfProgress || 'N/A'}
- Prior Next Objective: ${cwcSnap.nextObjective || 'N/A'}
- Prior Key Findings (count): ${(cwcSnap.keyFindings && cwcSnap.keyFindings.length) || 0}
- Prior Errors Encountered (count): ${(cwcSnap.errorsEncountered && cwcSnap.errorsEncountered.length) || 0}`;
                memoryContextPromptSection += `${cwcSummaryForPrompt}
---`;
            }
        }

        if (!isRevision) {
            const templatePlan = await this.tryGetPlanFromTemplate(userTaskString);
            if (templatePlan) {
                if (Array.isArray(templatePlan) && templatePlan.every(stage => Array.isArray(stage))) {
                    return { success: true, plan: templatePlan, source: "template", rawResponse: null };
                } else {
                    console.error("PlanManager: Template plan is not in the expected format (array of stages). Falling back to LLM.");
                }
            }
            console.log("PlanManager: No valid matching template found or template was invalid, proceeding with LLM-based planning for initial plan.");
        } else {
            console.log(`PlanManager: Proceeding with LLM-based replanning. Attempt: ${revisionAttemptNumber}`);
        }

        let formattedAgentCapabilitiesString = "";
        if (!this.agentCapabilities || this.agentCapabilities.length === 0) {
            console.error("PlanManager: No worker agent capabilities defined. Cannot proceed with LLM planning.");
            return { success: false, message: "Internal Server Error: No worker agent capabilities configured for LLM planning.", source: "internal_error", rawResponse: null };
        }
        this.agentCapabilities.forEach(agent => {
            formattedAgentCapabilitiesString += `Agent Role: ${agent.role}\n`;
            formattedAgentCapabilitiesString += `Description: ${agent.description}\n`;
            formattedAgentCapabilitiesString += `Tools:\n`;
            agent.tools.forEach(tool => {
                formattedAgentCapabilitiesString += `  - ${tool.name}: ${tool.description}\n`;
            });
            formattedAgentCapabilitiesString += "---\n";
        });

        const orchestratorSpecialActionsDescription = `
Orchestrator Special Actions:
 - ExploreSearchResults: This is a special action for the Orchestrator. It should be used AFTER a WebSearchTool step to gather more detailed information from the search results.
   Input ('sub_task_input'):
     - 'pagesToExplore': (Optional, Integer, Default: 2) Number of top search result links to read using ReadWebpageTool.
     - 'relevanceCriteria': (Optional, String) Brief guidance on what makes a search result relevant for deeper exploration (e.g., "pages offering detailed explanations", "official documentation"). Orchestrator will primarily use the order of results.
   Functionality: The Orchestrator will take the results from the most recent WebSearchTool step in a preceding stage. It will select up to 'pagesToExplore' links. For each selected link, it will internally use 'ReadWebpageTool' to fetch its content. The collected content from all explored pages will then be aggregated.
   Output: An aggregated string containing the content from all explored pages.
   When to use: Use this if the user's task implies needing more than just search snippets and requires information from the content of the web pages found.
 - LLMStepExecutor: This is a special action for the Orchestrator to directly use the configured AI Service (e.g., Gemini, OpenAI) for a specific step that doesn't fit other tools, like complex reasoning, summarization of diverse inputs, or reformatting text.
   Input ('sub_task_input'):
     - 'prompt_template': (String) A template for the prompt. Use {{placeholder_name}} for dynamic values. Special param '{previous_step_output}' will be replaced by the output of the immediately preceding step if available.
     - 'prompt_params': (Optional, Object) Key-value pairs to fill in the prompt_template.
     - 'prompt': (String, Alternative to template/params) A direct prompt string if no templating is needed.
     - 'messages': (Array, Alternative to prompt/template) An array of chat messages (e.g., [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]).
     - 'model': (Optional, String) Specify a model name if you want this step to use a particular model (e.g., 'gpt-4', 'gemini-pro'). If omitted, a default model configured for the AI service will be used.
     - 'temperature': (Optional, Number) Sampling temperature.
     - 'maxTokens': (Optional, Number) Maximum number of tokens to generate.
     - 'isFinalAnswer': (Optional, Boolean, Default: false) If this step, when assigned to "Orchestrator", is intended to produce the final answer to the user's query, set this to true. Example: { "prompt": "Final summary of findings.", "isFinalAnswer": true }.
   Output: The text generated by the LLM or the content from the assistant's message in chat.
   When to use: For general LLM-based tasks, summarizations, or when a step requires complex text generation based on context or previous step outputs, especially if it's meant to be the final user-facing response. Также используй \`LLMStepExecutor\` для шагов, где требуется анализ ситуации, оценка результатов предыдущих шагов, или принятие решения о дальнейшей стратегии, если это не покрывается другими инструментами.
 - FileSystemTool: Allows Orchestrator to perform file system operations within a sandboxed task-specific workspace.
   Input ('sub_task_input'):
     - 'operation': (String) One of ["create_file", "read_file", "append_to_file", "list_files", "overwrite_file", "create_pdf_from_text"].
     - 'params': (Object) Parameters for the operation:
       - create_file: { "filename": "string", "content": "string", "directory"?: "string" (optional subdirectory) }
       - read_file: { "filename": "string", "directory"?: "string" }
       - append_to_file: { "filename": "string", "content": "string", "directory"?: "string" } (content must be non-empty)
       - list_files: { "directory"?: "string" (optional subdirectory relative to workspace root), "recursive"?: boolean (optional, default: false, if true lists recursively), "maxDepth"?: number (optional, default: 3 if recursive, limits recursion depth) }
       - overwrite_file: (alias for create_file) { "filename": "string", "content": "string", "directory"?: "string" }
       - create_pdf_from_text: { "filename": "string_ending_with.pdf", "text_content": "string", "directory"?: "string", "fontSize"?: number, "fontName"?: "string", "customFontFileName"?: "string_ending_with.ttf_or_otf" (e.g., "DejaVuSans.ttf", from 'assets/fonts/') }
   Output: Varies by operation (e.g., success message, file content, or for list_files: Array<{path: string, type: 'file'|'directory'}> where paths are relative to task workspace root).
   When to use: For tasks requiring intermediate data storage, reading specific files, or organizing outputs within a dedicated workspace for the current task. All paths are relative to the task's workspace root.
 - FileDownloaderTool: Allows Orchestrator to download files from a URL into the task-specific workspace.
   Input ('sub_task_input'):
     - 'operation': (String) Must be "download_file".
     - 'params': (Object) { "url": "string_url_to_download", "directory"?: "string" (optional subdirectory), "filename"?: "string" (optional, will try to infer if not provided) }.
   Output: Success message with path to downloaded file or error.
   When to use: When a task requires fetching a file from an external URL for later processing or reference. Downloads are subject to size limits.
---
(End of available agents list and special actions)`;

        const planFormatInstructions = `
Based on the user task and available capabilities, create a multi-stage execution plan.
The plan MUST be a JSON array of stages. Each stage MUST be a JSON array of sub-task objects.
Sub-tasks within the same stage can be executed in parallel. Stages are executed sequentially.
Each sub_task object in an inner array must have the following keys:
1. 'stepId': String (A unique, non-empty identifier for this step within the plan, e.g., "search_articles", "analyze_data_1"). This ID is used for referencing outputs.
2. 'assigned_agent_role': String (must be one of [${knownAgentRoles.map(r => `"${r}"`).join(", ")}] OR "Orchestrator" for special actions).
3. 'tool_name': String (must be a tool available to the assigned agent OR a special action name like "ExploreSearchResults", "LLMStepExecutor", "FileSystemTool", "FileDownloaderTool").
4. 'sub_task_input': Object (the input for the specified tool or action).
   - This input can reference outputs from PREVIOUSLY EXECUTED steps using the syntax \`@{outputs.SOURCE_STEP_ID.FIELD_NAME}\`.
   - \`SOURCE_STEP_ID\` must be the 'stepId' of a step that is guaranteed to have completed (e.g., from a previous stage, or an earlier step in the same stage if execution within a stage is sequential for Orchestrator steps).
   - \`FIELD_NAME\` can be 'result_data' (for the raw output of the source step) or 'processed_result_data' (for the summarized/processed output, if available; defaults to raw if not processed).
   - Example: \`{ "content": "Summary from previous step: @{outputs.summarize_step.processed_result_data}" }\`
   - For "LLMStepExecutor" by "Orchestrator", if it's the final answer, include 'isFinalAnswer: true'. It can also take an optional 'model' parameter.
   - For "FileSystemTool" or "FileDownloaderTool", this must include 'operation' and 'params'.
5. 'narrative_step': String (a short, human-readable description of this step's purpose).

For the 'ExploreSearchResults' action, set 'assigned_agent_role' to "Orchestrator" and 'tool_name' to "ExploreSearchResults". The 'sub_task_input' may include 'pagesToExplore' and 'relevanceCriteria'.
For the 'LLMStepExecutor' action by 'Orchestrator', if it's producing the final user answer, include 'isFinalAnswer: true' in 'sub_task_input'.
For 'FileSystemTool' and 'FileDownloaderTool' actions by 'Orchestrator', ensure 'sub_task_input' contains 'operation' and the correct 'params' for that operation.

Example of a plan using FileSystemTool, stepId, and output referencing:
\`\`\`json
[
  [
    {
      "stepId": "extract_info",
      "assigned_agent_role": "Orchestrator",
      "tool_name": "LLMStepExecutor",
      "sub_task_input": {
        "prompt": "Extract key information from the user query."
      },
      "narrative_step": "Extract key information for report generation."
    }
  ],
  [
    {
      "stepId": "create_report_pdf",
      "assigned_agent_role": "Orchestrator",
      "tool_name": "FileSystemTool",
      "sub_task_input": {
        "operation": "create_pdf_from_text",
        "params": {
          "filename": "report_with_extracted_info.pdf",
          "text_content": "Report based on: @{outputs.extract_info.result_data}",
          "directory": "reports",
          "customFontFileName": "DejaVuSans.ttf"
        }
      },
      "narrative_step": "Create a PDF report using extracted information."
    }
  ],
  [
    {
      "stepId": "final_confirmation",
      "assigned_agent_role": "Orchestrator",
      "tool_name": "LLMStepExecutor",
      "sub_task_input": {
        "prompt": "The PDF report 'reports/report_with_extracted_info.pdf' has been created. This is the final confirmation.",
        "isFinalAnswer": true
      },
      "narrative_step": "Confirm PDF creation and provide final status."
    }
  ]
]
\`\`\`

IMPORTANT CONSIDERATIONS FOR CONTEXT LENGTH:
- When using tools that can return large amounts of text, such as Context7DocumentationTool, be mindful of the overall context window of subsequent LLM calls that might use this text.
- For 'Context7DocumentationTool', if you anticipate the fetched documentation will be used directly in another LLM prompt (e.g., with LLMStepExecutor), consider specifying a 'maxTokens' value in its 'sub_task_input' (e.g., 2000 or 3000) to request a more concise version of the documentation from Context7. This helps prevent exceeding token limits in subsequent steps.

Produce ONLY the JSON array of stages. Do not include any other text before or after the JSON.`;

        let planningPrompt;
        let sourcePrefix = isRevision ? "llm_revision" : "llm";

        const PRINCIPLES_OF_GOOD_PLANNING = `
---
Принципы Качественного Планирования:
Прежде чем генерировать JSON-план, продумай следующие аспекты:

1.  **Понимание Цели**: Убедись, что ты точно понял конечную цель задачи пользователя. Если задача неясна, твой первый шаг в плане может быть направлен на уточнение задачи с помощью \`LLMStepExecutor\`, запросив у пользователя дополнительные детали.
2.  **Декомпозиция**: Разбей сложную задачу на более мелкие, управляемые этапы и шаги. Каждый шаг должен иметь четкую, единственную цель.
3.  **Логическая Последовательность и Зависимости**:
    *   Располагай шаги в строгой логической последовательности.
    *   Если шаг Б зависит от результата шага А, убедись, что шаг А выполняется раньше. Используй механизм ссылок \`@{outputs.STEP_A_ID.result_data}\` для передачи данных между шагами.
    *   Кратко описывай зависимости в \`narrative_step\`, если это помогает пониманию.
4.  **Эффективность и Оптимальность**:
    *   Старайся достичь цели с минимально необходимым количеством шагов. Избегай избыточных или повторяющихся действий.
    *   Выбирай наиболее подходящий инструмент для каждого шага.
5.  **Предвидение и Обработка Ошибок (Базовый уровень)**:
    *   Если какой-то шаг потенциально может завершиться неудачей (например, поиск информации может не дать результатов, или внешний ресурс может быть недоступен), подумай, можно ли добавить альтернативный шаг или шаг для проверки результата.
    *   Для задач, где результат не гарантирован, план может включать шаги по информированию пользователя о невозможности выполнения или о частичных результатах.
        *   **Полнота**: Убедись, что план покрывает все аспекты запроса пользователя, если это возможно в рамках одного плана.
        *   **Конкретность \`sub_task_input\`**: Для каждого шага \`sub_task_input\` должен быть максимально конкретным и содержать все необходимые параметры для инструмента. Не полагайся на то, что агент "догадается".

Помни, что хороший план — это не просто набор шагов, а логически выстроенная стратегия для решения задачи.
---
`;

        if (isRevision) {
            const revisionPromptSection = this._buildRevisionContextPrompt(userTaskString, currentCWC, latestKeyFindings, latestErrors, failedStepInfo, remainingPlanStages, executionContextSoFar, revisionAttemptNumber, replanErrorHistory);
            let fullRevisionPromptBase;

            if (memoryContext && memoryContext.megaContext && typeof memoryContext.megaContext === 'string' && memoryContext.megaContext.trim() !== '') {
                fullRevisionPromptBase = `${memoryContext.megaContext}

${revisionPromptSection}`;
                sourcePrefix += "_with_megacontext";
            } else {
                fullRevisionPromptBase = `${revisionPromptSection}${memoryContextPromptSection}`;
            }
            const basePromptSection = this._buildBasePlanningPrompt(formattedAgentCapabilitiesString, orchestratorSpecialActionsDescription, planFormatInstructions, PRINCIPLES_OF_GOOD_PLANNING);
            planningPrompt = `${fullRevisionPromptBase}${basePromptSection}`;

        } else {
            // Logic for initial planning
            const basePromptSection = this._buildBasePlanningPrompt(formattedAgentCapabilitiesString, orchestratorSpecialActionsDescription, planFormatInstructions, PRINCIPLES_OF_GOOD_PLANNING);
            // Check if a pre-assembled megaContext is provided in memoryContext.
            if (memoryContext && memoryContext.megaContext && typeof memoryContext.megaContext === 'string' && memoryContext.megaContext.trim() !== '') {
                // If megaContext exists, it becomes the primary informational base for the planning prompt.
                // It should already contain task definition, uploaded files, key findings, etc.
                // We then append the userTaskString explicitly for emphasis, followed by standard planning instructions.
                planningPrompt = `${memoryContext.megaContext}

User Task (ensure this is addressed by the plan): '${userTaskString}'${basePromptSection}`;
                sourcePrefix += "_with_megacontext"; // Update source prefix for tracking.
            } else {
                // Fallback to the original logic if megaContext is not available.
                // This constructs the prompt from individual pieces like initialPromptSection (user task)
                // and memoryContextPromptSection (summarized decisions, CWC snapshot).
                planningPrompt = `${initialPromptSection}${memoryContextPromptSection}${basePromptSection}`;
            }
        }

        let planJsonString;
        const basePromptSection = this._buildBasePlanningPrompt(formattedAgentCapabilitiesString, orchestratorSpecialActionsDescription, planFormatInstructions, PRINCIPLES_OF_GOOD_PLANNING);

        // Determine the actual prompt and parameters for the LLM call
        const { llmCallPromptToUse, paramsForLLM } = this._getLLMCallParams(
            memoryContext,
            planningPrompt, // This is the potentially long/full prompt
            userTaskString,
            isRevision,
            revisionAttemptNumber,
            basePromptSection // Pass basePromptSection for Gemini cache prompt reconstruction
        );

        try {
            planJsonString = await this.aiService.generateText(llmCallPromptToUse, paramsForLLM);
        } catch (llmError) {
            console.error(`PlanManager: Error from AI service during ${sourcePrefix} planning:`, llmError.message);
            return { success: false, message: `Failed to generate plan due to AI service error: ${llmError.message}`, source: `${sourcePrefix}_service_error`, rawResponse: null };
        }

        const validationResult = await this.parseAndValidatePlan(planJsonString, knownAgentRoles, knownToolsByRole);
        if (!validationResult.success) {
            return { success: false, message: validationResult.message, source: `${sourcePrefix}_validation_error`, rawResponse: validationResult.rawResponse };
        }

        return { success: true, plan: validationResult.stages, source: sourcePrefix, rawResponse: validationResult.rawResponse };
    }
}

module.exports = PlanManager;
