// core/PlanManager.js
const fs = require('fs');
const path = require('path');

class PlanManager {
    constructor(llmService, agentCapabilities, planTemplatesPath) {
        this.llmService = llmService;
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
            if (!fs.existsSync(templatesDir)) {
                console.warn(`PlanManager: Plan templates directory not found at ${templatesDir}. No templates loaded.`);
                return;
            }
            // These definitions might need to be passed in or made more generic if they change often
            const templateDefinitions = [
                { name: "weather_query", fileName: "weather_query_template.json", regex: /^(?:what is the )?weather (?:in )?(.+)/i, paramMapping: { CITY_NAME: 1 } },
                { name: "calculator", fileName: "calculator_template.json", regex: /^(?:calculate|what is) ([\d\s\+\-\*\/\(\)\.^%]+)/i, paramMapping: { EXPRESSION: 1 } }
            ];
            for (const def of templateDefinitions) {
                const filePath = path.join(templatesDir, def.fileName);
                if (fs.existsSync(filePath)) {
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
                    const groupIndex = templateInfo.paramMapping[placeholder];
                    const value = match[groupIndex] ? match[groupIndex].trim() : "";
                    populatedTemplateString = populatedTemplateString.replace(new RegExp(`{{${placeholder}}}`, 'g'), value);
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
            if (parsedStages.length === 0) {
                return { success: false, message: "LLM plan is empty (no stages).", rawResponse: cleanedString, stages: [] };
            }

            for (const stage of parsedStages) {
                if (!Array.isArray(stage)) {
                    return { success: false, message: "Invalid stage in plan: not an array.", rawResponse: cleanedString, stages: [] };
                }
                if (stage.length === 0) {
                    return { success: false, message: "Invalid stage in plan: stage is empty.", rawResponse: cleanedString, stages: [] };
                }
                for (const subTask of stage) {
                    if (typeof subTask !== 'object' || subTask === null) {
                        return { success: false, message: "Invalid sub-task structure: not an object.", rawResponse: cleanedString, stages: [] };
                    }

                    if (subTask.assigned_agent_role === "Orchestrator") {
                        const allowedOrchestratorTools = ["ExploreSearchResults", "GeminiStepExecutor", "FileSystemTool", "FileDownloaderTool"];
                        if (!allowedOrchestratorTools.includes(subTask.tool_name)) {
                            return { success: false, message: `Invalid 'tool_name': ${subTask.tool_name} for Orchestrator role. Allowed tools are: ${allowedOrchestratorTools.join(", ")}.`, rawResponse: cleanedString, stages: [] };
                        }
                        // Basic validation for operation and params
                        if (!subTask.sub_task_input || typeof subTask.sub_task_input.operation !== 'string') {
                            if (subTask.tool_name === "FileSystemTool" || subTask.tool_name === "FileDownloaderTool") { // ExploreSearchResults and GeminiStepExecutor might not always have 'operation'
                                return { success: false, message: `'operation' is required in sub_task_input for Orchestrator tool ${subTask.tool_name}.`, rawResponse: cleanedString, stages: [] };
                            }
                        }
                        if (!subTask.sub_task_input || typeof subTask.sub_task_input.params !== 'object') {
                             if (subTask.tool_name === "FileSystemTool" || subTask.tool_name === "FileDownloaderTool") {
                                return { success: false, message: `'params' object is required in sub_task_input for Orchestrator tool ${subTask.tool_name}.`, rawResponse: cleanedString, stages: [] };
                            }
                        }
                        // Further specific param validation can be added here if needed
                        if (subTask.tool_name === "FileSystemTool") {
                            const fsOps = ["create_file", "read_file", "append_to_file", "list_files", "overwrite_file"];
                            if (!fsOps.includes(subTask.sub_task_input.operation)) {
                                return { success: false, message: `Invalid 'operation': ${subTask.sub_task_input.operation} for FileSystemTool.`, rawResponse: cleanedString, stages: [] };
                            }
                            if ((subTask.sub_task_input.operation === "create_file" || subTask.sub_task_input.operation === "read_file" || subTask.sub_task_input.operation === "append_to_file" || subTask.sub_task_input.operation === "overwrite_file") && (!subTask.sub_task_input.params || typeof subTask.sub_task_input.params.filename !== 'string')) {
                                return { success: false, message: `'params.filename' is required for FileSystemTool operation '${subTask.sub_task_input.operation}'.`, rawResponse: cleanedString, stages: [] };
                            }
                        }
                        if (subTask.tool_name === "FileDownloaderTool") {
                            if (subTask.sub_task_input.operation !== "download_file") {
                                return { success: false, message: `Invalid 'operation': ${subTask.sub_task_input.operation} for FileDownloaderTool. Must be 'download_file'.`, rawResponse: cleanedString, stages: [] };
                            }
                            if (!subTask.sub_task_input.params || typeof subTask.sub_task_input.params.url !== 'string') {
                                return { success: false, message: `'params.url' is required for FileDownloaderTool.`, rawResponse: cleanedString, stages: [] };
                            }
                        }

                    } else if (!knownAgentRoles.includes(subTask.assigned_agent_role)) {
                        return { success: false, message: `Invalid or unknown 'assigned_agent_role': ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                    } else {
                        const agentTools = knownToolsByRole[subTask.assigned_agent_role];
                        if (!subTask.tool_name || typeof subTask.tool_name !== 'string' || !agentTools || !agentTools.includes(subTask.tool_name)) {
                            return { success: false, message: `Invalid or unknown 'tool_name': ${subTask.tool_name} for role ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, stages: [] };
                        }
                    }

                    if (typeof subTask.sub_task_input !== 'object' || subTask.sub_task_input === null) {
                        return { success: false, message: "Invalid 'sub_task_input': must be an object.", rawResponse: cleanedString, stages: [] };
                    }
                    if (!subTask.narrative_step || typeof subTask.narrative_step !== 'string' || !subTask.narrative_step.trim()) {
                        return { success: false, message: "Missing or empty 'narrative_step'.", rawResponse: cleanedString, stages: [] };
                    }
                }
            }
            return { success: true, stages: parsedStages, rawResponse: cleanedString };
        } catch (e) {
            const trimmedRawResponse = cleanedString.length > MAX_RAW_RESPONSE_LENGTH ? cleanedString.substring(0, MAX_RAW_RESPONSE_LENGTH) + "..." : cleanedString;
            console.error("PlanManager: Error parsing sub-task plan JSON:", e.message, "Raw response:", trimmedRawResponse);
            return { success: false, message: "Failed to parse LLM plan: " + e.message, rawResponse: trimmedRawResponse, stages: [] };
        }
    }

