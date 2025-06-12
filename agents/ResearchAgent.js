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
            // Tool is in toolsMap but not explicitly handled by this agent's if/else logic
            outcome.error = { category: "UNSUPPORTED_TOOL", message: `Tool '${tool_name}' is present but not explicitly supported by ResearchAgent's current logic.` };
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
            // If outcome exists but outcome.error is not (e.g. a tool returned { result: ..., error: undefined/falsey }),
            // or if outcome itself is falsey (should not happen if initialized properly)
            if (outcome && !outcome.error) {
                outcome.error = { category: "AGENT_INTERNAL_ERROR", message: `Tool '${tool_name}' execution failed or returned an invalid error structure.` };
            } else if (!outcome) { // Should ideally not be reached if outcome is initialized
                outcome = { result: null, error: { category: "AGENT_INTERNAL_ERROR", message: `Outcome object was null after tool '${tool_name}' execution.` } };
            }
            // If outcome.error is already a structured error from the tool, it will be preserved.
        }

      } catch (e) { // This catch block handles rejections from Promise.race (i.e., timeout) or other unexpected errors.
        console.error(`ResearchAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        status = "FAILED"; // Ensure status is FAILED
        if (e.message && e.message.toLowerCase().includes("timed out")) {
            outcome.error = { category: "TOOL_TIMEOUT", message: e.message, details: { originalError: e.toString() } };
        } else {
            outcome.error = { category: "AGENT_INTERNAL_ERROR", message: e.message || "An unexpected error occurred in ResearchAgent.", details: { originalError: e.toString() } };
        }
        // Ensure result is null in case of an error
        outcome.result = null;
      }
    } else {
        console.error(`ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        outcome.error = { category: "TOOL_NOT_FOUND", message: `Tool '${tool_name}' not found in ResearchAgent's toolsMap.` };
        status = "FAILED"; // Ensure status is FAILED
        outcome.result = null; // Ensure result is null
    }

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result, // This will be null if there was an error
      error_details: outcome.error // outcome.error is now the structured error object or null
    };

    console.log(`ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
