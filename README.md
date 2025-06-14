# Gemini Powered AI Agent

> Current Version: **v0.1.0-beta** — For a detailed list of features and changes, please see the [CHANGELOG.md](./CHANGELOG.md).

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It features a Gemini execution tool for general reasoning, a Web Search tool, a Calculator tool, a Webpage Reading tool, and Orchestrator-level tools for file system operations (including PDF generation) and downloading. The agent is designed to handle complex tasks by breaking them into stages, with parallel execution of sub-tasks within each stage. It saves task states (including a `CurrentWorkingContext` and `TaskJournal`) and supports different operational modes via its API. Interaction with the agent is primarily through a modern React-based web interface.

## Project Architecture

This project consists of two main components: a Node.js backend that houses the AI agent logic, and a modern React frontend for user interaction.

*   **Backend (Root Directory - `index.js`):**
    *   Built with Node.js and Express.js.
    *   Responsible for all core AI agent functionalities.
    *   Exposes an API (currently `/api/generate-plan`).

*   **Frontend (`frontend/` Directory):**
    *   A modern single-page application (SPA) built with React and Vite.
    *   Provides the user interface for task submission and visualization.

**Interaction Flow:**
(Simplified for brevity - full flow in `docs/multi_agent_design.md`)
1.  User submits task.
2.  Backend (`OrchestratorAgent`) processes task:
    *   Initializes `CurrentWorkingContext` (CWC) and `TaskJournal`.
    *   Delegates to `PlanManager` for plan generation.
    *   Delegates to `PlanExecutor` for plan execution (which handles worker agents and Orchestrator-level tools).
    *   Updates CWC (possibly via LLM), merges journals.
    *   Synthesizes final answer (if not pre-synthesized by `PlanExecutor`).
3.  Backend returns response.
4.  Frontend renders response.

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini. Handled by `PlanManager`.
*   **Tool-Aware Execution:** Gemini determines tools/agents. Handled by `PlanExecutor`.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, summarization. Can be marked to produce the final answer.
    *   **WebSearchTool:** For real-time web searches.
    *   **CalculatorTool:** For mathematical expressions.
    *   **ReadWebpageTool:** Fetches fully rendered HTML using Playwright. Then, it prioritizes extracting the main article content using Mozilla's Readability library (with JSDOM). If Readability fails or doesn't find substantial content, it falls back to using Cheerio for a more general text extraction from the page body. Effective for articles and SPAs.
    *   **ExploreSearchResults (Orchestrator Action):** Reads content from multiple search results using `ReadWebpageTool`.
    *   **FileSystemTool (Orchestrator Action):**
        *   Performs operations like creating, reading, appending to, and listing text files within a sandboxed, task-specific workspace.
        *   Can generate simple PDF documents from text using `create_pdf_from_text`, with support for specifying custom `.ttf` or `.otf` fonts from the `assets/fonts/` directory (e.g., for non-Latin characters). If a custom font is not found or specified, it falls back to a default font (e.g., Helvetica).
    *   **FileDownloaderTool (Orchestrator Action):** Downloads files from URLs into the task-specific workspace, with size checks.
*   **Staged and Parallel Execution:** Supports complex plan structures.
*   **Persistent Memory:**
    *   **Task State (`task_state_{taskId}.json`):** Stores task details, plan, `executionContext`, `finalAnswer`, and `CurrentWorkingContext`.
    *   **Task Journal (`task_journal_{taskId}.jsonl`):** Detailed JSONL log of all significant events.
    *   **CurrentWorkingContext (CWC):** Evolves during task execution, holding `summaryOfProgress`, `keyFindings`, `errorsEncountered`, `nextObjective`. `summaryOfProgress` and `nextObjective` can be intelligently updated by an LLM.
*   **Context-Aware Result Summarization**: Intermediate results can be summarized by LLM within `PlanExecutor`.
*   **Step Output Referencing & Data Dependency:**
    *   Each step in a plan is assigned a unique `stepId` by the LLM during planning.
    *   Subsequent steps can reference the output of previously executed steps in their `sub_task_input` using the syntax `@{outputs.SOURCE_STEP_ID.FIELD_NAME}`.
    *   `FIELD_NAME` can be `result_data` (raw output) or `processed_result_data` (summarized/processed output).
    *   This allows for creating dynamic plans where data flows between steps. `PlanManager` validates syntax, and `PlanExecutor` resolves these references at runtime.
