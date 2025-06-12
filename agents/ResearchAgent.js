class ResearchAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig, timeoutMs = 30000) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // Expected: { "WebSearchTool": webSearchToolInstance, "ReadWebpageTool": readWebpageToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig; // For future tools that might need agent-specific keys
    this.agentRole = "ResearchAgent";
    this.toolExecutionTimeoutMs = timeoutMs;
    this.supportedTools = ["WebSearchTool", "ReadWebpageTool"];
    console.log("ResearchAgent initialized.");
  }

  startListening() {
    console.log(`ResearchAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
  }

  _getTool(toolName) {
    const selectedTool = this.toolsMap[toolName];
    if (!selectedTool) {
      return { tool: null, error: { category: "TOOL_NOT_FOUND", message: `Tool '${toolName}' not found in ResearchAgent's toolsMap.` } };
    }
    return { tool: selectedTool, error: null };
  }

  _isToolSupported(toolName) {
    return this.supportedTools.includes(toolName);
  }

  async _executeToolWithTimeout(tool, subTaskInput, toolName) {
    const executionPromise = tool.execute(subTaskInput);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool '${toolName}' execution timed out after ${this.toolExecutionTimeoutMs}ms`)), this.toolExecutionTimeoutMs)
    );
    // This will either resolve with the tool's outcome or reject with the timeout error (or other tool execution error)
    return Promise.race([executionPromise, timeoutPromise]);
  }

  _prepareOutcomeForQueue(rawOutcome, toolName, preExistingError = null) {
    let finalOutcome = { result: null, error: null };

    if (preExistingError) { // Errors identified before tool execution (e.g. not found, not supported)
        finalOutcome.error = preExistingError;
        return finalOutcome;
    }

    if (rawOutcome && rawOutcome.error === null) { // Successful tool execution
        finalOutcome.result = rawOutcome.result;
        return finalOutcome;
    }

    // Handle errors from tool execution or unexpected structures
    if (rawOutcome && rawOutcome.error) { // Tool returned a structured error
        finalOutcome.error = rawOutcome.error;
    } else if (rawOutcome && !rawOutcome.error) { // Tool returned something, but error field is missing/falsey (e.g. a string error)
        finalOutcome.error = { category: "AGENT_INTERNAL_ERROR", message: `Tool '${toolName}' execution failed or returned an invalid error structure. Received: ${JSON.stringify(rawOutcome)}` };
    } else { // rawOutcome is null or undefined
        finalOutcome.error = { category: "AGENT_INTERNAL_ERROR", message: `Outcome object was null or undefined after tool '${toolName}' execution.` };
    }
    return finalOutcome;
  }

  _enqueueTaskResult(taskDetails, status, outcome) {
    const { sub_task_id, parent_task_id } = taskDetails;
    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result,
      error_details: outcome.error,
    };
    console.log(`ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }

  async processTaskMessage(taskMessage) {
    console.log(`ResearchAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    console.log('ResearchAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2));

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = { result: null, error: null }; // Default outcome
    let status = "FAILED"; // Default status

    const toolCheck = this._getTool(tool_name);
    if (toolCheck.error) {
        outcome = this._prepareOutcomeForQueue(null, tool_name, toolCheck.error);
        status = "FAILED";
        this._enqueueTaskResult({ sub_task_id, parent_task_id }, status, outcome);
        return;
    }
    const selectedTool = toolCheck.tool;

    if (!this._isToolSupported(tool_name)) {
        const unsupportedError = { category: "UNSUPPORTED_TOOL", message: `Tool '${tool_name}' is present but not explicitly supported by ResearchAgent's current logic.` };
        outcome = this._prepareOutcomeForQueue(null, tool_name, unsupportedError);
        status = "FAILED";
        this._enqueueTaskResult({ sub_task_id, parent_task_id }, status, outcome);
        return;
    }

    try {
        const rawOutcomeFromExecution = await this._executeToolWithTimeout(selectedTool, sub_task_input, tool_name);
        outcome = this._prepareOutcomeForQueue(rawOutcomeFromExecution, tool_name);
    } catch (e) { // Catches rejections from _executeToolWithTimeout (timeout or other unexpected errors)
        console.error(`ResearchAgent: Unhandled error during tool execution or timeout for tool ${tool_name} [task ${sub_task_id}]:`, e.message);
        let errorPayload;
        if (e.message && e.message.toLowerCase().includes("timed out")) {
            errorPayload = { category: "TOOL_TIMEOUT", message: e.message, details: { originalError: e.toString() } };
        } else {
            errorPayload = { category: "AGENT_INTERNAL_ERROR", message: e.message || `An unexpected error occurred in ResearchAgent while executing ${tool_name}.`, details: { originalError: e.toString() } };
        }
        outcome = this._prepareOutcomeForQueue(null, tool_name, errorPayload); // Ensure result is null
    }

    status = (outcome.error === null) ? "COMPLETED" : "FAILED";
    this._enqueueTaskResult({ sub_task_id, parent_task_id }, status, outcome);
  }
}

module.exports = ResearchAgent;
