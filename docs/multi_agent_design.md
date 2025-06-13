# Conceptual Design Document: Multi-Agent System

## 1. Overview

This document outlines the conceptual design for transitioning the current AI agent into a multi-agent system. This system will feature specialized agents, an orchestrator to manage tasks, inter-agent communication via task queues, and support for multiple API key configurations. The design draws inspiration from advanced agent frameworks like CAMEL/Owl and aims to enhance the agent's universality and task-handling capabilities within our existing Node.js environment.

## 2. Core Agent Roles and Responsibilities

We will define the following initial agent roles:

*   **`OrchestratorAgent`**
    *   **Primary Functions:**
        *   Acts as the high-level coordinator for user tasks. Receives tasks via the API.
        *   **Planning and Replanning Management:**
            *   Utilizes the `PlanManager` component to generate initial execution plans and, if necessary, to revise plans after execution failures.
            *   For initial planning, `PlanManager` is invoked to create a plan based on templates or LLM generation.
            *   If a plan execution attempt fails, `OrchestratorAgent` initiates a replanning cycle (up to `MAX_REVISIONS` attempts). It calls `PlanManager.getPlan` with `isRevision: true`, providing rich context: the original task, current working context (CWC), the execution context of the failed attempt, details of the failed step (`failedStepDetails` from `PlanExecutor`), and the plan that failed.
        *   **Execution Cycle Management:**
            *   Manages an iterative execution loop. For each attempt (initial or revised plan):
                *   It calls `PlanExecutor.executePlan` with the current plan to be attempted.
                *   If execution is successful, the loop terminates.
                *   If execution fails:
                    *   It retrieves `failedStepDetails` from `PlanExecutor`'s result.
                    *   If `MAX_REVISIONS` is not reached, it triggers the replanning process described above.
                    *   If `MAX_REVISIONS` is reached, or if replanning itself fails to produce a new valid plan, the task is marked as definitively failed.
        *   **Delegation to `PlanExecutor`:** `PlanExecutor` is responsible for the actual step-by-step execution of a given plan, including:
            *   Iterating through plan stages and steps.
            *   Dispatching tasks to worker agents or handling Orchestrator-level special actions (`ExploreSearchResults`, `GeminiStepExecutor`, `FileSystemTool`, `FileDownloaderTool`).
            *   Summarizing step data and collecting `keyFindings` and `errorsEncountered` for the CWC.
            *   Returning `failedStepDetails` if a step causes the plan execution to fail.
            *   Potentially returning a pre-synthesized `finalAnswer`.
        *   **Final Response Synthesis:** After the execution/replanning cycle concludes:
            *   If a `finalAnswer` was pre-synthesized by `PlanExecutor` during the last successful attempt, `OrchestratorAgent` uses it.
            *   Otherwise, if the overall task was successful, it synthesizes a final response using the `executionContext` (from the last successful attempt) and the final `CurrentWorkingContext`.
            *   If the overall task failed, the synthesis process explains the failure.
        *   **State Management & Journaling:**
            *   Manages the overall task state, `CurrentWorkingContext` (updated across all attempts), and the `TaskJournal`.
            *   The `TaskJournal` now includes entries related to execution attempts, replanning starts/successes/failures, and max revision limits being reached.
        *   Handles overall error management, reflecting the outcome of the entire execution/replanning cycle.
    *   **Tools It Might Use Directly:** LLM (Gemini) for final response synthesis and for LLM-based CWC updates.
    *   **API Key Management:** Configured with its own primary Gemini API key, which is then passed to `PlanManager` and `PlanExecutor`.

*   **`ResearchAgent`**
    *   **Primary Functions:** Specialized in information gathering. Picks up research-related tasks from the `SubTaskQueue`. Executes tasks using its tools and posts results to the `ResultsQueue`.
    *   **Tools It Uses:** `WebSearchTool`, `ReadWebpageTool`. Potentially an LLM for post-processing results.
    *   **API Key Management:** Configured with keys for search services (e.g., Google CSE) and potentially its own LLM API key.

*   **`UtilityAgent`**
    *   **Primary Functions:** Specialized in performing calculations and other specific utility tasks. Picks up utility tasks (e.g., calculations) from the `SubTaskQueue`. Executes tasks and posts results to the `ResultsQueue`.
    *   **Tools It Uses:** `CalculatorTool`. Future: data converters, code interpreters (sandboxed).
    *   **API Key Management:** Generally no LLM key needed, but specific utility tools might require their own service keys.

