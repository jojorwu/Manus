# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta] - 2024-07-17
(Заменить YYYY-MM-DD на текущую дату, например, 2024-07-16)

### Added

-   **Core Task Processing Pipeline**:
    -   Initial user task intake via API (`/api/generate-plan`).
    -   LLM-based multi-stage plan generation.
    -   Sequential execution of stages, with parallel execution of sub-tasks within each stage.
    -   Tool execution via specialized agents (`ResearchAgent`, `UtilityAgent`) using a defined `toolsMap`. Includes stubs for `WebSearchTool`, `ReadWebpageTool`, and a functional `CalculatorTool`.
    -   LLM-based final answer synthesis from execution results.
-   **Task State Persistence**:
    -   Automatic saving of complete task state (initial task, plan, execution context, final answer, status) to JSON files.
    -   Files are stored in `saved_tasks/tasks_MMDDYYYY/task_state_{taskId}.json`.
    -   Utility functions `saveTaskState` and `loadTaskState` created in `utils/taskStateUtil.js`.
-   **API Modes of Operation**:
    -   `EXECUTE_FULL_PLAN`: Default mode for full task processing.
    -   `PLAN_ONLY`: Generates and saves a plan without execution. API returns the plan and `taskId`.
    -   `SYNTHESIZE_ONLY`: Loads a saved task's execution context and re-synthesizes a final answer. Requires `taskIdToLoad`.
-   **Configuration & Modularity**:
    -   Agent capabilities (`workerAgentCapabilities` for `OrchestratorAgent`) are loaded from `config/agentCapabilities.json`.
    -   API keys and server port are configurable via a `.env` file.
    -   Improved code structure with separation of concerns into `agents/`, `tools/`, `services/`, `core/`, and `utils/` directories.
-   **Resilience & Stability**:
    -   Timeouts implemented for tool execution within agents.
    -   Enhanced error handling and logging in various components.
    -   Structured context (`ContextEntry`) for more robust data handling and synthesis.
-   **Documentation**:
    -   Initial `README.md` detailing architecture, setup, and usage.
    -   This `CHANGELOG.md` file.
