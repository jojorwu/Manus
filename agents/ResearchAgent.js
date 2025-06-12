class ResearchAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // Expected: { "WebSearchTool": webSearchToolInstance, "ReadWebpageTool": readWebpageToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig; // For future tools that might need agent-specific keys
    this.agentRole = "ResearchAgent";
    console.log("ResearchAgent initialized.");
  }

  startListening() {
    console.log(`ResearchAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 30000; // 30 секунд
    console.log(`ResearchAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    console.log('ResearchAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2));

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { result: null, error: `Unknown tool '${tool_name}' for ResearchAgent or invalid input.` };
    let status = "FAILED"; // Default status

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        let validInput = false;
        let executionPromise = null;

        if (tool_name === "WebSearchTool") {
            if (sub_task_input && typeof sub_task_input.query === 'string') {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { result: null, error: "Invalid input for WebSearchTool: 'query' string is required." };
            }
        } else if (tool_name === "ReadWebpageTool") {
            if (sub_task_input && typeof sub_task_input.url === 'string') {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { result: null, error: "Invalid input for ReadWebpageTool: 'url' string is required." };
            }
        } else {
            // This case should ideally not be hit if Orchestrator assigns valid tools
            outcome = { result: null, error: `Tool '${tool_name}' not specifically handled by ResearchAgent logic, though it exists in toolsMap.` };
        }

        if (validInput && executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)), TOOL_EXECUTION_TIMEOUT_MS)
            );
            // Promise.race will either resolve with the tool's outcome or reject with the timeout error
            outcome = await Promise.race([executionPromise, timeoutPromise]);
        }
        // If validInput was false, outcome already contains the validation error.
        // If executionPromise was null (but validInput true - an unlikely scenario), this block is skipped, outcome might be default error.

        // Determine status based on the outcome
        if (validInput && executionPromise && outcome && outcome.error === null) {
            status = "COMPLETED";
        } else if (validInput && executionPromise && outcome && outcome.error) {
            // Error came from the tool itself (not a timeout caught in the catch block below)
            // or from the timeoutPromise if it resolved with an error object (which it doesn't, it rejects)
            // Status remains "FAILED", outcome already contains the error.
        } else if (!validInput) {
            // Input validation failed, status is "FAILED", outcome has the validation error.
        }
        // Any other scenario (e.g. executionPromise existed but outcome is somehow undefined) will also default to FAILED status.

      } catch (e) { // This catch block handles rejections from Promise.race (i.e., timeout) or other unexpected errors.
        console.error(`ResearchAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        // Ensure outcome reflects the error from the catch block
        outcome = { result: null, error: e.message || "An unexpected error occurred during tool execution or timeout." };
        // status remains "FAILED" (as initialized)
      }
    } else {
        console.error(`ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        // outcome is already set to "Unknown tool..."
    }

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result, // This will be null if there was an error
      error_details: outcome.error ? { message: outcome.error } : null
    };

    console.log(`ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