*   **Avoids Double Synthesis:** Checks if `PlanExecutor` has already generated a final answer.
*   **Modern Web Interface:** React/Vite/Tailwind/Shadcn/UI frontend.

## Known Issues / Limitations (v0.1.0-beta)

*   **Tool Implementations**:
    *   `ReadWebpageTool`: Now uses Playwright -> Readability/JSDOM -> Cheerio. This improves main content extraction from articles but may increase processing time. Effectiveness on non-article pages depends on the heuristics of Readability and Cheerio.
    *   `FileSystemTool`: PDF creation (`create_pdf_from_text`) supports basic text and custom TTF/OTF fonts; complex PDF styling or embedding is not supported. Other file operations are primarily for text.
    *   `FileDownloaderTool`: Basic download functionality; no advanced streaming optimizations for very large files.
*   **Task State Loading & Execution:** `SYNTHESIZE_ONLY` file search is basic; `EXECUTE_PLANNED_TASK` might re-plan.
*   **User Interface:** May not fully support all new API modes or CWC/Journal visualization.
*   **Error Handling & Retries:** Advanced error handling is not yet implemented.
*   **CWC Intelligence:** LLM-based CWC updates are functional but could be further enhanced.

## Technology Stack

*   **Backend:** Node.js, Express.js, `dotenv`
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Tools & Libraries (Backend):**
    *   Web Search: `axios` (for Google CSE API)
    *   Calculator: `mathjs`
    *   Web Page Reading: Playwright, @mozilla/readability, JSDOM, Cheerio
    *   File System Operations: Node.js `fs` module (via `FileSystemTool`), `pdfkit` (for PDF generation)
    *   File Downloading: `axios` (via `FileDownloaderTool`)
*   **Frontend (`frontend/` directory):** React, Vite, Tailwind CSS, Shadcn/UI, `axios`

## Design Documents
*   **[Multi-Agent System Design](./docs/multi_agent_design.md)**
*   **[Persistent Task Memory Design](./docs/persistent_memory_design.md)**

## Setup and Installation
### Prerequisites
*   Node.js (v18.x or later recommended)
*   npm (usually comes with Node.js)

### Installation
1.  Clone this repository.
2.  Navigate to the project root: `cd <repository_name>`
3.  Install backend dependencies: `npm install`
4.  Navigate to the `frontend` directory and install frontend dependencies: `cd frontend && npm install && cd ..`
    *   **Playwright Browsers:** Playwright (a dependency of `ReadWebpageTool`) requires browser binaries. After `npm install`, run:
        ```bash
        npx playwright install --with-deps
        ```
        This installs default browsers and their system dependencies.

### Environment Variables
*   **`GEMINI_API_KEY`**: For Google Gemini API.
*   **`SEARCH_API_KEY`**: For Google Custom Search Engine API.
*   **`CSE_ID`**: Your Custom Search Engine ID.

**Example `.env` file (place in project root):**
```
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
SEARCH_API_KEY="YOUR_GOOGLE_SEARCH_API_KEY_HERE"
CSE_ID="YOUR_CSE_ID_HERE"
```

## Development Workflow
(Content remains the same: run backend `node index.js`, run frontend `cd frontend && npm run dev`)

## How to Use
(Content remains the same)

## Modifying, Forking, and Contributing
(Content remains largely the same)

### Adding New Tools (Backend):
(This section should be reviewed to ensure it aligns with `PlanManager`'s role in providing tool capabilities to the LLM for planning).
The process generally involves:
1.  Defining the tool class in `tools/`.
2.  Importing and instantiating it in `index.js` (if it's a worker agent tool) or ensuring `PlanExecutor` can instantiate it (if it's an Orchestrator-level tool).
3.  Adding its description to `config/agentCapabilities.json` (for worker agent tools) or to the `planningPrompt` in `core/PlanManager.js` (for Orchestrator-level tools).
    *   `PlanManager.js`: Its `planningPrompt` instructs the LLM on tool usage, `stepId` generation, and the `@{outputs...}` syntax for data dependencies. It also validates these aspects in the generated plan.
4.  Ensuring `core/PlanExecutor.js` can handle the tool correctly.
    *   `PlanExecutor.js`: Manages the actual execution, including resolving `@{outputs...}` references at runtime using a map of step outputs, before dispatching to the tool or agent.
```
