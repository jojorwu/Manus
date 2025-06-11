# Gemini Powered AI Agent

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It currently features a Gemini execution tool for general reasoning and text generation, a real Web Search tool (Google Custom Search Engine API), a Calculator tool, and a Webpage Reading tool. The agent is designed to handle complex tasks by breaking them into stages, with the ability to execute steps within each stage in parallel. It maintains contextual memory (with summarization for long histories) and can attempt multi-stage replanning if steps fail. Interaction with the agent is primarily through a modern React-based web interface.

## Project Architecture

This project consists of two main components: a Node.js backend that houses the AI agent logic, and a modern React frontend for user interaction.

*   **Backend (Root Directory - `server.js`):**
    *   Built with Node.js and Express.js.
    *   Responsible for all core AI agent functionalities:
        *   Receiving user tasks via API endpoints.
        *   Interacting with the Google Gemini API for planning, step execution, replanning, and context summarization.
        *   Managing and dispatching tasks to various tools (e.g., Web Search, Calculator, Webpage Reader, GeminiStepExecutor).
        *   Handling the execution flow, including staged/parallel execution and context management.
    *   Exposes an API (currently `/api/generate-plan`) that the frontend consumes.
    *   Its root path (`/`) now returns a simple JSON health/status message, and it serves static assets (which could include a production build of the frontend if placed in the root).

*   **Frontend (`frontend/` Directory):**
    *   A modern single-page application (SPA) built with React and Vite.
    *   Styled using Tailwind CSS and Shadcn/UI components for a polished user experience.
    *   Provides the user interface for:
        *   Submitting tasks to the agent.
        *   Displaying the agent's generated plan (including stages, steps, and chosen tools).
        *   Showing a detailed execution log of the agent's actions and results, including any replanning activity.
    *   Communicates with the backend by making HTTP requests to its API endpoints.

**Interaction Flow:**

1.  The user interacts with the React frontend, submitting a task.
2.  The frontend sends this task to the backend's API endpoint (e.g., `/api/generate-plan`).
3.  The Node.js backend processes the task:
    *   Generates a plan using Gemini.
    *   Executes the plan step-by-step (potentially in parallel stages), using appropriate tools.
    *   Handles context summarization and replanning as needed.
4.  The backend returns a JSON response to the frontend, containing the original task, the final plan, and a detailed execution log.
5.  The React frontend then parses this JSON response and renders it in a user-friendly format.

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini to dynamically generate multi-step, multi-stage plans based on user tasks.
*   **Tool-Aware Execution:** Gemini determines which tool is appropriate for each step in the plan.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, summarization, and executing complex instructions.
    *   **WebSearchTool:** For performing real-time web searches using the Google Custom Search Engine API.
    *   **CalculatorTool:** For evaluating mathematical expressions.
    *   **ReadWebpageTool:** For fetching and extracting textual content from web URLs.
*   **Staged and Parallel Execution:** Plans are structured into stages. Steps within the same stage can be executed in parallel.
*   **Contextual Memory & Summarization:** Information from completed steps is carried forward. Long contexts are automatically summarized using Gemini to maintain efficiency.
*   **Multi-Stage Replanning:** If a step fails, the agent can attempt a focused "step fix" or a more comprehensive "full replan" using Gemini.
*   **Modern Web Interface:** A React/Vite/Tailwind/Shadcn/UI frontend for task submission and detailed progress/result viewing, located in the `frontend/` directory.

## Technology Stack

*   **Backend:** Node.js, Express.js, `dotenv`
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Tools & Libraries (Backend):**
    *   Web Search: Google Custom Search Engine (CSE) API (via `axios`)
    *   Calculator: `mathjs`
    *   Web Page Reading: `axios` (basic text extraction)
    *   HTTP Client: `axios`
*   **Frontend (`frontend/` directory):** React, Vite, Tailwind CSS, Shadcn/UI, `axios`

## Design Documents

Detailed conceptual designs for key architectural aspects of this project can be found in the `docs/` directory:

*   **[Multi-Agent System Design](./docs/multi_agent_design.md):** Outlines the architecture for the multi-agent system, including agent roles, task queue mechanisms, inter-agent communication, and API key management.
*   **[Persistent Task Memory Design](./docs/persistent_memory_design.md):** Describes the conceptual design for saving agent task states to files for persistence, including data to persist, directory/file structure, content schemas, and agent interaction logic.

## Setup and Installation

### Prerequisites

*   Node.js (v18.x or later recommended)
*   npm (usually comes with Node.js)

### Installation

