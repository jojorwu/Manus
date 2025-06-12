class ResearchAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // Expected: { "WebSearchTool": webSearchToolInstance, "ReadWebpageTool": readWebpageToolInstance, "AdvancedWebpageReaderTool": advancedToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig;
    this.agentRole = "ResearchAgent";
    console.log("ResearchAgent initialized.");
  }

  startListening() {
    console.log(`ResearchAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 65000; // Increased timeout for potentially long Playwright tasks
    console.log(`ResearchAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    // console.log('ResearchAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2)); // Keep commented for production

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { success: false, result: null, error: `Unknown tool '${tool_name}' for ResearchAgent or invalid input.` }; // Default outcome structure
    let status = "FAILED"; // Default status

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        let validInput = false;
        let executionPromise = null;

        if (tool_name === "WebSearchTool") {
            if (sub_task_input && typeof sub_task_input.query === 'string' && sub_task_input.query.trim() !== "") {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { success: false, result: null, error: "Invalid input for WebSearchTool: 'query' string is required and must not be empty." };
            }
        } else if (tool_name === "ReadWebpageTool") {
            if (sub_task_input && typeof sub_task_input.url === 'string' && sub_task_input.url.trim() !== "") {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { success: false, result: null, error: "Invalid input for ReadWebpageTool: 'url' string is required and must not be empty." };
            }
        } else if (tool_name === "AdvancedWebpageReaderTool") {
            if (sub_task_input && typeof sub_task_input.url === 'string' && sub_task_input.url.trim() !== "") {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { success: false, result: null, error: "Invalid input for AdvancedWebpageReaderTool: 'url' string is required and must not be empty." };
            }
        } else {
            outcome = { success: false, result: null, error: `Tool '${tool_name}' not specifically handled by ResearchAgent's input validation logic, though it exists in toolsMap.` };
        }

        if (validInput && executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)), TOOL_EXECUTION_TIMEOUT_MS)
            );
            outcome = await Promise.race([executionPromise, timeoutPromise]);
        }

        // Status determination based on 'outcome.success' if present, otherwise on presence of 'outcome.error'
        if (typeof outcome.success === 'boolean') {
            if (outcome.success) {
                status = "COMPLETED";
            } else {
                // FAILED, error details should be in outcome.error and outcome.details
                // Ensure outcome.error is set if success is false but error isn't.
                if (!outcome.error) outcome.error = "Tool execution failed without specific error message.";
            }
        } else { // Fallback for tools not returning a 'success' boolean (older tools)
             if (outcome.error === null || outcome.error === undefined) { // Check if error is explicitly null or undefined
                status = "COMPLETED";
             } else {
                // status remains "FAILED"
             }
        }


      } catch (e) {
        console.error(`ResearchAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message, e.stack);
        outcome = { success: false, result: null, error: e.message || "An unexpected error occurred or tool timed out." , details: e.stack };
      }
    } else {
        console.error(`ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        // outcome already set to "Unknown tool..."
    }

    // Prepare result message based on the new outcome structure from AdvancedWebpageReaderTool
    // and adapt for older tools if necessary
    let resultDataForQueue = null;
    let errorDetailsForQueue = null;

    if (status === "COMPLETED") {
        // For AdvancedWebpageReaderTool and potentially newer tools, outcome is the whole result object
        // For older tools, outcome might just be { result: data, error: null }
        resultDataForQueue = (outcome.success !== undefined) ? outcome : outcome.result;
    } else { // FAILED
        if (outcome.error) {
             errorDetailsForQueue = {
                message: outcome.error,
                details: outcome.details || (outcome.error !== `Unknown tool '${tool_name}' for ResearchAgent or invalid input.` && outcome.error !== `Tool '${tool_name}' not specifically handled by ResearchAgent's input validation logic, though it exists in toolsMap.` ? "No additional details provided by tool." : undefined)
            };
             if (outcome.error.startsWith("Invalid input for")) { // Specific input validation errors
                errorDetailsForQueue.message = outcome.error;
                errorDetailsForQueue.details = "Input validation failed by agent.";
             }
        } else { // Should not happen if status is FAILED, but as a safeguard
            errorDetailsForQueue = { message: "Tool execution failed with an unspecified error." };
        }
    }


    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: resultDataForQueue,
      error_details: errorDetailsForQueue
    };

    console.log(`ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
