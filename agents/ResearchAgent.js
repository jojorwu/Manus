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
    let outcome = { result: null, error: null }; // Initialize with no error
    let status = "FAILED"; // Default status
    let executionPromise = null;

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        if (tool_name === "WebSearchTool" || tool_name === "ReadWebpageTool") {
            executionPromise = selectedTool.execute(sub_task_input);
        } else {
            outcome = { result: null, error: `Tool '${tool_name}' is not supported by ResearchAgent's explicit handling.` };
        }

        if (executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)), TOOL_EXECUTION_TIMEOUT_MS)
            );
            outcome = await Promise.race([executionPromise, timeoutPromise]);
        }
        // If executionPromise was null (tool not supported), outcome already has the error.

        // Determine status based on the outcome.error
        if (outcome && outcome.error === null) {
            status = "COMPLETED";
        } else {
            status = "FAILED";
            // Ensure outcome.error has a message if it's not already set (e.g. if outcome itself is null/undefined from a race condition)
            if (outcome && !outcome.error) {
                outcome.error = `Tool execution failed with no specific error message for ${tool_name}.`;
            } else if (!outcome) { // if outcome is null or undefined
                outcome = { result: null, error: `Tool execution failed with no outcome for ${tool_name}.` };
            }
        }

      } catch (e) { // This catch block handles rejections from Promise.race (i.e., timeout) or other unexpected errors.
        console.error(`ResearchAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        outcome = { result: null, error: e.message || "An unexpected error occurred during tool execution or timeout." };
        status = "FAILED";
      }
    } else {
        console.error(`ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        outcome = { result: null, error: `Unknown tool '${tool_name}' for ResearchAgent.` };
        status = "FAILED"; // Ensure status is FAILED
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
