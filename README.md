# Gemini Powered AI Agent

> Current Version: **v0.1.0-beta** — For a detailed list of features and changes, please see the [CHANGELOG.md](./CHANGELOG.md).

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It features a Gemini execution tool for general reasoning, a Web Search tool, a Calculator tool, a basic Webpage Reading tool, and an advanced Webpage Reading tool. The agent is designed to handle complex tasks by breaking them into stages, with parallel execution of sub-tasks within each stage. It saves task states and supports different operational modes via its API. Interaction with the agent is primarily through a modern React-based web interface.

## Project Architecture

This project consists of two main components: a Node.js backend that houses the AI agent logic, and a modern React frontend for user interaction.

*   **Backend (Root Directory - `index.js`):**
    *   Built with Node.js and Express.js.
    *   Responsible for all core AI agent functionalities.
    *   Exposes an API (currently `/api/generate-plan`) that the frontend consumes.
*   **Frontend (`frontend/` Directory):**
    *   A modern single-page application (SPA) built with React and Vite.
    *   Styled using Tailwind CSS and Shadcn/UI components.

**Interaction Flow:**
(Details omitted for brevity - assume unchanged)

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini to dynamically generate multi-step, multi-stage plans.
*   **Template-Based Planning for Common Tasks**: Utilizes predefined plan templates for faster, predictable execution of common queries.
*   **Tool-Aware Execution:** Gemini determines which tool is appropriate for each step.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, and summarization.
    *   **WebSearchTool:** For performing real-time web searches (Google Custom Search Engine API).
    *   **CalculatorTool:** For evaluating mathematical expressions.
    *   **ReadWebpageTool:** A simpler tool for fetching static web content or specific text-based URLs using axios and cheerio for basic HTML parsing.
    *   **AdvancedWebpageReaderTool:** Provides enhanced capabilities for fetching and processing web page content. It uses Playwright to render pages (handling JavaScript-driven dynamic content) and then extracts the main textual content and a list of images (including their source URLs and alt texts). It can also identify and handle basic non-HTML content types like JSON and plain text.
*   **Staged and Parallel Execution:** Plans are structured into stages for sequential execution, with parallel execution of sub-tasks within each stage.
*   **Contextual Memory & Summarization:** Information from completed steps is carried forward.
*   **Context-Aware Result Summarization**: Extensive data from tools can be summarized by an LLM before final answer synthesis.
*   **Enhanced Information Retrieval with `ExploreSearchResults`**: Uses `ReadWebpageTool` internally to read content from top web search results for more comprehensive answers.
    *   *Note:* This feature's effectiveness relies on `ReadWebpageTool`'s capability to extract meaningful textual content from web pages.
*   **Multi-Stage Replanning:** Supports focused "step fix" or "full replan" if a step fails.
*   **Modern Web Interface:** React/Vite/Tailwind/Shadcn/UI frontend.

## Plan Structure
(Details omitted for brevity - assume unchanged)

## Task State Persistence
(Details omitted for brevity - assume unchanged)

## Known Issues / Limitations (v0.1.0-beta)

This initial beta version has the following known limitations:

*   **Tool Implementations**:
    *   `WebSearchTool` has been implemented.
    *   `CalculatorTool` is functional.
    *   `ReadWebpageTool` provides basic HTML content fetching and text extraction.
    *   `AdvancedWebpageReaderTool` is implemented for dynamic content but may require Playwright browser binaries to be managed in some deployment environments.
*   **Dynamic Content Handling:** While `AdvancedWebpageReaderTool` significantly improves handling of dynamic, JavaScript-heavy pages, complex anti-scraping measures or highly intricate web applications might still pose challenges.
*   **Task State Loading**:
    *   The `SYNTHESIZE_ONLY` mode's file search logic is basic.
*   **Task Execution Flow**:
    *   The "No `EXECUTE_PLANNED_TASK` mode" point seems outdated as API descriptions mention it. This should be verified and removed if the mode is functional.
    *   No task resumption from point of failure.
*   **User Interface**:
    *   Frontend may not yet support all new API modes or visualization of saved states.
*   **Error Handling & Retries**:
    *   Advanced error handling (e.g., configurable retries) is not yet implemented.
*   **Context Management**:
    *   Summarization of intermediate `ContextEntry.result_data` is not yet implemented.

## Technology Stack

*   **Backend:** Node.js, Express.js, `dotenv`
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Tools & Libraries (Backend):**
    *   Web Search: Google Custom Search Engine (CSE) API (via `axios`)
    *   Calculator: `mathjs`
    *   Web Page Reading (Basic): `axios`, `cheerio` (for `ReadWebpageTool`)
    *   Web Page Rendering/Interaction (Advanced): `Playwright` (for `AdvancedWebpageReaderTool`)
    *   Web Page Parsing: `cheerio` (used by both webpage reading tools)
    *   HTTP Client: `axios`
*   **Frontend (`frontend/` directory):** React, Vite, Tailwind CSS, Shadcn/UI, `axios`

## Design Documents
(Details omitted for brevity - assume unchanged)

## Setup and Installation
(Details omitted for brevity - assume unchanged)

## Development Workflow: Running the Application
(Details omitted for brevity - assume unchanged)

## How to Use (New React UI)
(Details omitted for brevity - assume unchanged)

## Modifying, Forking, and Contributing
(Details omitted for brevity - assume unchanged)
```
