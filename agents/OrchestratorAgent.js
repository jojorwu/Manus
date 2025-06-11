const { v4: uuidv4 } = require('uuid'); // For generating unique sub_task_ids

// Helper function to parse and validate the LLM's plan response
async function parseSubTaskPlanResponse(jsonStringResponse, knownAgentRoles, knownToolsByRole) {
  let cleanedString = jsonStringResponse;
  if (typeof jsonStringResponse !== 'string') {
    // If the LLM service itself returned an error object/non-string
    return { success: false, message: "LLM did not return a string response for the plan.", details: String(jsonStringResponse), subTasks: [] };
  }

  try {
    // Remove markdown ```json ... ``` wrapper if present
    if (cleanedString.startsWith('```json')) {
      cleanedString = cleanedString.substring(7);
      if (cleanedString.endsWith('```')) {
        cleanedString = cleanedString.slice(0, -3);
      }
    }
    cleanedString = cleanedString.trim();

    const parsedArray = JSON.parse(cleanedString);

    if (!Array.isArray(parsedArray)) {
      return { success: false, message: "LLM plan is not a JSON array.", rawResponse: cleanedString, subTasks: [] };
    }
    if (parsedArray.length === 0) {
      return { success: false, message: "LLM plan is empty.", rawResponse: cleanedString, subTasks: [] };
    }

    for (const subTask of parsedArray) {
      if (typeof subTask !== 'object' || subTask === null) {
        return { success: false, message: "Invalid sub-task structure: not an object.", rawResponse: cleanedString, subTasks: [] };
      }
      if (!subTask.assigned_agent_role || typeof subTask.assigned_agent_role !== 'string' || !knownAgentRoles.includes(subTask.assigned_agent_role)) {
        return { success: false, message: `Invalid or unknown 'assigned_agent_role': ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, subTasks: [] };
      }
      if (!subTask.tool_name || typeof subTask.tool_name !== 'string' || !(knownToolsByRole[subTask.assigned_agent_role] && knownToolsByRole[subTask.assigned_agent_role].includes(subTask.tool_name))) {
        return { success: false, message: `Invalid or unknown 'tool_name': ${subTask.tool_name} for role ${subTask.assigned_agent_role}.`, rawResponse: cleanedString, subTasks: [] };
      }
      if (typeof subTask.sub_task_input !== 'object' || subTask.sub_task_input === null) {
        // Allow empty object for tools that might not need input, but must be an object
        return { success: false, message: "Invalid 'sub_task_input': must be an object.", rawResponse: cleanedString, subTasks: [] };
      }
      if (!subTask.narrative_step || typeof subTask.narrative_step !== 'string' || !subTask.narrative_step.trim()) {
        return { success: false, message: "Missing or empty 'narrative_step'.", rawResponse: cleanedString, subTasks: [] };
      }
    }
    return { success: true, subTasks: parsedArray };
  } catch (e) {
    console.error("Error parsing sub-task plan JSON:", e.message, "Raw response:", cleanedString);
    return { success: false, message: "Failed to parse LLM plan: " + e.message, rawResponse: cleanedString, subTasks: [] };
  }
}


class OrchestratorAgent {
  constructor(subTaskQueue, resultsQueue, llmService, agentApiKeysConfig) {
    this.subTaskQueue = subTaskQueue;
    this.resultsQueue = resultsQueue;
    this.llmService = llmService;
    this.agentApiKeysConfig = agentApiKeysConfig;

    this.workerAgentCapabilities = [
      {
        role: "ResearchAgent",
        description: "Specialized in finding and retrieving information from the web. Can perform web searches and read content from specific URLs.",
        tools: [
          { name: "WebSearchTool", description: "Performs a web search for a given query. Input format: { \"query\": \"search terms\" }" },
          { name: "ReadWebpageTool", description: "Fetches and extracts textual content from a given URL. Input format: { \"url\": \"http://example.com\" }" }
        ]
      },
      {
        role: "UtilityAgent",
        description: "Specialized in performing calculations and other specific utility tasks.",
        tools: [
          { name: "CalculatorTool", description: "Evaluates mathematical expressions. Input format: { \"expression\": \"2 * (3 + 4)\" }" }
        ]
      }
      // Future: Add more agent role descriptions here
    ];
    console.log("OrchestratorAgent initialized with worker capabilities.");
  }

  async handleUserTask(userTaskString, parentTaskId) {
    console.log(`OrchestratorAgent: Received task '${userTaskString}' with parentTaskId: ${parentTaskId}`);

    let formattedAgentCapabilitiesString = "You have the following specialized agents available:\n";
    const knownAgentRoles = [];
    const knownToolsByRole = {};

    this.workerAgentCapabilities.forEach(agent => {
      knownAgentRoles.push(agent.role);
      knownToolsByRole[agent.role] = agent.tools.map(t => t.name);
      formattedAgentCapabilitiesString += "---\n";
      formattedAgentCapabilitiesString += `Agent Role: ${agent.role}\n`;
      formattedAgentCapabilitiesString += `Description: ${agent.description}\n`;
      formattedAgentCapabilitiesString += `Tools:\n`;
      agent.tools.forEach(tool => {
        formattedAgentCapabilitiesString += `  - ${tool.name}: ${tool.description}\n`;
      });
    });
    formattedAgentCapabilitiesString += "---\n(End of available agents list)\n";

    const planningPrompt = `User task: '${userTaskString}'.
Available agent capabilities:
${formattedAgentCapabilitiesString}
Based on the user task and available agents, create a sequential plan consisting of sub-tasks to achieve the user's goal.
Your output MUST be a JSON array of sub-task objects. Each object in the array must have the following keys:
1. 'assigned_agent_role': String (must be one of [${knownAgentRoles.map(r => `"${r}"`).join(", ")}]).
2. 'tool_name': String (must be a tool available to the assigned agent, as listed in its capabilities).
3. 'sub_task_input': Object (the input for the specified tool, matching its described input format).
4. 'narrative_step': String (a short, human-readable description of this step's purpose in the context of the overall user task).
Example of a sub-task object for a ResearchAgent using WebSearchTool:
{ "assigned_agent_role": "ResearchAgent", "tool_name": "WebSearchTool", "sub_task_input": { "query": "history of AI" }, "narrative_step": "Search for the history of AI." }
Produce ONLY the JSON array of sub-tasks. Do not include any other text before or after the JSON array.`;

    console.log("OrchestratorAgent: Planning Prompt being sent to LLM:", planningPrompt);
    let planJsonString;
    try {
      planJsonString = await this.llmService(planningPrompt); // callGemini
    } catch (llmError) {
      console.error("OrchestratorAgent: Error from LLM service during planning:", llmError.message);
      return { success: false, message: `Failed to generate plan: ${llmError.message}`, originalTask: userTaskString, executedPlan: [] };
    }

    const parsedPlanResult = await parseSubTaskPlanResponse(planJsonString, knownAgentRoles, knownToolsByRole);

    if (!parsedPlanResult.success) {
      console.error("OrchestratorAgent: Failed to parse LLM plan:", parsedPlanResult.message, parsedPlanResult.details);
      return { success: false, message: `Failed to parse generated plan: ${parsedPlanResult.message}`, details: parsedPlanResult.details, originalTask: userTaskString, executedPlan: [], rawResponse: parsedPlanResult.rawResponse };
    }

    const subTasks = parsedPlanResult.subTasks;

    console.log(`OrchestratorAgent: Parsed plan with ${subTasks.length} sub-tasks.`);

    const allSubTaskResults = [];
    let overallSuccess = true;

    for (const subTaskDefinition of subTasks) {
      const sub_task_id = uuidv4();
      const taskMessage = {
        sub_task_id: sub_task_id,
        parent_task_id: parentTaskId,
        assigned_agent_role: subTaskDefinition.assigned_agent_role,
        tool_name: subTaskDefinition.tool_name,
        sub_task_input: subTaskDefinition.sub_task_input,
        narrative_step: subTaskDefinition.narrative_step,
        // context_summary: null, // Context will be handled by a different system later if needed per sub-task
        // api_keys_config_ref: null
      };

      this.subTaskQueue.enqueueTask(taskMessage);
      console.log(`Orchestrator: Dispatched sub-task ${sub_task_id} for role ${taskMessage.assigned_agent_role} - Step: "${taskMessage.narrative_step}"`);

      const stepResultOutcome = await new Promise((resolve) => {
        this.resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
          if (error) {
            console.error(`Orchestrator: Error or timeout waiting for result of sub_task_id ${sub_task_id}:`, error.message);
            resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: "FAILED", error_details: { message: error.message } });
          } else if (resultMsg) {
             // Ensure we only process the result for the specific sub_task_id we are waiting for
            if (resultMsg.sub_task_id === sub_task_id) {
                console.log(`Orchestrator: Received result for sub_task_id ${sub_task_id}. Status: ${resultMsg.status}`);
                resolve({ sub_task_id, narrative_step: taskMessage.narrative_step, tool_name: taskMessage.tool_name, assigned_agent_role: taskMessage.assigned_agent_role, status: resultMsg.status, result_data: resultMsg.result_data, error_details: resultMsg.error_details });
            } else {
                // This case should ideally not occur if ResultsQueue.subscribeOnce filters correctly.
                // Receiving a result for a different sub_task_id than expected by this specific subscriber
                // is an anomaly. Instead of re-queueing (which could lead to loops),
                // we'll treat it as an error for this step.
                const errorMessage = `Orchestrator: Critical - Received mismatched sub_task_id. Expected ${sub_task_id}, but got ${resultMsg.sub_task_id} for parent_task_id ${parentTaskId}. This indicates an issue with result routing or subscription logic.`;
                console.error(errorMessage);
                // Убедимся, что taskMessage доступна в этой области
                // const currentTaskMessage = taskMessage; // Если taskMessage переопределяется, но она должна быть из for loop
                resolve({
                    sub_task_id: sub_task_id, // Используем ожидаемый sub_task_id, так как для него ошибка
                    narrative_step: taskMessage.narrative_step,
                    tool_name: taskMessage.tool_name,
                    assigned_agent_role: taskMessage.assigned_agent_role,
                    status: "FAILED",
                    error_details: { message: "Mismatched sub_task_id in result processing.", details: errorMessage }
                });
            }
          }
        }, sub_task_id); // Subscribe specifically for this sub_task_id
      });

      allSubTaskResults.push(stepResultOutcome);

      if (stepResultOutcome.status === "FAILED") {
        console.error(`Orchestrator: Sub-task ${sub_task_id} ("${stepResultOutcome.narrative_step}") failed. Halting further sub-task dispatches for this parent task.`);
        overallSuccess = false;
        break;
      }
    }

    console.log(`OrchestratorAgent: Finished processing all sub-tasks for parentTaskId: ${parentTaskId}. Overall success: ${overallSuccess}`);

    let finalOrchestratorResponse = {
      success: overallSuccess,
      message: "", // Will be set based on synthesis outcome
      originalTask: userTaskString,
      plan: subTasks.map(st => ({
        narrative_step: st.narrative_step,
        assigned_agent_role: st.assigned_agent_role,
        tool_name: st.tool_name,
        sub_task_input: st.sub_task_input
      })),
      executedPlan: allSubTaskResults,
      finalAnswer: null
    };

    if (overallSuccess && allSubTaskResults.length > 0) {
      let synthesisContext = "";
      allSubTaskResults.forEach(res => {
        if (res.status === "COMPLETED" && res.result_data) {
          synthesisContext += `Step: ${res.narrative_step || res.tool_name}\nResult: ${res.result_data}\n---\n`;
        } else if (res.status === "COMPLETED" && !res.result_data) {
          synthesisContext += `Step: ${res.narrative_step || res.tool_name}\nAction completed (no specific data returned).\n---\n`;
        }
        // Optionally, could include failed steps in context for synthesis if desired, but typically focus on successes.
      });

      if (synthesisContext.trim() === "") {
        console.log("OrchestratorAgent: No successful results with data to synthesize. Skipping synthesis.");
        finalOrchestratorResponse.message = "All sub-tasks completed, but no specific data to synthesize for a final answer.";
        finalOrchestratorResponse.finalAnswer = "No specific data was gathered to form a final answer, but all steps completed.";
      } else {
        const synthesisPrompt = `Original user task: '${userTaskString}'.
The following are the results from executed sub-tasks:
---
${synthesisContext.trim()}
---
Based on the original user task and the results from the executed sub-tasks, provide a comprehensive and coherent final answer to the user. Integrate the information smoothly. If some steps yielded no specific data but were just actions, acknowledge them if relevant to the narrative.`;

        console.log("OrchestratorAgent: Attempting final synthesis with prompt:", synthesisPrompt);
        try {
          const synthesizedAnswer = await this.llmService(synthesisPrompt); // callGemini
          finalOrchestratorResponse.finalAnswer = synthesizedAnswer;
          finalOrchestratorResponse.message = "Task completed and final answer synthesized.";
          console.log("OrchestratorAgent: Final answer synthesized successfully.");
        } catch (synthError) {
          console.error("OrchestratorAgent: Error during final answer synthesis:", synthError.message);
          finalOrchestratorResponse.finalAnswer = "Error during final answer synthesis: " + synthError.message;
          finalOrchestratorResponse.message = "Sub-tasks completed, but final answer synthesis failed.";
          // Keep success: true as sub-tasks did complete, but synthesis is an add-on.
          // Alternatively, could set success: false here if synthesis is critical.
        }
      }
    } else if (!overallSuccess) {
      finalOrchestratorResponse.message = "One or more sub-tasks failed. Unable to provide a final synthesized answer.";
    } else { // overallSuccess is true but allSubTaskResults is empty (shouldn't happen if plan was not empty)
      finalOrchestratorResponse.message = "No sub-tasks were executed, though the process was marked successful.";
    }

    return finalOrchestratorResponse;
  }
}

module.exports = OrchestratorAgent;