1.  Clone this repository (if you haven't already).
2.  Navigate to the project root directory.
3.  Install backend dependencies:
    ```bash
    npm install
    ```
4.  Navigate to the `frontend` directory and install frontend dependencies:
    ```bash
    cd frontend
    npm install
    cd ..
    ```

### Environment Variables

Create a `.env` file in the **root** of the project directory. This file is essential for storing your API keys and other configuration.

*   **`GEMINI_API_KEY`**: Your API key for the Google Gemini API.
    *   Obtain from Google AI Studio ([https://aistudio.google.com/](https://aistudio.google.com/)).
*   **`SEARCH_API_KEY`**: Your API key for the Google Custom Search Engine API.
    *   Obtain from the Google Cloud Console. Enable the "Custom Search API".
*   **`CSE_ID`**: Your Custom Search Engine ID.
    *   Create a Custom Search Engine and get its ID from the CSE control panel ([https://programmablesearchengine.google.com/](https://programmablesearchengine.google.com/)). Configure it to search the web or specific sites.

**Example `.env` file (place in project root):**
```
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
SEARCH_API_KEY="YOUR_GOOGLE_SEARCH_API_KEY_HERE"
CSE_ID="YOUR_CSE_ID_HERE"
```
*(Note: The `server.js` is configured to use the `dotenv` package to load these variables. Please ensure `dotenv` is listed in your root `package.json` and installed (`npm install dotenv` in the root directory) for this to work seamlessly. If `dotenv` failed to install via subtasks, you may need to install it manually or set these environment variables directly in your shell.)*

## Development Workflow: Running the Application

This project has two main parts that need to be run simultaneously for development using the new React-based user interface:

**1. Backend Server:**

*   **Ensure Prerequisites and Environment Variables are set up as described above.**
*   **Running the Backend:**
    *   Open your terminal in the **project root directory**.
    *   Start the server:
        ```bash
        node server.js
        ```
    *   The backend server will typically start on `http://localhost:3000`.
    *   API endpoints (like `/api/generate-plan`) will be available at this address.
    *   Its root path (`/`) provides a JSON status message. Static assets are also served from the root (which could include a production build of the frontend if placed there).
    *   Changes to `server.js` require a manual restart unless using a tool like `nodemon`.

**2. Frontend Development Server (New React UI):**

*   **Ensure frontend dependencies are installed (see "Installation" section).**
*   **Running the Frontend Dev Server:**
    *   Open a **new terminal window/tab**.
    *   Navigate to the `frontend` directory:
        ```bash
        cd frontend
        ```
    *   Start the Vite development server:
        ```bash
        npm run dev
        ```
    *   The frontend development server will typically start on `http://localhost:5173` (Vite will indicate the exact port).
    *   This server provides Hot Module Replacement (HMR), so frontend code changes often update in the browser automatically.

**Accessing the New UI:**
Once both servers are running, access the new React UI via the Vite dev server URL (e.g., `http://localhost:5173`). It will communicate with the backend API at `http://localhost:3000`.

## How to Use (New React UI)

1.  Open your web browser and navigate to the frontend URL (typically `http://localhost:5173`).
2.  You will see an input field where you can enter your task for the AI agent.
3.  Type the task (e.g., "What is the capital of France? Then, calculate 100/5. Finally, search for recent news about it.").
4.  Click the "Generate Plan & Execute" button.
5.  The interface will display:
    *   Your original task.
    *   The multi-stage plan generated by Gemini, including the tool chosen for each step.
    *   A detailed execution log showing the outcome (result or error) for each step, grouped by stage. This includes any replanning attempts if failures occur, and context summarization events.

## Modifying, Forking, and Contributing

This project is set up to be understandable and extensible.

### Forking

*   Fork this repository on GitHub to create your own version for modification.

### Making Modifications

*   **Backend Logic:** Core AI agent logic is in `server.js`. Tool definitions are also in this file.
*   **Frontend UI:** The React UI is in the `frontend/` directory, primarily within `frontend/src/`. Key components include `App.jsx`, `TaskInputForm.jsx`, and `ResultsDisplay.jsx`.
*   **Adding New Tools (Backend):**
    1.  Define your new tool class in `server.js` with an `async execute(inputObject)` method.
    2.  Instantiate it in `executePlanLoop`'s `availableTools` map.
    3.  Add its description to the `tools` array in `generatePlanWithGemini`.
    4.  Update the tool dispatch logic in `executePlanLoop` for the new tool.

### Contributing (Basic Guidelines)

1.  **Open an Issue:** Discuss proposed changes or new features by opening an issue first.
2.  **Create a Pull Request:** Fork the repo, create a feature branch, make your changes, and then open a PR against the main repository's `main` branch. Describe your changes clearly.

```
