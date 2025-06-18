const { t } = require('../utils/localization');

class ResearchAgent {
  constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.toolsMap = toolsMap; // Expected: { "WebSearchTool": webSearchToolInstance, "ReadWebpageTool": readWebpageToolInstance }
    this.agentApiKeysConfig = agentApiKeysConfig; // For future tools that might need agent-specific keys
    this.agentRole = "ResearchAgent";
    console.log(t('INIT_DONE', { componentName: 'ResearchAgent' }));
  }

  startListening() {
    console.log(t('AGENT_LISTENING', { agentName: 'ResearchAgent', agentRole: this.agentRole }));
    this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
  }

  async processTaskMessage(taskMessage) {
    const TOOL_EXECUTION_TIMEOUT_MS = 30000; // 30 секунд
    console.log(t('AGENT_RECEIVED_TASK', { agentName: 'ResearchAgent', agentRole: this.agentRole, subTaskId: taskMessage.sub_task_id, toolName: taskMessage.tool_name }));
    console.log(t('AGENT_FULL_TASK_MSG', { agentName: 'ResearchAgent', taskMessage: JSON.stringify(taskMessage, null, 2) }));

    const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
    // Note: Error messages returned in 'outcome.error' are already localized from previous subtasks.
    // The t() function here is for console logging, not for the returned error strings.
    let outcome = { result: null, error: t('UNKNOWN_TOOL_ERROR', { toolName: tool_name, agentName: 'ResearchAgent' }) }; // Assuming UNKNOWN_TOOL_ERROR is a key for the *returned* error
    // However, the instruction was "Error messages that are *returned* by functions ... should remain as they are".
    // So, the Russian string directly is correct as per previous subtasks.
    // The console logs related to these errors will use t().
    outcome = { result: null, error: `ResearchAgent: Неизвестный инструмент '${tool_name}' или неверные входные данные.` };
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
                outcome = { result: null, error: "ResearchAgent: Неверный ввод для WebSearchTool: требуется строковый параметр 'query'." };
            }
        } else if (tool_name === "ReadWebpageTool") {
            if (sub_task_input && typeof sub_task_input.url === 'string') {
                validInput = true;
                executionPromise = selectedTool.execute(sub_task_input);
            } else {
                outcome = { result: null, error: "ResearchAgent: Неверный ввод для ReadWebpageTool: требуется строковый параметр 'url'." };
            }
        } else {
            // This case should ideally not be hit if Orchestrator assigns valid tools
            outcome = { result: null, error: `ResearchAgent: Инструмент '${tool_name}' существует в toolsMap, но не обрабатывается специальной логикой ResearchAgent.` };
        }

        if (validInput && executionPromise) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`ResearchAgent: Время выполнения инструмента '${tool_name}' истекло через ${TOOL_EXECUTION_TIMEOUT_MS}мс.`)), TOOL_EXECUTION_TIMEOUT_MS)
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
        console.error(t('AGENT_EXEC_TIMEOUT', { agentName: 'ResearchAgent', toolName: tool_name, subTaskId: sub_task_id, errorMessage: e.message }), e);
        // Ensure outcome reflects the error from the catch block
        // The error message from timeoutPromise is already translated.
        // If e.message is from another source, it might not be.
        const errorMessage = e.message || `ResearchAgent: Произошла непредвиденная ошибка во время выполнения инструмента или таймаута.`; // This is a returned error, should be Russian.
        outcome = { result: null, error: errorMessage };
        // status remains "FAILED" (as initialized)
      }
    } else {
        console.error(t('AGENT_TOOL_NOT_FOUND', { agentName: 'ResearchAgent', toolName: tool_name, subTaskId: sub_task_id }));
        // outcome is already set to the Russian version of "Unknown tool..."
    }

    const resultMessage = {
      sub_task_id: sub_task_id,
      parent_task_id: parent_task_id,
      worker_agent_role: this.agentRole,
      status: status,
      result_data: outcome.result, // This will be null if there was an error
      error_details: outcome.error ? { message: outcome.error } : null // outcome.error is now in Russian if set by agent
    };

    console.log(t('AGENT_ENQUEUING_RESULT', { agentName: 'ResearchAgent', agentRole: this.agentRole, subTaskId: sub_task_id, status: status }));
    this.resultsQueue.enqueueResult(resultMessage);
  }
}

module.exports = ResearchAgent;