## 3. Task Queue Mechanism (Conceptual)

A task queue-based system will manage communication and task distribution.

*   **A. Task Assignment (Orchestrator -> Worker Agents)**
    *   **`SubTaskQueue`:** A primary queue for sub-tasks. Worker agents filter messages by `assigned_agent_role`.
    *   **Task Message Structure (JSON):**
        *   `sub_task_id`: Unique ID for the sub-task.
        *   `parent_task_id`: ID of the original user task.
        *   `assigned_agent_role`: Target worker role (e.g., "ResearchAgent", or "Orchestrator" for special actions).
        *   `tool_name`: Specific tool to use (e.g., "WebSearchTool", "FileSystemTool").
        *   `sub_task_input`: Object with input for the sub-task/tool (e.g., `{ "query": "..." }` for search, or `{ "operation": "create_pdf_from_text", "params": { ... } }` for FileSystemTool).
        *   `context_summary`: (Optional) Relevant context from the Orchestrator.
        *   `api_keys_config_ref`: (Optional, Advanced) Reference to a specific API key profile if a worker supports multiple.

*   **B. Result Reporting (Worker Agents -> Orchestrator)**
    *   **`ResultsQueue`:** A separate queue for sub-task outcomes.
    *   **Result Message Structure (JSON):**
        *   `sub_task_id`: Correlating sub-task ID.
        *   `parent_task_id`: Original user task ID.
        *   `worker_agent_role`: Role of the reporting agent.
        *   `status`: "COMPLETED" or "FAILED".
        *   `result_data`: Output of the sub-task (if COMPLETED).
        *   `error_details`: Error information (if FAILED), including `message` and optional `type`.

*   **C. Initial Implementation:** Queues can be simple in-memory arrays/event emitters within the single `server.js` process initially.

## 4. Inter-Agent Communication Flow & Task Lifecycle

1.  User submits task via frontend to a backend API endpoint (e.g., `/api/generate-plan`).
2.  API routes task to `OrchestratorAgent`; `parent_task_id` generated.
3.  `OrchestratorAgent` invokes `PlanManager` to obtain an execution plan.
    *   `PlanManager` attempts to use a template or generates a new plan using an LLM. The LLM is instructed to:
        *   Assign a unique `stepId` to each step in the plan.
        *   Use the `@{outputs.SOURCE_STEP_ID.FIELD_NAME}` syntax in a step's `sub_task_input` if it needs to reference the output (`result_data` or `processed_result_data`) of a previous step.
        *   Utilize other features like `isFinalAnswer` flag, Orchestrator tools (FileSystemTool, FileDownloaderTool), etc.
    *   `PlanManager` validates the generated plan, including the correctness of `stepId`s (presence, uniqueness) and the syntax of output references. It then returns the plan to `OrchestratorAgent`.
4.  **Execution Cycle Begins:** `OrchestratorAgent` initiates the execution/replanning loop.
    *   **Attempt Execution:** `OrchestratorAgent` calls `PlanExecutor.executePlan` with the current plan.
        *   `PlanExecutor` iterates through stages and steps:
            *   **Reference Resolution:** Before executing each step, `PlanExecutor` resolves any `@{outputs...}` references in its `sub_task_input` by looking up the `SOURCE_STEP_ID` in its internal `stepOutputs` map (which stores results of already executed steps). If a reference is invalid (e.g., source step not found, not completed successfully, field name incorrect), the current step fails at this resolution phase.
            *   Worker agent tasks (with resolved inputs) are dispatched via `SubTaskQueue`.
            *   Orchestrator-level actions (with resolved inputs) are handled directly by `PlanExecutor`.
            *   `PlanExecutor` awaits results. After each step completes (or fails), its output (and `stepId`) is stored in the `stepOutputs` map for potential future references, and also recorded in `contextEntry` (with the original, unresolved `sub_task_input`).
        *   `PlanExecutor` returns its overall outcome: `success` (boolean), `executionContext` (containing `stepId` and original `sub_task_input` for each step), `journalEntries`, `updatesForWorkingContext`, `failedStepDetails` (if failed), and potentially `finalAnswer`.
    *   Worker agents (`ResearchAgent`, `UtilityAgent`) process tasks from `SubTaskQueue` and send results to `ResultsQueue` as before.
    *   **Outcome Processing by OrchestratorAgent:**
        *   `OrchestratorAgent` merges `PlanExecutor`'s journal entries and updates its `CurrentWorkingContext` with `keyFindings` and `errorsEncountered`.
        *   **If execution was successful:** The loop terminates. `OrchestratorAgent` proceeds to final response synthesis.
        *   **If execution failed:**
            *   `OrchestratorAgent` checks if `MAX_REVISIONS` has been reached.
            *   If not, it calls `PlanManager.getPlan` again, this time with `isRevision: true`, providing the CWC, the `executionContext` of the failed attempt, `failedStepDetails`, and the plan that failed.
                *   If `PlanManager` returns a new valid plan, this new plan becomes the input for the next iteration of the execution loop.
                *   If `PlanManager` fails to return a new plan, the loop terminates, and the task is marked as failed.
            *   If `MAX_REVISIONS` was reached, the loop terminates, and the task is marked as failed.
