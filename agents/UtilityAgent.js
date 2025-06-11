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
    console.log(`UtilityAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { result: null, error: `Unknown tool '${tool_name}' for UtilityAgent.` }; // Default to error
    let status = "FAILED";

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        if (tool_name === "CalculatorTool") {
          // Input for CalculatorTool is expected to be { expression: "..." }
          if (sub_task_input && typeof sub_task_input.expression === 'string') {
            outcome = await selectedTool.execute(sub_task_input);
          } else {
            outcome = { result: null, error: "Invalid input for CalculatorTool: 'expression' string is required." };
          }
        }
        // Future: else if (tool_name === "AnotherUtilityTool") { ... }
        else {
            // This case should ideally not be hit if Orchestrator assigns valid tools for this agent role
             outcome = { result: null, error: `Tool '${tool_name}' not specifically handled by UtilityAgent logic, though it exists in toolsMap.` };
        }

        if (outcome.error === null) {
          status = "COMPLETED";
        }

      } catch (e) {
        console.error(`UtilityAgent: Error executing tool ${tool_name} for task ${sub_task_id}:`, e);
        outcome = { result: null, error: e.message || "An unexpected error occurred during tool execution." };
      }
    } else {
        console.error(`UtilityAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        // outcome already set to "Unknown tool"
    }

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result,
      error_details: outcome.error ? { message: outcome.error } : null
    };

    console.log(`UtilityAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = UtilityAgent;
