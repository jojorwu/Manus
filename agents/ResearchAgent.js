class ResearchAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // Expected: { "WebSearchTool": webSearchToolInstance, "ReadWebpageTool": readWebpageToolInstance, "AdvancedWebpageReaderTool": advancedToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig;
    this.agentRole = "ResearchAgent";
    this.boundProcessTaskMessage = this.processTaskMessage.bind(this); // Bind for safe use in callbacks
    console.log("INFO: ResearchAgent initialized.");
  }

  startListening() {
    console.log(`INFO: ResearchAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.boundProcessTaskMessage);
  }

  /**
   * Gracefully shuts down the agent by unsubscribing from the SubTaskQueue.
   */
  shutdown() {
    console.log(`INFO: Shutting down ResearchAgent (${this.agentRole})...`);
    if (this.subTaskQueue && this.boundProcessTaskMessage) {
        try {
            this.subTaskQueue.unsubscribe(this.agentRole, this.boundProcessTaskMessage);
            console.log(`INFO: ResearchAgent (${this.agentRole}) unsubscribed from SubTaskQueue.`);
        } catch (error) {
            console.error(`ERROR: ResearchAgent (${this.agentRole}) failed to unsubscribe: ${error.message}`);
        }
    } else {
        console.warn(`WARN: ResearchAgent (${this.agentRole}): SubTaskQueue or boundProcessTaskMessage not available for shutdown.`);
    }
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 65000; // Increased timeout for potentially long Playwright tasks
    console.log(`ResearchAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    // console.log('ResearchAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2)); // Keep commented for production

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = {}; // Will be populated by tool execution or error handling
    let status = "FAILED"; // Default status
    let errorDetails = { // Enhanced error details object
        message: `Unknown tool '${tool_name}' for ResearchAgent or invalid input.`,
        type: "AgentError", // Default type
        toolName: tool_name,
        stack: null
    };

    const selectedTool = this.toolsMap[tool_name];

    if (selectedTool) {
      try {
        let validInput = false;
        let executionPromise = null;
        errorDetails.toolName = tool_name; // Set toolName early

        if (tool_name === "WebSearchTool") {
            if (sub_task_input && typeof sub_task_input.query === 'string' && sub_task_input.query.trim() !== "") {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                errorDetails.message = "Invalid input for WebSearchTool: 'query' string is required and must not be empty.";
                errorDetails.type = "InputValidationError";
            }
        } else if (tool_name === "ReadWebpageTool" || tool_name === "AdvancedWebpageReaderTool") {
            if (sub_task_input && typeof sub_task_input.url === 'string' && sub_task_input.url.trim() !== "") {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                errorDetails.message = `Invalid input for ${tool_name}: 'url' string is required and must not be empty.`;
                errorDetails.type = "InputValidationError";
            }
        } else {
            errorDetails.message = `Tool '${tool_name}' not specifically handled by ResearchAgent's input validation logic, though it exists in toolsMap.`;
            errorDetails.type = "AgentError";
        }

        if (validInput && executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => {
                    const timeoutError = new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`);
                    timeoutError.name = "TimeoutError"; // Custom property to identify timeout
                    reject(timeoutError);
                }, TOOL_EXECUTION_TIMEOUT_MS)
            );

            try {
                outcome = await Promise.race([executionPromise, timeoutPromise]);
            } catch (e) { // This catch block handles errors from Promise.race (e.g. timeoutPromise rejection)
                throw e; // Re-throw to be caught by the outer try-catch
            }
        }

        // Determine status and structure errorDetails based on outcome
        if (validInput) { // Only if input was valid enough to attempt execution
            if (typeof outcome.success === 'boolean') {
                if (outcome.success) {
                    status = "COMPLETED";
                    errorDetails = null; // No error
                } else {
                    // Tool execution failed, outcome should contain error info
                    errorDetails.message = outcome.error || "Tool execution failed without specific error message.";
                    errorDetails.type = "ToolError";
                    // If the tool provides its own 'details' or 'stack', incorporate them
                    if (outcome.details) errorDetails.details = outcome.details;
                    if (outcome.stack) errorDetails.stack = String(outcome.stack).substring(0, 500);
                }
            } else { // Fallback for older tools not returning 'success' boolean
                 if (outcome.error === null || outcome.error === undefined) {
                    status = "COMPLETED";
                    errorDetails = null; // No error
                 } else {
                    // Tool likely returned an error
                    errorDetails.message = outcome.error || "Tool reported an error.";
                    errorDetails.type = "ToolError";
                 }
            }
        }
        // If !validInput, errorDetails is already set by validation checks
        // and status remains "FAILED".

      } catch (e) { // Outer catch for timeouts or unexpected errors during tool interaction
        console.error(`ERROR: ResearchAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        if (e.stack) console.error(e.stack.substring(0,500));

        errorDetails.message = e.message || "An unexpected error occurred.";
        errorDetails.type = e.name === "TimeoutError" ? "TimeoutError" : "AgentError";
        if (e.stack) errorDetails.stack = String(e.stack).substring(0, 500);
      }
    } else { // selectedTool is falsy
        console.error(`ERROR: ResearchAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        // errorDetails is already pre-filled with "Unknown tool..."
        errorDetails.type = "AgentError"; // More specific than InputValidationError
    }

    // Prepare result message
    let resultDataForQueue = null;
    if (status === "COMPLETED") {
        // For tools that return { success: true, ...data }, outcome is the data object.
        // For older tools that return { result: data }, outcome.result is the data.
        resultDataForQueue = (outcome.success !== undefined) ? outcome : outcome.result;
        errorDetails = null; // Explicitly nullify errorDetails on success
    }
    // If status is "FAILED", errorDetails object is already populated.

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: resultDataForQueue, // This will be null if status is FAILED
      error_details: errorDetails // This will be the rich error object or null
    };

    if (status === "COMPLETED") {
        let resultPreview;
        if (typeof resultMessage.result_data === 'string') {
            resultPreview = resultMessage.result_data.substring(0, 100) + (resultMessage.result_data.length > 100 ? "..." : "");
        } else if (resultMessage.result_data && typeof resultMessage.result_data === 'object' && resultMessage.result_data.text) {
            // Handle cases where result_data is an object from AdvancedWebpageReaderTool containing a 'text' property
             resultPreview = `Object with text: ${(resultMessage.result_data.text || "").substring(0,80)}...`;
        } else if (resultMessage.result_data && typeof resultMessage.result_data === 'object') {
            // Generic object preview
            try {
                resultPreview = `Data type: object, JSON preview: ${JSON.stringify(resultMessage.result_data).substring(0, 100)}...`;
            } catch (stringifyError) {
                resultPreview = `Data type: object (non-serializable), Keys: ${Object.keys(resultMessage.result_data).join(', ')}`;
            }
        } else {
            resultPreview = `Data type: ${typeof resultMessage.result_data}`;
        }
        console.log(`INFO: ${this.agentRole} [${sub_task_id}]: Successfully processed task. Sending result to ResultsQueue. Preview: ${resultPreview}`);
    } else {
        // Log existing error details for failed tasks more explicitly if needed, though PlanExecutor also logs them.
        console.log(`INFO: ResearchAgent (${this.agentRole}): Task ${sub_task_id} processing resulted in status ${status}. Error: ${JSON.stringify(errorDetails)}`);
    }
    // The existing log for enqueuing is fine, this new one above gives more context for success.
    // console.log(`INFO: ResearchAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
