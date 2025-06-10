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
    console.log(`ResearchAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { result: null, error: `Unknown tool '${tool_name}' for ResearchAgent or invalid input.` };
    let status = "FAILED";

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        let validInput = false;
        if (tool_name === "WebSearchTool") {
          if (sub_task_input && typeof sub_task_input.query === 'string') {
            validInput = true;
            outcome = await selectedTool.execute(sub_task_input); // { query: "..." }
          } else {
            outcome = { result: null, error: "Invalid input for WebSearchTool: 'query' string is required." };
          }
        } else if (tool_name === "ReadWebpageTool") {
          if (sub_task_input && typeof sub_task_input.url === 'string') {
            validInput = true;
            outcome = await selectedTool.execute(sub_task_input); // { url: "..." }
          } else {
            outcome = { result: null, error: "Invalid input for ReadWebpageTool: 'url' string is required." };
          }
        } else {
             outcome = { result: null, error: `Tool '${tool_name}' not specifically handled by ResearchAgent logic, though it exists in toolsMap.` };
        }

        if (validInput && outcome.error === null) {
          status = "COMPLETED";
        }

      } catch (e) {
        console.error(`ResearchAgent: Error executing tool ${tool_name} for task ${sub_task_id}:`, e);
        outcome = { result: null, error: e.message || "An unexpected error occurred during tool execution." };
      }
    } else {
        console.error(`ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
    }

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result,
      error_details: outcome.error ? { message: outcome.error } : null
    };

    console.log(`ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
