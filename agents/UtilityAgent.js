class UtilityAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // e.g., { "CalculatorTool": calculatorToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig; // For future tools that might need keys
    this.agentRole = "UtilityAgent";
    this.boundProcessTaskMessage = this.processTaskMessage.bind(this); // Bind for safe use in callbacks
    console.log("INFO: UtilityAgent initialized.");
  }

  startListening() {
    console.log(`INFO: UtilityAgent (${this.agentRole}) starting to listen for tasks...`);
    this.subTaskQueue.subscribe(this.agentRole, this.boundProcessTaskMessage);
  }

  /**
   * Gracefully shuts down the agent by unsubscribing from the SubTaskQueue.
   */
  shutdown() {
    console.log(`INFO: Shutting down UtilityAgent (${this.agentRole})...`);
    if (this.subTaskQueue && this.boundProcessTaskMessage) {
        try {
            this.subTaskQueue.unsubscribe(this.agentRole, this.boundProcessTaskMessage);
            console.log(`INFO: UtilityAgent (${this.agentRole}) unsubscribed from SubTaskQueue.`);
        } catch (error) {
            console.error(`ERROR: UtilityAgent (${this.agentRole}) failed to unsubscribe: ${error.message}`);
        }
    } else {
        console.warn(`WARN: UtilityAgent (${this.agentRole}): SubTaskQueue or boundProcessTaskMessage not available for shutdown.`);
    }
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 30000; // 30 секунд
    console.log(`UtilityAgent (${this.agentRole}): Received task ID ${taskMessage.sub_task_id}, tool: ${taskMessage.tool_name}`);
    // console.log('UtilityAgent: Full taskMessage received:', JSON.stringify(taskMessage, null, 2)); // Keep commented for production

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    let outcome = {}; // Will be populated by tool execution or error handling
    let status = "FAILED"; // Default status
    let errorDetails = { // Enhanced error details object
        message: `Unknown tool '${tool_name}' for UtilityAgent.`,
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

        if (tool_name === "CalculatorTool") {
            if (sub_task_input && typeof sub_task_input.expression === 'string') {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input); // CalculatorTool is expected to be synchronous
            } else {
                errorDetails.message = "Invalid input for CalculatorTool: 'expression' string is required.";
                errorDetails.type = "InputValidationError";
            }
        }
        // Future: else if (tool_name === "AnotherUtilityTool") { ... validate and set executionPromise ... }
        else {
            errorDetails.message = `Tool '${tool_name}' not specifically handled by UtilityAgent logic, though it exists in toolsMap.`;
            errorDetails.type = "AgentError";
        }

        if (validInput && executionPromise) {
            // Handle synchronous tools like CalculatorTool directly
            if (typeof executionPromise.then !== 'function') { // Check if it's not a Promise
                outcome = executionPromise; // Assume direct result for sync tools
            } else { // For async tools (if any added to UtilityAgent in future)
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => {
                        const timeoutError = new Error(`Tool '${tool_name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`);
                        timeoutError.name = "TimeoutError";
                        reject(timeoutError);
                    }, TOOL_EXECUTION_TIMEOUT_MS)
                );
                try {
                    outcome = await Promise.race([executionPromise, timeoutPromise]);
                } catch (e) {
                    throw e; // Re-throw to be caught by the outer try-catch
                }
            }
        }
        // If !validInput, errorDetails is already set, status remains "FAILED".

        // Determine status and structure errorDetails based on outcome
        if (validInput) {
            // For CalculatorTool and similar simple tools, outcome is expected to be { result: ..., error: ... }
            // or for future tools { success: boolean, ... }
            if (outcome.success === true || (outcome.success === undefined && outcome.error === null)) {
                status = "COMPLETED";
                errorDetails = null; // No error
            } else {
                // Tool execution failed or returned an error
                errorDetails.message = outcome.error || "Tool execution failed without specific error message.";
                errorDetails.type = "ToolError";
                if (outcome.details) errorDetails.details = outcome.details;
                // Stack might not be relevant for simple utility tools, but can be added if outcome provides it
            }
        }
        // If !validInput, errorDetails is already set, status remains "FAILED".

      } catch (e) { // This catch handles timeouts for async tools or other unexpected errors.
        console.error(`ERROR: UtilityAgent: Error executing or timeout for tool ${tool_name} for task ${sub_task_id}:`, e.message);
        if(e.stack) console.error(e.stack.substring(0,500));

        errorDetails.message = e.message || "An unexpected error occurred.";
        errorDetails.type = e.name === "TimeoutError" ? "TimeoutError" : "AgentError";
        if (e.stack) errorDetails.stack = String(e.stack).substring(0, 500);
      }
    } else { // selectedTool is falsy
        console.error(`ERROR: UtilityAgent: Tool '${tool_name}' not found in toolsMap for task ${sub_task_id}.`);
        // errorDetails is already pre-filled with "Unknown tool..."
        errorDetails.type = "AgentError";
    }

    // Prepare result message
    let resultDataForQueue = null;
    if (status === "COMPLETED") {
        // Standardize access to result data
        resultDataForQueue = outcome.success !== undefined ? outcome : outcome.result;
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
        } else if (resultMessage.result_data && typeof resultMessage.result_data === 'object') {
            // Generic object preview, common for UtilityAgent if tools return structured data (though Calculator returns string now)
            try {
                resultPreview = `Data type: object, JSON preview: ${JSON.stringify(resultMessage.result_data).substring(0, 100)}...`;
            } catch (stringifyError) {
                resultPreview = `Data type: object (non-serializable), Keys: ${Object.keys(resultMessage.result_data).join(', ')}`;
            }
        } else {
             // Fallback for numbers, booleans, or other primitive types that CalculatorTool might return directly
            resultPreview = `Data: ${String(resultMessage.result_data).substring(0,100)}`;
        }
        console.log(`INFO: ${this.agentRole} [${sub_task_id}]: Successfully processed task. Sending result to ResultsQueue. Preview: ${resultPreview}`);
    } else {
        console.log(`INFO: UtilityAgent (${this.agentRole}): Task ${sub_task_id} processing resulted in status ${status}. Error: ${JSON.stringify(errorDetails)}`);
    }
    // The existing log for enqueuing is fine, this new one above gives more context for success.
    // console.log(`INFO: UtilityAgent (${this.agentRole}): Enqueuing result for sub_task_id ${sub_task_id}. Status: ${status}`);
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = UtilityAgent;
