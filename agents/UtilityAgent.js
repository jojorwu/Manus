class UtilityAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // e.g., { "CalculatorTool": calculatorToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig; // For future tools that might need keys
    this.agentRole = "UtilityAgent";
    console.log("UtilityAgent initialized.");
  }

  startListening() {
    console.log(`UtilityAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 30000; // 30 секунд
    console.log(`UtilityAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    console.log('UtilityAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2));

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { result: null, error: `Unknown tool '${tool_name}' for UtilityAgent.` }; // Default to error
    let status = "FAILED"; // Default status

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        let validInput = false;
        let executionPromise = null;

        if (tool_name === "CalculatorTool") {
            if (sub_task_input && typeof sub_task_input.expression === 'string') {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { result: null, error: "Invalid input for CalculatorTool: 'expression' string is required." };
            }
        }
        // Future: else if (tool_name === "AnotherUtilityTool") { ... }
        else {
            // This case should ideally not be hit if Orchestrator assigns valid tools
            outcome = { result: null, error: `Tool '${tool_name}' not specifically handled by UtilityAgent logic, though it exists in toolsMap.` };
        }

        if (validInput && executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)), TOOL_EXECUTION_TIMEOUT_MS)
            );
            outcome = await Promise.race([executionPromise, timeoutPromise]);
        }
        // If validInput was false, outcome already contains the validation error.

        // Determine status based on the outcome
        if (validInput && executionPromise && outcome && outcome.error === null) {
            status = "COMPLETED";
        }
        // Other cases (validation error, tool error from executionPromise, timeout caught in catch block)
        // will result in status remaining "FAILED".
        // outcome.error will hold the specific error message.

      } catch (e) { // This catch block handles rejections from Promise.race (i.e., timeout) or other unexpected errors.
        console.error(`UtilityAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        // Ensure outcome reflects the error from the catch block
        outcome = { result: null, error: e.message || "An unexpected error occurred during tool execution or timeout." };
        // status remains "FAILED" (as initialized)
      }
    } else {
        console.error(`UtilityAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
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

    console.log(`UtilityAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = UtilityAgent;