5.  **Final Response Synthesis (Post-Loop):**
    *   If the overall execution cycle (including any successful replans) was successful:
        *   `OrchestratorAgent` checks if `PlanExecutor` returned a pre-synthesized `finalAnswer` from the last successful attempt. If so, it's used.
        *   Otherwise, `OrchestratorAgent` uses its LLM to synthesize a final response based on the `executionContext` (from the last successful attempt) and the final `CurrentWorkingContext`.
    *   If the overall execution cycle failed, the synthesis step will typically explain the failure based on the CWC.
6.  **State Saving:** `OrchestratorAgent` saves the final task state (including the final CWC, the plan that was last attempted, execution context, and overall status) and the complete `TaskJournal` (which now includes entries from all execution and replanning attempts).
7.  The response is returned to the API endpoint and then to the user.


## 5. Managing Multiple API Keys
(Content remains the same)

## 6. High-Level Backend Structure

*   **Directory Structure:**
    ```
    agents/
    ├── OrchestratorAgent.js
    ├── ResearchAgent.js
    ├── UtilityAgent.js
    └── BaseAgent.js      # (Optional)
    core/
    ├── PlanManager.js    # Handles initial plan generation and plan revision (replanning).
    #                       - Accepts `isRevision` flag and context for revisions.
    #                       - Instructs LLM on 'isFinalAnswer', Orchestrator tools, `stepId` generation for each step, and the use of `@{outputs.SOURCE_STEP_ID.FIELD_NAME}` syntax for referencing outputs of prior steps in `sub_task_input`.
    #                       - Validates `stepId` (presence, format, uniqueness) and the basic syntax of `@{outputs...}` references in the generated plan.
    ├── PlanExecutor.js   # Handles execution of a given plan.
    #                       - Before executing each step, resolves `@{outputs...}` references in its `sub_task_input` using a map of previously completed step outputs (`stepOutputs`).
    #                       - A reference to a non-successfully completed step (`status !== "COMPLETED"`) or an invalid reference will cause the dependent step to fail during resolution.
    #                       - Stores the `stepId` (from the plan) in each `contextEntry`.
    #                       - Populates the `stepOutputs` map with the results of each completed/failed step, keyed by `stepId`.
    #                       - Returns `failedStepDetails` on failure. Collects CWC data, identifies pre-synthesized answers.
    ├── SubTaskQueue.js   # (In-memory initially) for dispatching tasks to worker agents.
    └── ResultsQueue.js # (In-memory initially) for receiving results from worker agents.
    tools/
    ├── WebSearchTool.js
    ├── CalculatorTool.js
    ├── ReadWebpageTool.js # Uses Playwright and Cheerio for web content extraction.
    ├── FileSystemTool.js  # Provides sandboxed file system operations for the Orchestrator/PlanExecutor, including PDF generation from text with custom font support.
    ├── FileDownloaderTool.js # Provides sandboxed file downloading for the Orchestrator/PlanExecutor.
    └── ...
    frontend/
    server.js             # Express server, API, initialization
    ...
    ```
*   **`agents/*.js`:** Define individual agent classes. `OrchestratorAgent.js` acts as the central coordinator, delegating to core components.
*   **`core/*.js`:** Contains core components like `PlanManager`, `PlanExecutor`, and queue implementations.
*   **`server.js`:**
    *   Requires and instantiates agent classes (including `OrchestratorAgent`) and queue classes.
    *   Sets up Express API endpoint(s) that delegate tasks to `OrchestratorAgent`.
    *   Initializes worker agents and starts their "listening" process on the `SubTaskQueue`.
    *   Manages loading of API keys from `.env` and passes them to relevant constructors.
    *   Tool class definitions might remain in `server.js` initially or move to a `tools/` directory.
```
