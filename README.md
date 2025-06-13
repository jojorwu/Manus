# Gemini Powered AI Agent

> Current Version: **v0.1.0-beta** — For a detailed list of features and changes, please see the [CHANGELOG.md](./CHANGELOG.md).

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It features a Gemini execution tool for general reasoning, a Web Search tool, a Calculator tool, a Webpage Reading tool, and Orchestrator-level tools for file system operations and downloading. The agent is designed to handle complex tasks by breaking them into stages, with parallel execution of sub-tasks within each stage. It saves task states (including a `CurrentWorkingContext` and `TaskJournal`) and supports different operational modes via its API. Interaction with the agent is primarily through a modern React-based web interface.

## Project Architecture

This project consists of two main components: a Node.js backend that houses the AI agent logic, and a modern React frontend for user interaction.

*   **Backend (Root Directory - `index.js`):**
    *   Built with Node.js and Express.js.
    *   Responsible for all core AI agent functionalities:
        *   Receiving user tasks via API endpoints.
        *   Interacting with the Google Gemini API for planning, step execution, replanning, context summarization, and intelligent updates to the `CurrentWorkingContext`.
        *   Managing and dispatching tasks to various tools (e.g., Web Search, Calculator, Webpage Reader, GeminiStepExecutor) and Orchestrator-level actions (File System, File Downloading).
        *   Handling the execution flow, including staged/parallel execution and context management.
    *   Exposes an API (currently `/api/generate-plan`) that the frontend consumes.
        The `/api/generate-plan` endpoint accepts a POST request with a JSON body.
        - `task` (string, required for `EXECUTE_FULL_PLAN` and `PLAN_ONLY` modes): The user's task description.
        - `mode` (string, optional, defaults to "EXECUTE_FULL_PLAN"): Specifies the operational mode.
            - `"EXECUTE_FULL_PLAN"`: Generates a new plan, executes it, saves the task state (including CWC and Journal), and returns the synthesized answer.
            - `"SYNTHESIZE_ONLY"`: Loads a previously saved task state (including CWC and `executionContext`), re-synthesizes the final answer, and returns the result. Does not re-execute or re-save the plan.
            - `"PLAN_ONLY"`: Receives a user `task`, generates a multi-stage execution plan, saves the task state (including CWC and Journal), and returns the `taskId` and the generated `plan`. Does not execute the plan.
            - `"EXECUTE_PLANNED_TASK"`: Loads a task state (including CWC and a pre-generated plan). It then executes this plan, synthesizes a final answer, updates the task state file, and returns the outcome.
        - `taskIdToLoad` (string, required for `SYNTHESIZE_ONLY` and `EXECUTE_PLANNED_TASK` modes): The ID of a previously saved task state to load.
    *   Its root path (`/`) now returns a simple JSON health/status message.

*   **Frontend (`frontend/` Directory):**
    *   A modern single-page application (SPA) built with React and Vite.
    *   Styled using Tailwind CSS and Shadcn/UI components.
    *   Provides the user interface for task submission and visualization of plans and execution logs.

**Interaction Flow:**

1.  User submits a task via the React frontend.
2.  Frontend sends the task to the backend API.
3.  Node.js backend (`OrchestratorAgent`) processes the task:
    *   Initializes `CurrentWorkingContext` (CWC) and `TaskJournal`.
    *   Delegates to `PlanManager` to generate/retrieve a plan. `TaskJournal` updated.
    *   If execution is required, delegates to `PlanExecutor` with the plan and `savedTasksBaseDir`.
        *   `PlanExecutor` executes steps, manages `SubTaskQueue`/`ResultsQueue` for worker agents, handles Orchestrator-level tools (`ExploreSearchResults`, `FileSystemTool`, `FileDownloaderTool`), collects `keyFindings` and `errorsEncountered` for CWC, and its own `TaskJournal` entries.
    *   `OrchestratorAgent` receives results from `PlanExecutor`, updates its CWC (potentially using an LLM for refining `summaryOfProgress` and `nextObjective`), and merges journal entries.
    *   If a final answer wasn't pre-synthesized by `PlanExecutor` (via `isFinalAnswer: true` flag in a step), `OrchestratorAgent` synthesizes it using an LLM, CWC, and `executionContext`.
4.  Backend returns a JSON response (including final answer, plan, execution log/context).
5.  Frontend renders the response.

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini to dynamically generate multi-step, multi-stage plans. `PlanManager` handles this, including template usage and plan validation.
*   **Tool-Aware Execution:** Gemini determines which tool/agent is appropriate for each step. `PlanExecutor` manages execution flow.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, summarization. Can be used by worker agents or directly by Orchestrator (via `PlanExecutor`), and can be marked to produce the final answer.
    *   **WebSearchTool:** For real-time web searches.
    *   **CalculatorTool:** For mathematical expressions.
    *   **ReadWebpageTool:** Uses Playwright (Chromium) to fetch fully rendered HTML (improving SPA handling), then `cheerio` to extract and clean text. Subject to performance considerations for multiple calls.
    *   **ExploreSearchResults (Orchestrator Action):** Orchestrator (via `PlanExecutor`) uses `ReadWebpageTool` to read content from multiple search results for deeper analysis.
    *   **FileSystemTool (Orchestrator Action):** Allows Orchestrator (via `PlanExecutor`) to create, read, append, and list text files within a sandboxed, task-specific workspace.
    *   **FileDownloaderTool (Orchestrator Action):** Enables Orchestrator (via `PlanExecutor`) to download files from URLs into the task-specific workspace, with size checks.
