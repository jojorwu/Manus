# Manus System API Documentation

## 1. Introduction

The Manus system provides an HTTP API for external clients to submit tasks, control their execution, and receive results. All API requests and responses use the JSON format.

The base URL for the API depends on your server configuration (host and port). If running locally with default settings, it's typically `http://localhost:3000`.

## 2. Task Processing Endpoint

### `POST /api/generate-plan`

This is the primary endpoint for all task-related operations in Manus. It allows for task submission, plan generation, plan execution, and result synthesis based on the specified mode.

*   **URL:** `/api/generate-plan`
*   **Method:** `POST`
*   **Content-Type:** `application/json`

#### Request Body

The request body must be a JSON object with the following fields:

*   **`task`** (string)
    *   Description: The natural language description of the task to be performed.
    *   Required: Yes, for modes `EXECUTE_FULL_PLAN` and `PLAN_ONLY`. Optional for modes that load existing tasks.
    *   Example: `"Research the impact of AI on climate change and summarize the findings."`

*   **`mode`** (string, optional)
    *   Description: Specifies the operational mode for the task.
    *   Default: `"EXECUTE_FULL_PLAN"`
    *   Allowed Values:
        *   `"EXECUTE_FULL_PLAN"`: The system will generate an execution plan (if one doesn't exist for a given `taskIdToLoad` or if no `taskIdToLoad` is provided) and then execute that plan to completion, finally synthesizing an answer.
        *   `"PLAN_ONLY"`: The system will only generate an execution plan for the given `task` and save it. No execution will occur.
        *   `"SYNTHESIZE_ONLY"`: The system will load a previously executed task (specified by `taskIdToLoad`) and attempt to synthesize (or re-synthesize) the final answer based on its `executionContext` and `currentWorkingContext`. The original task definition is loaded from the saved state.
        *   `"EXECUTE_PLANNED_TASK"`: The system will load a previously saved task (specified by `taskIdToLoad`) that already has a plan and execute that plan. The original task definition is loaded from the saved state. `task` in request body is ignored if provided.

*   **`aiService`** (string, optional)
    *   Description: Specifies which AI service provider to use for this task (for planning, LLM steps, synthesis, etc.).
    *   Default: `"openai"`
    *   Allowed Values:
        *   `"openai"`: Uses the OpenAI service (e.g., GPT models). Requires `OPENAI_API_KEY`.
        *   `"gemini"`: Uses the Google Gemini service. Requires `GEMINI_API_KEY`. (Currently uses actual API calls if key is present, otherwise a stub).

*   **`taskIdToLoad`** (string, optional)
    *   Description: The unique ID of a previously processed or saved task. This is used by modes `SYNTHESIZE_ONLY` and `EXECUTE_PLANNED_TASK` to load the state (including plan, execution context, CWC) of that task. For `EXECUTE_FULL_PLAN`, if provided, it might attempt to resume or use context from this loaded task.
    *   Required: Yes, for `SYNTHESIZE_ONLY` and `EXECUTE_PLANNED_TASK`.

#### Example Request Payloads

**Mode: `EXECUTE_FULL_PLAN` (New Task)**
```json
{
  "task": "Write a short blog post about the benefits of server-side rendering.",
  "mode": "EXECUTE_FULL_PLAN",
  "aiService": "openai"
}
```

**Mode: `PLAN_ONLY`**
```json
{
  "task": "Develop a strategy to refactor the user authentication module.",
  "mode": "PLAN_ONLY",
  "aiService": "gemini"
}
```

**Mode: `EXECUTE_PLANNED_TASK` (Assumes task `existing-task-123` with a plan exists)**
```json
{
  "taskIdToLoad": "existing-task-123",
  "mode": "EXECUTE_PLANNED_TASK",
  "aiService": "openai"
}
```

**Mode: `SYNTHESIZE_ONLY` (Assumes task `completed-task-456` exists with execution context)**
```json
{
  "taskIdToLoad": "completed-task-456",
  "mode": "SYNTHESIZE_ONLY",
  "aiService": "openai"
}
```

#### Success Response

*   **Status Code:** `200 OK`
*   **Body (JSON):**
    *   `success` (boolean): Always `true`.
    *   `message` (string): A human-readable message indicating the outcome (e.g., "Task completed and final answer synthesized.", "Plan generated and saved.").
    *   `parentTaskId` (string): The unique ID assigned to this task processing session. This ID can be used later with `taskIdToLoad`.
    *   `originalTask` (string): The original task string provided by the user or loaded from state.
    *   `plan` (array | null): The generated or loaded execution plan. This is an array of stages, where each stage is an array of sub-task objects. `null` if no plan was generated (e.g., error before planning).
    *   `executedPlan` (array | null): The detailed execution context, showing each step taken, its inputs, status, and results. `null` if no execution occurred (e.g., `PLAN_ONLY` mode or planning failure).
    *   `finalAnswer` (string | null): The final synthesized answer for the user. `null` if the mode did not involve synthesis, if synthesis failed, or if no actionable data was produced.
    *   `currentWorkingContext` (object | null): The final state of the Orchestrator's Current Working Context for this task.

**Example Success Response (for `EXECUTE_FULL_PLAN`)**
```json
{
  "success": true,
  "message": "Task completed and final answer synthesized.",
  "parentTaskId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "originalTask": "What is the main purpose of a CPU in a computer? Explain briefly.",
  "plan": [
    [
      { "stepId": "define_cpu", "assigned_agent_role": "Orchestrator", "tool_name": "LLMStepExecutor", "sub_task_input": { /* ... */ }, "narrative_step": "Define CPU."}
    ]
    // ... other stages and steps ...
  ],
  "executedPlan": [
    {
      "stepId": "define_cpu",
      "narrative_step": "Define CPU.",
      "assigned_agent_role": "Orchestrator",
      "tool_name": "LLMStepExecutor",
      "sub_task_input": { /* ... */ },
      "status": "COMPLETED",
      "processed_result_data": "The CPU is the brain of the computer...",
      "raw_result_data": "The CPU is the brain of the computer...",
      "error_details": null,
      "sub_task_id": "c1a2b3d4-..."
    }
    // ... other executed steps ...
  ],
  "finalAnswer": "The main purpose of a CPU (Central Processing Unit) in a computer is to perform most of the calculations which enable the computer to function. It is often referred to as the 'brain' of the computer.",
  "currentWorkingContext": {
    "lastUpdatedAt": "2023-10-27T10:00:00.000Z",
    "summaryOfProgress": "Final synthesis attempt concluded: Task completed and final answer synthesized.",
    "keyFindings": [ /* ... */ ],
    "identifiedEntities": {},
    "pendingQuestions": [],
    "nextObjective": "Task finished.",
    "confidenceScore": 0.95,
    "errorsEncountered": []
  }
}
```

#### Error Responses

*   **Status Code:** `400 Bad Request` (for client-side errors like invalid parameters) or `500 Internal Server Error` (for server-side processing errors).
*   **Body (JSON):**
    *   `success` (boolean): Always `false`.
    *   `message` (string): A general error message (e.g., "Invalid request: 'task' must be a non-empty string...", "Internal server error").
    *   `error` (string, optional): More specific details about the error, if available.
    *   `parentTaskId` (string, optional): The ID of the task, if it was generated before the error occurred. This can be useful for diagnostics.

**Example Error Response (400 Bad Request)**
```json
{
  "success": false,
  "message": "Invalid request: 'task' must be a non-empty string for EXECUTE_FULL_PLAN mode."
}
```

**Example Error Response (500 Internal Server Error)**
```json
{
  "success": false,
  "message": "Internal server error",
  "error": "Failed to generate plan due to LLM service error: API key invalid.",
  "parentTaskId": "a1b2c3d4-e5f6-7890-1234-567890abcdef"
}
```
