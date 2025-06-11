# Conceptual Design Document: Multi-Agent System

## 1. Overview

This document outlines the conceptual design for transitioning the current AI agent into a multi-agent system. This system will feature specialized agents, an orchestrator to manage tasks, inter-agent communication via task queues, and support for multiple API key configurations. The design draws inspiration from advanced agent frameworks like CAMEL/Owl and aims to enhance the agent's universality and task-handling capabilities within our existing Node.js environment.

## 2. Core Agent Roles and Responsibilities

We will define the following initial agent roles:

*   **`OrchestratorAgent`**
    *   **Primary Functions:**
        *   Acts as the central coordinator. Receives high-level tasks from the user via the API.
        *   **Task Decomposition & Planning:** Uses an LLM (Gemini) to break tasks into sub-tasks, assigning each to an appropriate worker agent role and specifying a tool if applicable.
        *   **Task Assignment:** Places sub-task messages onto a `SubTaskQueue`.
        *   **Result Aggregation & Synthesis:** Monitors a `ResultsQueue` for completed sub-tasks. Synthesizes results into a final user response (likely using an LLM).
        *   Handles overall error management and may trigger sub-task level replanning.
    *   **Tools It Might Use Directly:** LLM (Gemini) for planning and synthesis.
    *   **API Key Management:** Configured with its own primary Gemini API key.

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

1.  User submits task via frontend to a backend API endpoint (e.g., `/api/process-multi-agent-task`).
2.  API routes task to `OrchestratorAgent`; `parent_task_id` generated.
3.  `OrchestratorAgent` uses LLM to decompose task into sub-task definitions (including `assigned_agent_role`, `tool_name`, `sub_task_input`).
4.  `OrchestratorAgent` creates task messages and enqueues them onto `SubTaskQueue`. It tracks dispatched `sub_task_id`s.
5.  Worker agents (e.g., `ResearchAgent`, `UtilityAgent`) monitor `SubTaskQueue`, dequeue messages matching their role.
6.  Worker agent executes the sub-task using specified tool and input, utilizing its configured API keys if needed.
7.  Worker agent constructs a result message and enqueues it onto `ResultsQueue`.
8.  `OrchestratorAgent` monitors `ResultsQueue`, dequeues results, correlates them.
    *   If a sub-task FAILED, Orchestrator may trigger recovery/replanning for that sub-task.
9.  Once all necessary sub-tasks are resolved, `OrchestratorAgent` uses LLM to synthesize aggregated results into a final response.
10. Orchestrator returns final response to API endpoint, then to user.

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
    ├── SubTaskQueue.js   # (In-memory initially)
    └── ResultsQueue.js # (In-memory initially)
    tools/                # (Optional future refactor for tool classes)
    ├── WebSearchTool.js
    ├── CalculatorTool.js
    └── ...
    frontend/
    server.js             # Express server, API, initialization
    ...
    ```
*   **`agents/*.js`:** Define individual agent classes, their logic, and tool usage.
*   **`core/*.js`:** Implementations for in-memory queues.
*   **`server.js`:**
    *   Requires and instantiates agent and queue classes.
    *   Sets up Express API endpoint(s) that delegate tasks to `OrchestratorAgent`.
    *   Initializes worker agents and starts their "listening" process on the `SubTaskQueue`.
    *   Manages loading of API keys from `.env` and passes them to relevant constructors.
    *   Tool class definitions might remain in `server.js` initially or move to a `tools/` directory.
```
