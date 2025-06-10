const { v4: uuidv4 } = require('uuid'); // For generating unique sub_task_ids

class OrchestratorAgent {
  constructor(subTaskQueue, resultsQueue, llmService, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.llmService = llmService; // e.g., callGemini function, not used for planning in this phase
    this.agentApiKeysConfig = agentApiKeysConfig; // To store API keys if Orchestrator needs its own
    console.log("OrchestratorAgent initialized.");
  }

  async handleUserTask(userTaskString, parentTaskId) {
    console.log(`OrchestratorAgent: Received task '${userTaskString}' with parentTaskId: ${parentTaskId}`);

    // For Phase 1 of Multi-Agent: No LLM planning.
    // Create one hardcoded sub-task for UtilityAgent to use CalculatorTool.
    const subTaskId = uuidv4();
    const hardcodedSubTask = {
      sub_task_id: subTaskId,
      parent_task_id: parentTaskId,
      assigned_agent_role: "UtilityAgent", // Target role
      tool_name: "CalculatorTool",
      sub_task_input: { expression: "5 + 7" }, // Example calculation
      context_summary: null, // No prior context for this simple task
      api_keys_config_ref: null // Not using specific key profiles for UtilityAgent yet
    };

    console.log(`OrchestratorAgent: Enqueuing hardcoded sub-task ID ${subTaskId} for UtilityAgent.`);
    this.subTaskQueue.enqueueTask(hardcodedSubTask);

    // Await the result for this specific sub-task using subscribeOnce from ResultsQueue
    // The ResultsQueue's subscribeOnce was enhanced to take an optional sub_task_id.
    return new Promise((resolve, reject) => {
      this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMessage) => {
        if (error) {
          console.error(`OrchestratorAgent: Error or timeout waiting for result of parent_task_id ${parentTaskId}, sub_task_id ${subTaskId}:`, error.message);
          // For now, resolve with an error structure. The API handler can decide on HTTP status.
          resolve({
            success: false,
            message: `Error processing sub-task ${subTaskId}: ${error.message}`,
            originalTask: userTaskString,
            results: null
          });
          return;
        }

        if (resultMessage && resultMessage.sub_task_id === subTaskId) {
          console.log(`OrchestratorAgent: Received result for sub_task_id ${subTaskId}:`, resultMessage);
          // In a real scenario, would aggregate results. For now, just return this one.
          resolve({
            success: resultMessage.status === "COMPLETED",
            message: resultMessage.status === "COMPLETED" ? "Task processed." : `Sub-task ${subTaskId} failed.`,
            originalTask: userTaskString,
            results: [resultMessage] // Package the single result
          });
        } else if (resultMessage) {
          // This case should ideally not happen if sub_task_id matching is robust in ResultsQueue for subscribeOnce
          console.warn(`OrchestratorAgent: Received result for parent_task_id ${parentTaskId}, but sub_task_id mismatch. Expected ${subTaskId}, got ${resultMessage.sub_task_id}. Re-queueing and continuing to wait.`);
          // Re-enqueue if it's not ours and wasn't a timeout. This is a simplistic handling.
          // A more robust system would have better correlation or a way for Orchestrator to manage multiple expected sub-tasks.
          this.resultsQueue.enqueueResult(resultMessage);
          // Note: This doesn't re-subscribe here, relies on the initial subscribeOnce timeout.
          // For this phase, we expect only one sub-task, so a mismatch is less likely if sub_task_id is used by subscribeOnce.
        }
        // If no error and no resultMessage, the timeout in subscribeOnce should handle it.
      }, subTaskId /* Pass subTaskId to subscribeOnce */ ); // Wait for this specific sub-task
    });
  }
}

module.exports = OrchestratorAgent;
