# Conceptual Design Document: Multi-Agent System

## 1. Overview

This document outlines the conceptual design for transitioning the current AI agent into a multi-agent system. This system will feature specialized agents, an orchestrator to manage tasks, inter-agent communication via task queues, and support for multiple API key configurations. The design draws inspiration from advanced agent frameworks like CAMEL/Owl and aims to enhance the agent's universality and task-handling capabilities within our existing Node.js environment.

## 2. Core Agent Roles and Responsibilities

We will define the following initial agent roles:

*   **`OrchestratorAgent`**
    *   **Primary Functions:**
        *   Acts as the high-level coordinator for user tasks. Receives tasks via the API.
        *   **Planning Delegation:** Utilizes the `PlanManager` component to generate or retrieve execution plans. `PlanManager` is responsible for:
            *   Checking for matching pre-defined plan templates.
            *   If no template matches, constructing a detailed prompt for an LLM (Gemini) based on agent capabilities and the user task.
            *   Calling the LLM service to generate a multi-stage plan.
            *   Validating the structure and content of the plan returned by the LLM.
        *   **Execution Delegation:** Utilizes the `PlanExecutor` component to carry out the steps defined in the generated plan. `PlanExecutor` is responsible for:
            *   Iterating through plan stages and steps.
            *   Dispatching tasks intended for worker agents (like `ResearchAgent`, `UtilityAgent`) to the `SubTaskQueue`.
            *   Awaiting results from worker agents via the `ResultsQueue`.
            *   Directly handling special Orchestrator-level actions defined in the plan (e.g., `ExploreSearchResults`, `GeminiStepExecutor` for direct LLM calls by the Orchestrator). This includes using tools like `ReadWebpageTool` internally for `ExploreSearchResults`.
            *   Summarizing data from completed steps (where appropriate) using an LLM.
            *   Aggregating all execution results into a comprehensive `executionContext`.
        *   **Final Response Synthesis:** After `PlanExecutor` completes, `OrchestratorAgent` uses the final `executionContext` to synthesize a user-facing response, typically using an LLM.
        *   **State Management:** Manages the overall task state, including loading and saving task progress and results (e.g., using `loadTaskState`, `saveTaskState`).
        *   Handles overall error management based on outcomes from `PlanManager` and `PlanExecutor`.
    *   **Tools It Might Use Directly:** LLM (Gemini) for final response synthesis. (Note: Planning and specific step executions involving LLM calls are now delegated to `PlanManager` and `PlanExecutor`).
    *   **API Key Management:** Configured with its own primary Gemini API key, which is then passed to and utilized by `PlanManager` and `PlanExecutor` for their LLM interactions.

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
        *   `assigned_agent_role`: Target worker role (e.g., "ResearchAgent").
        *   `tool_name`: (Optional) Specific tool to use.
        *   `sub_task_input`: Object with input for the sub-task/tool (e.g., `{ "query": "..." }` for search).
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
    *   `PlanManager` attempts to use a template or generates a new plan using an LLM.
    *   `PlanManager` validates the plan and returns it to `OrchestratorAgent`.
4.  If a valid plan is obtained, `OrchestratorAgent` invokes `PlanExecutor` with the plan.
    *   `PlanExecutor` iterates through stages and steps:
        *   For tasks assigned to worker agents, `PlanExecutor` enqueues them onto `SubTaskQueue` and awaits results via `ResultsQueue`.
        *   For special Orchestrator actions (e.g., `ExploreSearchResults`), `PlanExecutor` handles them directly (e.g., by calling `ReadWebpageTool` internally or an LLM for `GeminiStepExecutor` steps).
    *   `PlanExecutor` collects all results and summarizations into an `executionContext`.
5.  Worker agents (`ResearchAgent`, `UtilityAgent`) monitor `SubTaskQueue`, dequeue messages matching their role.
6.  Worker agent executes the sub-task using specified tool and input.
7.  Worker agent constructs a result message and enqueues it onto `ResultsQueue`.
8.  `PlanExecutor` receives results from `ResultsQueue` (for worker agent tasks) and combines them with results from directly handled Orchestrator actions. If a sub-task FAILED, `PlanExecutor` may halt execution of subsequent stages and report failure.
9.  Once `PlanExecutor` completes, `OrchestratorAgent` receives the final `executionContext` (including status of all steps).
10. `OrchestratorAgent` uses an LLM to synthesize a final response based on the `executionContext`.
11. `OrchestratorAgent` saves the final task state and returns the response to the API endpoint, then to the user.

## 5. Managing Multiple API Keys

*   **Approach:** All unique API keys stored in the root `.env` file, loaded by `server.js` using `dotenv`.
*   **Naming Convention:** Environment variables named clearly (e.g., `ORCHESTRATOR_GEMINI_API_KEY`, `RESEARCH_AGENT_SEARCH_API_KEY`).
*   **Configuration:** In `server.js`, API keys are read from `process.env` and passed to the constructors of respective agent or tool classes when they are instantiated.
*   **Security:** Raw API keys are not passed in task queue messages. Agents use the keys they were configured with at startup.
*   **Initial Focus:** Each agent type configured with one primary set of necessary keys.

## 6. High-Level Backend Structure

*   **Directory Structure:**
    ```
    agents/
    ├── OrchestratorAgent.js
    ├── ResearchAgent.js
    ├── UtilityAgent.js
    └── BaseAgent.js      # (Optional)
    core/
    ├── PlanManager.js    # Handles plan generation, template usage, and validation.
    ├── PlanExecutor.js   # Handles execution of planned steps, including special Orchestrator actions and queue interactions.
    ├── SubTaskQueue.js   # (In-memory initially) for dispatching tasks to worker agents.
    └── ResultsQueue.js # (In-memory initially) for receiving results from worker agents.
    tools/                # (Optional future refactor for tool classes)
    ├── WebSearchTool.js
    ├── CalculatorTool.js
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