*   **Staged and Parallel Execution:** Plans are structured into stages; sub-tasks within a stage run in parallel.
*   **Persistent Memory:**
    *   **Task State (`task_state_{taskId}.json`):** Stores comprehensive task data including the original request, plan, final status, `executionContext`, `finalAnswer`, and `CurrentWorkingContext`.
    *   **Task Journal (`task_journal_{taskId}.jsonl`):** A detailed JSONL log of all significant events and state changes from `OrchestratorAgent`, `PlanManager`, and `PlanExecutor`.
    *   **CurrentWorkingContext (CWC):** An evolving JSON object within the task state that maintains `summaryOfProgress`, `keyFindings`, `errorsEncountered`, `nextObjective`, etc. Key fields can be intelligently updated by an LLM.
*   **Context-Aware Result Summarization**: Individual step results from tools can be summarized by an LLM (within `PlanExecutor`) before being added to `executionContext` to manage context window sizes.
*   **Avoids Double Synthesis:** Checks if `PlanExecutor` has already generated a final answer (via `isFinalAnswer: true` in a plan step) before attempting synthesis in `OrchestratorAgent`.
*   **Multi-Stage Replanning:** (Conceptual) If a step fails, the agent could attempt replanning.
*   **Modern Web Interface:** React/Vite/Tailwind/Shadcn/UI frontend.

## Known Issues / Limitations (v0.1.0-beta)

*   **Tool Implementations**:
    *   `ReadWebpageTool` (Playwright-based): While greatly improving SPA content retrieval, it's slower than direct HTTP requests. Batch processing of many URLs (e.g., in `ExploreSearchResults`) might require optimization of Playwright instance management. Handling of non-HTML content now relies on browser rendering.
    *   `FileSystemTool` and `FileDownloaderTool`: Primarily designed for text-based content and basic file operations. Do not support complex binary formats, partial file editing, or very large file streaming optimizations beyond basic size checks.
*   **Task State Loading & Execution:**
    *   `SYNTHESIZE_ONLY` mode's file search logic is basic.
    *   `EXECUTE_PLANNED_TASK` mode currently re-plans if a template is not found, rather than strictly executing only the loaded plan. This needs refinement.
*   **User Interface:** Current frontend may not fully support all new API modes or visualization of CWC/TaskJournal.
*   **Error Handling & Retries:** Advanced error handling (e.g., configurable retries) is not yet implemented.
*   **CWC Intelligence:** LLM-based updates to CWC's `summaryOfProgress` and `nextObjective` are implemented but could be further enhanced with more sophisticated prompting or fine-tuning.

## Technology Stack

*   **Backend:** Node.js, Express.js, `dotenv`
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Tools & Libraries (Backend):**
    *   Web Search: Google Custom Search Engine (CSE) API (via `axios`)
    *   Calculator: `mathjs`
    *   Web Page Reading: Playwright (for fetching rendered HTML), Cheerio (for parsing and text extraction)
    *   File System Operations: Node.js `fs` module (via `FileSystemTool` executed by `PlanExecutor`)
    *   File Downloading: `axios` (via `FileDownloaderTool` executed by `PlanExecutor`)
    *   HTTP Client: `axios` (used by some tools)
*   **Frontend (`frontend/` directory):** React, Vite, Tailwind CSS, Shadcn/UI, `axios`

## Design Documents
*   **[Multi-Agent System Design](./docs/multi_agent_design.md)**
*   **[Persistent Task Memory Design](./docs/persistent_memory_design.md)**

## Setup and Installation
(Content remains largely the same, ensure Playwright browser installation note is present)
### Prerequisites
*   Node.js (v18.x or later recommended)
*   npm (usually comes with Node.js)

### Installation
1.  Clone this repository.
2.  Navigate to the project root directory.
3.  Install backend dependencies: `npm install`
4.  Navigate to the `frontend` directory and install frontend dependencies: `cd frontend && npm install && cd ..`
    *   **Playwright Browsers:** After `npm install`, Playwright (a dependency of `ReadWebpageTool`) requires browser binaries. Run:
        ```bash
        npx playwright install --with-deps
        ```
        This installs default browsers and their system dependencies.

### Environment Variables
(Content remains the same)

## Development Workflow
(Content remains the same)

## How to Use
(Content remains the same)

## Modifying, Forking, and Contributing
(Content remains largely the same, ensure mentions of new core components like PlanManager/PlanExecutor if detailing backend logic modifications)

### Adding New Tools (Backend):
(This section should be reviewed to ensure it aligns with `PlanManager`'s role in providing tool capabilities to the LLM for planning).
The process generally involves:
1.  Defining the tool class in `tools/`.
2.  Importing and instantiating it in `index.js`.
3.  Adding its description to `config/agentCapabilities.json` so `PlanManager` can include it in prompts.
4.  Ensuring `PlanExecutor` can handle it if it's an Orchestrator-level special action OR that the appropriate worker agent (`ResearchAgent`, `UtilityAgent`) can use it.

(Rest of README.md content)
```