    async getPlan(userTaskString, knownAgentRoles, knownToolsByRole) {
        const templatePlan = await this.tryGetPlanFromTemplate(userTaskString);
        if (templatePlan) {
            // Basic validation for template plan structure
            if (Array.isArray(templatePlan) && templatePlan.every(stage => Array.isArray(stage))) {
                // Further validation could be done here using parseAndValidatePlan if necessary,
                // but templates are assumed to be pre-validated to some extent.
                // For now, we'll assume valid structure if it's an array of arrays.
                return { success: true, plan: templatePlan, source: "template", rawResponse: null };
            } else {
                console.error("PlanManager: Template plan is not in the expected format (array of stages). Falling back to LLM.");
                // Fall through to LLM planning
            }
        }

        console.log("PlanManager: No valid matching template found or template was invalid, proceeding with LLM-based planning.");

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

        // The planningPrompt from OrchestratorAgent, now within PlanManager
        const planningPrompt = `User task: '${userTaskString}'.
Available agent capabilities:
---
${formattedAgentCapabilitiesString}
---
Orchestrator Special Actions:
 - ExploreSearchResults: This is a special action for the Orchestrator. It should be used AFTER a WebSearchTool step to gather more detailed information from the search results.
   Input ('sub_task_input'):
     - 'pagesToExplore': (Optional, Integer, Default: 2) Number of top search result links to read using ReadWebpageTool.
     - 'relevanceCriteria': (Optional, String) Brief guidance on what makes a search result relevant for deeper exploration (e.g., "pages offering detailed explanations", "official documentation"). Orchestrator will primarily use the order of results.
   Functionality: The Orchestrator will take the results from the most recent WebSearchTool step in a preceding stage. It will select up to 'pagesToExplore' links. For each selected link, it will internally use 'ReadWebpageTool' to fetch its content. The collected content from all explored pages will then be aggregated.
   Output: An aggregated string containing the content from all explored pages.
   When to use: Use this if the user's task implies needing more than just search snippets and requires information from the content of the web pages found.
 - GeminiStepExecutor: This is a special action for the Orchestrator to directly use an LLM for a specific step that doesn't fit other tools, like complex reasoning, summarization of diverse inputs, or reformatting text.
   Input ('sub_task_input'):
     - 'prompt_template': (String) A template for the prompt. Use {{placeholder_name}} for dynamic values. Special param '{previous_step_output}' will be replaced by the output of the immediately preceding step if available.
     - 'prompt_params': (Optional, Object) Key-value pairs to fill in the prompt_template.
     - 'prompt': (String, Alternative to template/params) A direct prompt string if no templating is needed.
     - 'isFinalAnswer': (Optional, Boolean, Default: false) If this step, when assigned to "Orchestrator", is intended to produce the final answer to the user's query, set this to true. Example: { "prompt": "Final summary of findings.", "isFinalAnswer": true }.
   Output: The text generated by the LLM.
   When to use: For general LLM-based tasks, summarizations, or when a step requires complex text generation based on context or previous step outputs, especially if it's meant to be the final user-facing response.
 - FileSystemTool: Allows Orchestrator to perform file system operations within a sandboxed task-specific workspace.
   Input ('sub_task_input'):
     - 'operation': (String) One of ["create_file", "read_file", "append_to_file", "list_files", "overwrite_file"].
     - 'params': (Object) Parameters for the operation:
       - create_file: { "filename": "string", "content": "string", "directory"?: "string" (optional subdirectory) }
       - read_file: { "filename": "string", "directory"?: "string" }
       - append_to_file: { "filename": "string", "content": "string", "directory"?: "string" } (content must be non-empty)
       - list_files: { "directory"?: "string" } (lists contents of this subdirectory within the workspace, or root if empty)
       - overwrite_file: (alias for create_file) { "filename": "string", "content": "string", "directory"?: "string" }
   Output: Varies by operation (e.g., success message, file content, list of files/dirs).
   When to use: For tasks requiring intermediate data storage, reading specific files, or organizing outputs within a dedicated workspace for the current task. All paths are relative to the task's workspace root.
 - FileDownloaderTool: Allows Orchestrator to download files from a URL into the task-specific workspace.
   Input ('sub_task_input'):
     - 'operation': (String) Must be "download_file".
     - 'params': (Object) { "url": "string_url_to_download", "directory"?: "string" (optional subdirectory), "filename"?: "string" (optional, will try to infer if not provided) }.
   Output: Success message with path to downloaded file or error.
   When to use: When a task requires fetching a file from an external URL for later processing or reference. Downloads are subject to size limits.
---
(End of available agents list and special actions)
Based on the user task and available capabilities, create a multi-stage execution plan.
The plan MUST be a JSON array of stages. Each stage MUST be a JSON array of sub-task objects.
Sub-tasks within the same stage can be executed in parallel. Stages are executed sequentially.
Each sub_task object in an inner array must have the following keys:
1. 'assigned_agent_role': String (must be one of [${knownAgentRoles.map(r => `"${r}"`).join(", ")}] OR "Orchestrator" for special actions).
2. 'tool_name': String (must be a tool available to the assigned agent OR a special action name like "ExploreSearchResults", "GeminiStepExecutor", "FileSystemTool", "FileDownloaderTool").
3. 'sub_task_input': Object (the input for the specified tool or action). For "GeminiStepExecutor" by "Orchestrator", if it's the final answer, include 'isFinalAnswer: true'. For "FileSystemTool" or "FileDownloaderTool", this must include 'operation' and 'params'.
4. 'narrative_step': String (a short, human-readable description of this step's purpose).

For the 'ExploreSearchResults' action, set 'assigned_agent_role' to "Orchestrator" and 'tool_name' to "ExploreSearchResults". The 'sub_task_input' may include 'pagesToExplore' and 'relevanceCriteria'.
For the 'GeminiStepExecutor' action by 'Orchestrator', if it's producing the final user answer, include 'isFinalAnswer: true' in 'sub_task_input'.
For 'FileSystemTool' and 'FileDownloaderTool' actions by 'Orchestrator', ensure 'sub_task_input' contains 'operation' and the correct 'params' for that operation.

Example of a plan using FileSystemTool and FileDownloaderTool:
\`\`\`json
[
  [
    {
      "assigned_agent_role": "Orchestrator",
      "tool_name": "FileDownloaderTool",
      "sub_task_input": {
        "operation": "download_file",
        "params": { "url": "https://example.com/data.csv", "directory": "downloads", "filename": "external_data.csv" }
      },
      "narrative_step": "Download external data CSV for analysis."
    }
  ],
  [
    {
      "assigned_agent_role": "Orchestrator",
      "tool_name": "FileSystemTool",
      "sub_task_input": {
        "operation": "read_file",
        "params": { "filename": "external_data.csv", "directory": "downloads" }
      },
      "narrative_step": "Read the downloaded CSV data."
    }
  ],
  [
    {
      "assigned_agent_role": "Orchestrator",
      "tool_name": "GeminiStepExecutor",
      "sub_task_input": {
        "prompt_template": "Based on the CSV data: {{previous_step_output}}, provide a summary. This is the final answer.",
        "isFinalAnswer": true
      },
      "narrative_step": "Summarize the data from the CSV and provide it as the final answer."
    }
  ]
]
\`\`\`
Produce ONLY the JSON array of stages. Do not include any other text before or after the JSON.`;

        let planJsonString;
        try {
            planJsonString = await this.llmService(planningPrompt);
        } catch (llmError) {
            console.error("PlanManager: Error from LLM service during planning:", llmError.message);
            return { success: false, message: `Failed to generate plan due to LLM service error: ${llmError.message}`, source: "llm_service_error", rawResponse: null };
        }

        const validationResult = await this.parseAndValidatePlan(planJsonString, knownAgentRoles, knownToolsByRole);
        if (!validationResult.success) {
            return { success: false, message: validationResult.message, source: "llm_validation_error", rawResponse: validationResult.rawResponse };
        }

        return { success: true, plan: validationResult.stages, source: "llm", rawResponse: validationResult.rawResponse };
    }
}

module.exports = PlanManager;
