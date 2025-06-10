require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Added for Gemini
const axios = require('axios'); // Added for WebSearchTool
const math = require('mathjs'); // Added for CalculatorTool
// const he = require('he'); // Skipped due to npm install issues in this environment
const app = express();
const port = 3000;

const MAX_CONTEXT_CHARS_BEFORE_SUMMARIZATION = 4000;
const SUMMARIZED_CONTEXT_PREFIX = "Summary of prior actions and information: ";

// Initialize GoogleGenerativeAI
const apiKey = process.env.GEMINI_API_KEY;
let genAI;
if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
} else {
  console.warn('GEMINI_API_KEY environment variable not set. Gemini functionality will be disabled.');
}

// Async helper function to call Gemini
const GEMINI_TIMEOUT_DURATION = 20000; // 20 seconds

async function callGemini(promptString) {
  if (!genAI) {
    throw new Error("Gemini API client not initialized. Check API key.");
  }

  let timeoutId; // For clearing timeout if Gemini finishes first
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Gemini API call timed out after ${GEMINI_TIMEOUT_DURATION / 1000} seconds.`));
    }, GEMINI_TIMEOUT_DURATION);
  });

  try {
    const geminiPromise = genAI.getGenerativeModel({ model: "gemini-pro" }).generateContent(promptString);

    const raceResult = await Promise.race([
      geminiPromise,
      timeoutPromise
    ]);

    clearTimeout(timeoutId); // Clear the timeout as Gemini call completed

    // If timeoutPromise did not win, raceResult is the result from geminiPromise
    const response = await raceResult.response; // This line might fail if raceResult is from a timeout (it wouldn't have .response)
                                             // However, Promise.race ensures only one promise (the first to settle) provides its result/rejection.
                                             // If timeout wins, it rejects, and execution goes to catch.
    const text = response.text();
    return text;

  } catch (error) {
    clearTimeout(timeoutId); // Ensure timeout is cleared on any error too
    console.error("Error calling Gemini API or timed out:", error.message);
    // Check if it's our specific timeout error
    if (error.message.includes("Gemini API call timed out")) {
      throw error; // Re-throw the timeout error as is
    }
    // For other errors (actual API errors, etc.)
    throw new Error(`Error generating content from Gemini: ${error.message}`);
  }
}

async function summarizeContextIfNeeded(currentContext, originalTask, callGeminiFunc) {
  if (!currentContext || typeof currentContext !== 'string' || currentContext.length <= MAX_CONTEXT_CHARS_BEFORE_SUMMARIZATION) {
    return currentContext; // Return original if not a string, null, empty, or not exceeding threshold
  }

  console.log(`Context length (${currentContext.length}) exceeds threshold of ${MAX_CONTEXT_CHARS_BEFORE_SUMMARIZATION}. Attempting summarization...`);

  const summarizationPrompt = `The original user task is: '${originalTask}'.
The following is a history of actions taken and information gathered so far (it might be condensed or summarized itself already):
---
${currentContext}
---
Summarize this history VERY concisely. Extract only the most critical facts, outcomes, and insights that are directly relevant for informing the NEXT step in achieving the original user task. The summary MUST be significantly shorter than the history provided. Focus on essential information that prevents loss of crucial context for future actions. Avoid conversational fluff.`;

  try {
    // callGeminiFunc is expected to throw an error on failure (e.g., timeout or API error)
    const summaryResponse = await callGeminiFunc(summarizationPrompt);

    // Since callGeminiFunc throws on error, we only proceed if it returns a string successfully.
    // No need to check for "Error:" prefix in summaryResponse if callGeminiFunc adheres to its contract.
    console.log("Context successfully summarized.");
    return SUMMARIZED_CONTEXT_PREFIX + summaryResponse;

  } catch (error) {
    console.error("Exception during context summarization call:", error.message);
    // If summarization fails (timeout, API error from callGeminiFunc), return the original context.
    // A more robust fallback could be to truncate the original context here if it's excessively long,
    // e.g., currentContext.substring(0, MAX_CONTEXT_CHARS_BEFORE_SUMMARIZATION) + "... (summary failed, context truncated)";
    // For now, returning original context on summarization failure.
    console.warn("Context summarization failed. Using original context (which might be very long).");
    return currentContext;
  }
}

// --- Tool Definition: CalculatorTool ---
class CalculatorTool {
  async execute(inputObject) {
    if (!inputObject || typeof inputObject.expression !== 'string' || !inputObject.expression.trim()) {
      return { result: null, error: "Invalid input: expression string is required for CalculatorTool." };
    }

    try {
      const calculationResult = math.evaluate(inputObject.expression);

      // Check if the result is a function (e.g., from defining a function like 'f(x) = x^2')
      // or if it's an object that might not be directly usable as a simple "result" (e.g. a matrix)
      // For now, we'll specifically check for functions. More complex objects might need specific handling if encountered.
      if (typeof calculationResult === 'function') {
        return { result: null, error: "Calculation error: Expression resulted in a function, not a direct value. Please provide a calculable expression that yields a number, string, or boolean." };
      }

      // Ensure the result is stringified for consistent output.
      return { result: String(calculationResult), error: null };
    } catch (e) {
      console.error(`CalculatorTool error for expression "${inputObject.expression}":`, e.message);
      return { result: null, error: "Calculation error: " + e.message };
    }
  }
}

// --- Tool Definition: WebSearchTool ---
class WebSearchTool {
  constructor() {
    this.apiKey = process.env.SEARCH_API_KEY;
    this.cseId = process.env.CSE_ID;

    if (!this.apiKey || !this.cseId) {
      console.warn("WebSearchTool: SEARCH_API_KEY or CSE_ID environment variable is missing. Web searches will fail.");
    }
  }

  async execute({ query }) { // Destructure query from input object
    if (!this.apiKey || !this.cseId) {
      return { result: null, error: "WebSearchTool is not configured due to missing API key or CSE ID." };
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
        return { result: null, error: "Invalid input: query string is required for WebSearchTool." };
    }

    const searchUrl = 'https://www.googleapis.com/customsearch/v1';
    const params = {
      key: this.apiKey,
      cx: this.cseId,
      q: query,
      num: 5 // Get up to 5 results
    };

    try {
      const response = await axios.get(searchUrl, { params: params, timeout: 8000 }); // Added timeout: 8000ms

      if (response.data && response.data.items && response.data.items.length > 0) {
        const formattedResults = response.data.items
          .map(item => `Title: ${item.title}\nSnippet: ${item.snippet}\n\n`)
          .join('');
        return { result: formattedResults.trim(), error: null };
      } else if (response.data && response.data.error) {
        console.error('Google Search API Error:', response.data.error);
        return { result: null, error: `Google Search API Error: ${response.data.error.message || 'Unknown API error'}` };
      } else {
        return { result: "No search results found.", error: null };
      }
    } catch (error) {
      console.error('Error fetching web search results:', error.message);
      if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) {
        return { result: null, error: "Web search request timed out after 8 seconds." };
      } else if (error.response && error.response.data && error.response.data.error) {
        // Handle errors returned by the Google API itself (e.g., bad API key, quota exceeded)
        return { result: null, error: `Google Search API Error: ${error.response.data.error.message || 'Failed to fetch search results due to API error'}` };
      }
      return { result: null, error: `Failed to fetch search results: ${error.message}` };
    }
  }
}

// --- Tool Definition: ReadWebpageTool ---
class ReadWebpageTool {
  async execute(inputObject) {
    if (!inputObject || typeof inputObject.url !== 'string' || !inputObject.url.trim()) {
      return { result: null, error: "Invalid input: URL string is required for ReadWebpageTool." };
    }

    const url = inputObject.url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { result: null, error: "Invalid URL format. Must start with http:// or https://" };
    }

    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' // More specific accept header
      };
      const response = await axios.get(url, { headers: headers, timeout: 10000 });

      const contentType = response.headers['content-type'];
      if (!contentType || (!contentType.includes('text/html') && !contentType.includes('text/plain'))) {
        return { result: null, error: `Content is not HTML or plain text. Received: ${contentType || "unknown"}` };
      }

      let htmlContent = response.data;
      if (typeof htmlContent !== 'string') {
        // Try to decode if it's a buffer (e.g. from text/plain)
        try {
          htmlContent = Buffer.from(htmlContent).toString('utf-8');
        } catch (bufferError) {
          return { result: null, error: "Could not convert fetched content to string."};
        }
      }

      const MAX_CONTENT_LENGTH = 1000000; // 1MB
      if (htmlContent.length > MAX_CONTENT_LENGTH) {
        console.warn(`Content from ${url} exceeded ${MAX_CONTENT_LENGTH} chars, truncating.`);
        htmlContent = htmlContent.substring(0, MAX_CONTENT_LENGTH);
      }

      let extractedText = htmlContent;
      // Remove script tags and content
      extractedText = extractedText.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
      // Remove style tags and content
      extractedText = extractedText.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
      // Remove HTML comments
      extractedText = extractedText.replace(/<!--[\s\S]*?-->/g, ' ');
      // Remove all other HTML tags (replace with a space)
      extractedText = extractedText.replace(/<[^>]+>/g, ' ');

      // HTML entity decoding would ideally be here with he.decode(extractedText);
      // Since 'he' could not be installed, entities will remain.

      // Clean Whitespace: replace multiple whitespace characters with a single space
      extractedText = extractedText.replace(/\s+/g, ' ').trim();

      if (extractedText.length < 50) {
        return { result: "Could not extract significant textual content from the URL.", error: null };
      }

      return { result: extractedText, error: null };

    } catch (error) {
      console.error(`Error fetching or processing URL "${url}":`, error.message);
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        return { result: null, error: `Failed to fetch URL: Server responded with status ${error.response.status} - ${error.response.statusText}` };
      } else if (error.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        let errorMessage = "Failed to fetch URL: No response received from server.";
        if (error.code === 'ECONNABORTED') {
          errorMessage = "Failed to fetch URL: Request timed out after 10 seconds.";
        } else if (error.message) {
          errorMessage += ` Details: ${error.message}`;
        }
        return { result: null, error: errorMessage };
      } else {
        // Something happened in setting up the request that triggered an Error
        return { result: null, error: `Failed to fetch URL: ${error.message}` };
      }
    }
  }
}


// Middleware to parse JSON bodies and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the root directory (e.g., style.css)
app.use(express.static(__dirname));

// GET endpoint to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Temporary GET route to test Gemini
app.get('/test-gemini', async (req, res) => {
  if (!genAI) {
    return res.status(500).send("Gemini API client not initialized. Check API key.");
  }
  const prompt = "Explain what a large language model is in one sentence.";
  try {
    const geminiResponse = await callGemini(prompt);
    res.send(geminiResponse);
  } catch (error) {
    // callGemini now throws, so catch it here
    res.status(500).send(`Error calling Gemini: ${error.message}`);
  }
});

// --- Function to parse and validate plan response from Gemini ---
async function parseStagedPlanResponse(planResponseString, knownToolNames) {
  let rawResponseForError = planResponseString; // Keep original for error reporting if cleaning fails
  try {
    let cleanedPlanResponseString = planResponseString.trim();
    if (cleanedPlanResponseString.startsWith('```json')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(7).trim();
    } else if (cleanedPlanResponseString.startsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(3).trim();
    }
    if (cleanedPlanResponseString.endsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.slice(0, -3).trim();
    }
    rawResponseForError = cleanedPlanResponseString; // Now refers to the cleaned string

    const parsedPlanStages = JSON.parse(cleanedPlanResponseString);

    if (!Array.isArray(parsedPlanStages) || parsedPlanStages.length === 0) {
      console.error("Gemini generated an empty or non-array plan (expected array of stages):", cleanedPlanResponseString);
      return { success: false, message: "Generated plan is empty or not an array of stages.", details: "Gemini returned an empty or non-array plan.", rawResponse: cleanedPlanResponseString };
    }

    for (const stageObj of parsedPlanStages) {
      if (typeof stageObj !== 'object' || stageObj === null ||
          typeof stageObj.stage !== 'number' ||
          !Array.isArray(stageObj.steps) || stageObj.steps.length === 0) {
        console.error("Invalid stage structure in plan:", stageObj, "Full plan:", cleanedPlanResponseString);
        return { success: false, message: "Generated plan contains an invalid stage structure.", details: "Each stage must be an object with a numeric 'stage' and a non-empty 'steps' array.", rawResponse: cleanedPlanResponseString };
      }

      for (const step of stageObj.steps) {
        if (typeof step !== 'object' || step === null ||
            typeof step.stepDescription !== 'string' || !step.stepDescription.trim() ||
            typeof step.toolName !== 'string' || !step.toolName.trim()) {
          console.error("Invalid step structure within a stage:", step, "Stage:", stageObj.stage, "Full plan:", cleanedPlanResponseString);
          return { success: false, message: "Generated plan contains invalid step structures within a stage.", details: "Each step must be an object with non-empty 'stepDescription' and 'toolName' strings.", rawResponse: cleanedPlanResponseString };
        }
        if (!knownToolNames.includes(step.toolName)) {
          console.warn("Plan contains a step with an unknown toolName:", step.toolName, "Step:", step);
          // Not returning error for unknown tool, execution loop will handle it.
        }
      }
    }
    return { success: true, planStagesArray: parsedPlanStages, rawResponse: null };

  } catch (error) { // Catches JSON.parse error or errors from string manipulation
    console.error("Error parsing staged plan response:", error.message, "Raw response for parsing:", rawResponseForError);
    return { success: false, message: "Failed to parse plan from Gemini's response.", details: error.message, rawResponse: rawResponseForError };
  }
}

// --- Helper Function 1: Generate Plan ---
async function generatePlanWithGemini(userTask, callGeminiFunc) {
  const tools = [
    { name: "GeminiStepExecutor", description: "Useful for general reasoning, text generation, complex instructions, or when no other specific tool seems appropriate." },
    { name: "WebSearchTool", description: "Useful for finding specific, real-time information or facts from the web. Input should be a search query." },
    { name: "CalculatorTool", description: "Useful for evaluating mathematical expressions. Input should be a valid mathematical expression string (e.g., '2+2', 'sqrt(16)', '10 meters to cm')." },
    { name: "ReadWebpageTool", description: "Fetches and extracts the main textual content from a given web URL. The stepDescription for this tool must be a valid URL string (e.g., 'https://example.com/article')." }
  ];
  const toolNames = tools.map(t => t.name);

  const toolsDescriptionString = tools.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`).join("\n        ");
  const toolNamesArrayStringified = toolNames.map(name => `"${name}"`).join(", ");

  const planningPrompt = `User task: '${userTask}'.
You have the following tools available:
        ${toolsDescriptionString}

Break this down into a JSON array of 'stages' to achieve the task. Each stage object in the array must have two keys:
1. 'stage': An integer representing the stage number (e.g., 1, 2, 3...).
2. 'steps': An array of one or more step objects.
Each step object within a stage's 'steps' array must have two keys:
1. 'stepDescription': A string describing the action for that step.
2. 'toolName': A string indicating which tool to use (must be exactly one of [${toolNamesArrayStringified}]).

Steps within the same stage are considered parallelizable if the task allows. Subsequent stages depend on the completion of all steps in the preceding stage.
The overall plan should be logically sequenced by stage. Ensure the output is only the JSON array of stages.

Example for a task like 'Research impacts of remote work and summarize findings':
[
  {
    "stage": 1,
    "steps": [
      { "stepDescription": "Search for articles on productivity in remote work", "toolName": "WebSearchTool" },
      { "stepDescription": "Search for articles on team collaboration in remote work", "toolName": "WebSearchTool" }
    ]
  },
  {
    "stage": 2,
    "steps": [
      { "stepDescription": "Based on all search results, identify 3 key positive and 3 key negative impacts of remote work.", "toolName": "GeminiStepExecutor" }
    ]
  },
  {
    "stage": 3,
    "steps": [
      { "stepDescription": "Draft a concise summary of the identified impacts.", "toolName": "GeminiStepExecutor" }
    ]
  }
]`;

  let planResponseString = ""; // For rawResponse in case callGeminiFunc itself fails before returning a string
  try {
    planResponseString = await callGeminiFunc(planningPrompt);
    // Now, use the dedicated parsing and validation function
    const parseResult = await parseStagedPlanResponse(planResponseString, toolNames);
    if (parseResult.success) {
      return { success: true, plan: parseResult.planStagesArray, rawResponse: null }; // Changed 'plan' to 'planStagesArray' for clarity if needed, but keeping 'plan' for consistency with how it's used.
    } else {
      return { success: false, message: parseResult.message, details: parseResult.details, rawResponse: parseResult.rawResponse };
    }
  } catch (error) { // Catches errors from callGeminiFunc (e.g. timeout, direct API error not returning a string)
    console.error("Error in generatePlanWithGemini (API call stage):", error.message);
    const message = error.message.includes("Gemini API call timed out") ? "Failed to generate plan: Gemini API call timed out." : "Failed to generate plan due to an API error.";
    return {
      success: false,
      message: message,
      details: error.message,
      rawResponse: planResponseString // This might be empty if timeout occurred before Gemini responded
    };
  }
}

// --- Tool Definition: GeminiStepExecutorTool ---
class GeminiStepExecutorTool {
  constructor(callGeminiFunction) {
    this.callGemini = callGeminiFunction;
  }

  async execute(originalTask, stepDescription, contextSummary) {
    const executionPrompt = `Original task: '${originalTask}'.\n\nContext from previous completed steps:\n${contextSummary}\nConsidering the 'Original task' and the 'Context from previous completed steps', provide a concise output for successfully completing the current step: '${stepDescription}'. Focus only on the output for this specific step.`;

    try {
      const stepResultText = await this.callGemini(executionPrompt);
      return { result: stepResultText, error: null };
    } catch (error) {
      console.error(`Error executing step ("${stepDescription}") with GeminiStepExecutorTool:`, error);
      // Ensure the error message is propagated; callGemini now throws an Error object.
      return { result: null, error: error.message || "Unknown error during step execution." };
    }
  }
}

// --- Actual handleReplanning function (Two-Stage Recovery) ---
async function handleReplanning(originalTask, originalPlanStagesArray, executionLogSoFar, failedStepDetails, callGeminiFunc, availableToolsMap) {
  const currentToolNames = Object.keys(availableToolsMap);
  const toolDefinitions = currentToolNames.map(name => {
    let description = "A general-purpose tool.";
    if (name === "GeminiStepExecutor") description = "Useful for general reasoning, text generation, complex instructions, or when no other specific tool seems appropriate.";
    else if (name === "WebSearchTool") description = "Useful for finding specific, real-time information or facts from the web. Input should be a search query.";
    else if (name === "CalculatorTool") description = "Useful for evaluating mathematical expressions. Input should be a valid mathematical expression string (e.g., '2+2', 'sqrt(16)', '10 meters to cm').";
    return { name, description };
  });
  const toolsDescriptionString = toolDefinitions.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`).join("\n        ");
  const toolNamesArrayStringified = currentToolNames.map(name => `"${name}"`).join(", ");
  const recentLogEntries = executionLogSoFar.slice(-3); // Last 3 entries for context

  // Stage 1: Attempt Focused Step Fix
  const fixPrompt = `You are an AI assistant. The user wants to achieve: '${originalTask}'.
A previous plan execution failed. Here's the context:
Failed Step Details:
  Stage: ${failedStepDetails.stage}
  Description: "${failedStepDetails.stepDescription}"
  Tool Used: ${failedStepDetails.toolName}
  Error: "${failedStepDetails.error}"
Recent Execution History (last few steps):
${JSON.stringify(recentLogEntries, null, 2)}

Available Tools:
        ${toolsDescriptionString}

Suggest a short replacement plan segment (e.g., 1 stage with 1-2 steps, in the standard JSON stage/step format described below) to specifically overcome or work around the described failure. The goal is to fix or replace *only* the failed step or its immediate blocker, allowing the original plan to potentially resume.
If a direct fix for this step is not possible or requires more than 2 steps, return an empty JSON array \`[]\`.

Output Format (JSON array of stages):
Each stage object must have 'stage' (integer, starting from 1 for this segment) and 'steps' (array of step objects). Each step object must have 'stepDescription' (string) and 'toolName' (string from [${toolNamesArrayStringified}]).
Ensure the output is *only* the JSON array.`;

  let fixAttemptResponseString = "";
  try {
    console.log("Attempting focused step fix with prompt:", fixPrompt);
    fixAttemptResponseString = await callGeminiFunc(fixPrompt);
    const parsedFixResult = await parseStagedPlanResponse(fixAttemptResponseString, currentToolNames);

    if (parsedFixResult.success) {
      if (parsedFixResult.planStagesArray.length > 0) {
        const totalStepsInFix = parsedFixResult.planStagesArray.reduce((sum, stage) => sum + stage.steps.length, 0);
        if (totalStepsInFix > 0 && totalStepsInFix <= 2) {
          console.log("Focused step fix successful, new plan segment generated:", JSON.stringify(parsedFixResult.planStagesArray, null, 2));
          return { success: true, recoveryType: "FIX", planSegment: parsedFixResult.planStagesArray };
        } else {
          console.log("Focused step fix proposed a plan segment that was too long or empty, proceeding to full replan. Fix steps:", totalStepsInFix);
        }
      } else {
        console.log("Focused step fix returned an empty plan, proceeding to full replan.");
      }
    } else {
      console.warn("Failed to parse focused step fix response, proceeding to full replan. Error:", parsedFixResult.message, "Raw:", parsedFixResult.rawResponse);
    }
  } catch (error) {
    console.warn("Error during focused step fix API call, proceeding to full replan:", error.message);
    // Proceed to full replan if fix attempt itself errors out (e.g. timeout)
  }

  // Stage 2: Fallback to Full Replan
  console.log("Focused step fix failed or was not feasible, attempting full replan.");
  const fullReplanPrompt = `You are an AI assistant helping a user achieve a task.
Original user task: '${originalTask}'

The initial plan you (or another AI) devised was:
${JSON.stringify(originalPlanStagesArray, null, 2)}

So far, the following steps were executed, with their outcomes (showing recent history):
${JSON.stringify(recentLogEntries, null, 2)}

Unfortunately, a step failed:
Stage: ${failedStepDetails.stage}
Step Description: ${failedStepDetails.stepDescription}
Tool Used: ${failedStepDetails.toolName}
Error Message: ${failedStepDetails.error}

Please generate a new, complete plan as a JSON array of 'stages' to achieve the original user task, taking into account the failure. Try to use a different approach for the failed step or around the obstacle.
You have the following tools available:
        ${toolsDescriptionString}

Each stage object in the array must have 'stage' (integer, starting from 1 for the new plan segment) and 'steps' (array of step objects). Each step object must have 'stepDescription' (string) and 'toolName' (string from [${toolNamesArrayStringified}]).
Ensure the output is only the JSON array of stages. The new plan should ideally start from a point that makes sense given the successful execution history, or be a full new plan if necessary. The stage numbering for the new plan should restart from 1.`;

  let fullReplanResponseString = "";
  try {
    console.log("Attempting full replan with prompt:", fullReplanPrompt);
    fullReplanResponseString = await callGeminiFunc(fullReplanPrompt);
    const parsedFullReplanResult = await parseStagedPlanResponse(fullReplanResponseString, currentToolNames);

    if (parsedFullReplanResult.success && parsedFullReplanResult.planStagesArray.length > 0) {
      console.log("Full replanning successful, new plan generated:", JSON.stringify(parsedFullReplanResult.planStagesArray, null, 2));
      return { success: true, recoveryType: "FULL_REPLAN", planSegment: parsedFullReplanResult.planStagesArray };
    } else {
      const errorMessage = parsedFullReplanResult.success ? "Full replan resulted in an empty plan." : parsedFullReplanResult.message;
      console.error("Full replanning failed:", errorMessage, parsedFullReplanResult.details, "Raw response:", parsedFullReplanResult.rawResponse);
      return { success: false, error: errorMessage || "Full replanning failed to generate a valid plan.", recoveryType: "NONE", newPlanStagesArray: [], details: parsedFullReplanResult.details, rawResponse: parsedFullReplanResult.rawResponse };
    }
  } catch (error) { // Catches errors from callGeminiFunc (e.g. timeout)
    console.error("Error during full replanning API call:", error.message);
    const message = error.message.includes("Gemini API call timed out") ? "Full replanning failed: Gemini API call timed out." : "Full replanning failed due to an API error.";
    return { success: false, error: message, recoveryType: "NONE", newPlanStagesArray: [], details: error.message, rawResponse: fullReplanResponseString };
  }
}

// --- Helper Function: Execute Plan Loop (with staged parallel execution and replanning) ---
async function executePlanLoop(userTask, planStagesArray, callGeminiFunc, replanningAttempted = false, initialContextSummary = null) {
  const overallExecutionLog = [];
  let contextSummaryForNextStep = initialContextSummary !== null ? initialContextSummary : "No previous steps executed yet.\n\n";
  let allOriginalStagesCompleted = true; // Assume success until a failure occurs and is not recovered

  // Summarize initial context if needed
  const originalInitialContext = contextSummaryForNextStep;
  contextSummaryForNextStep = await summarizeContextIfNeeded(contextSummaryForNextStep, userTask, callGeminiFunc);
  if (contextSummaryForNextStep !== originalInitialContext && contextSummaryForNextStep.startsWith(SUMMARIZED_CONTEXT_PREFIX)) {
    overallExecutionLog.push({ stage: "Initial", step: "Context Management", tool: "System", result: "Initial context was summarized.", status: "system_action" });
  }

  const geminiExecutor = new GeminiStepExecutorTool(callGeminiFunc);
  const webSearchTool = new WebSearchTool();
  const calculatorTool = new CalculatorTool();
  const readWebpageTool = new ReadWebpageTool(); // Instantiate ReadWebpageTool
  const availableTools = {
    "GeminiStepExecutor": geminiExecutor,
    "WebSearchTool": webSearchTool,
    "CalculatorTool": calculatorTool,
    "ReadWebpageTool": readWebpageTool // Add ReadWebpageTool to available tools
  };

  for (let stageIndex = 0; stageIndex < planStagesArray.length; stageIndex++) {
    const stageObj = planStagesArray[stageIndex];
    const currentStageNumber = stageObj.stage;
    const stepsInStage = stageObj.steps;
    let stageFailed = false;
    const contextBeforeThisStage = contextSummaryForNextStep;

    if (!Array.isArray(stepsInStage) || stepsInStage.length === 0) {
      console.warn(`Stage ${currentStageNumber} has no steps or invalid steps array. Skipping.`);
      overallExecutionLog.push({ stage: currentStageNumber, step: "Stage Validation", tool: "System", status: "skipped", error: "Stage has no steps or invalid steps array." });
      continue;
    }

    const stepPromises = stepsInStage.map(async (planStep) => {
      const stepDescription = planStep.stepDescription;
      const toolName = planStep.toolName;
      if (typeof stepDescription !== 'string' || !stepDescription.trim() || typeof toolName !== 'string' || !toolName.trim()) {
        return { originalStep: { stepDescription: String(stepDescription || "Invalid step"), toolName: String(toolName || "N/A") }, outcome: { error: "Invalid step object structure." }, success: false };
      }
      const selectedTool = availableTools[toolName];
      if (!selectedTool) {
        return { originalStep: planStep, outcome: { error: `Unknown tool specified: ${toolName}` }, success: false };
      }
      try {
        let currentStepOutcome;
        if (toolName === "GeminiStepExecutor") currentStepOutcome = await selectedTool.execute(userTask, stepDescription, contextSummaryForNextStep);
        else if (toolName === "WebSearchTool") currentStepOutcome = await selectedTool.execute({ query: stepDescription });
        else if (toolName === "CalculatorTool") currentStepOutcome = await selectedTool.execute({ expression: stepDescription });
        else if (toolName === "ReadWebpageTool") currentStepOutcome = await selectedTool.execute({ url: stepDescription });
        else currentStepOutcome = { result: null, error: `Unhandled tool: ${toolName}` };
        return { originalStep: planStep, outcome: currentStepOutcome, success: !currentStepOutcome.error };
      } catch (toolError) {
        return { originalStep: planStep, outcome: { error: toolError.message || "Tool execution error." }, success: false };
      }
    });

    const stageStepResults = await Promise.all(stepPromises);
    let stageContextAccumulator = "";

    for (const stepResult of stageStepResults) {
      const { originalStep, outcome, success } = stepResult;
      overallExecutionLog.push({ stage: currentStageNumber, step: originalStep.stepDescription, tool: originalStep.toolName, status: success ? "completed" : "failed", result: success ? outcome.result : null, error: success ? null : outcome.error });
      if (success) {
        stageContextAccumulator += `Result from Stage ${currentStageNumber}, Step "${originalStep.stepDescription}" (using ${originalStep.toolName}): ${outcome.result}\n\n`;
      } else {
        stageFailed = true;
      }
    }

    if (stageContextAccumulator) {
      contextSummaryForNextStep += stageContextAccumulator;
    }

    // Summarize context after this stage if it didn't fail and cause a break
    if (!stageFailed) {
      const contextBeforeStageSummarization = contextSummaryForNextStep;
      contextSummaryForNextStep = await summarizeContextIfNeeded(contextSummaryForNextStep, userTask, callGeminiFunc);
      if (contextSummaryForNextStep !== contextBeforeStageSummarization && contextSummaryForNextStep.startsWith(SUMMARIZED_CONTEXT_PREFIX)) {
          overallExecutionLog.push({
              stage: currentStageNumber,
              step: "Context Management",
              tool: "System",
              result: `Context summarized after Stage ${currentStageNumber}.`,
              status: "system_action"
          });
      }
    }

    if (stageFailed) {
      allOriginalStagesCompleted = false; // Current plan segment failed
      console.log(`Stage ${currentStageNumber} failed.`);
      if (replanningAttempted) {
        overallExecutionLog.push({ stage: currentStageNumber, step: "Replanning Halted", tool: "System", error: "Previous replanning attempt or its execution failed.", status: "system_error" });
        break;
      } else {
        const firstFailedStep = stageStepResults.find(r => !r.success);
        const failedStepDetails = { stage: currentStageNumber, stepDescription: firstFailedStep.originalStep.stepDescription, toolName: firstFailedStep.originalStep.toolName, error: firstFailedStep.outcome.error };
        overallExecutionLog.push({ stage: currentStageNumber, step: "Replanning Triggered", tool: "System", result: `Attempting to replan due to failure in step: '${failedStepDetails.stepDescription}'. Error: ${failedStepDetails.error}`, status: "system_action" });

        const recoveryOutcome = await handleReplanning(userTask, planStagesArray /* original full plan for context */, overallExecutionLog, failedStepDetails, callGeminiFunc, availableTools);

        if (recoveryOutcome.success && recoveryOutcome.planSegment && recoveryOutcome.planSegment.length > 0) {
          overallExecutionLog.push({ stage: currentStageNumber, step: `Replanning Attempt Succeeded (${recoveryOutcome.recoveryType})`, tool: "System", result: "New plan segment generated. Attempting execution.", status: "system_action" });

          let recoveryExecutionResult;
          if (recoveryOutcome.recoveryType === "FIX") {
            overallExecutionLog.push({ stage: currentStageNumber, step: "Executing Step Fix", tool: "System", result: `Attempting to execute ${recoveryOutcome.planSegment.length} stage(s) as a fix.`, status: "system_action" });
            recoveryExecutionResult = await executePlanLoop(userTask, recoveryOutcome.planSegment, callGeminiFunc, true, contextBeforeThisStage);
            overallExecutionLog.push(...recoveryExecutionResult.log);
            contextSummaryForNextStep = recoveryExecutionResult.finalContext; // Update context from the recovery

            if (recoveryExecutionResult.allStepsCompletedSuccessfully) {
              const originalPlanRemainder = planStagesArray.slice(stageIndex + 1);
              if (originalPlanRemainder.length > 0) {
                overallExecutionLog.push({ stage: currentStageNumber, step: "Step Fix Successful", tool: "System", result: "Attempting to resume original plan.", status: "system_action" });
                // Context for remainder is the one from the successful fix
                const remainderExecutionResult = await executePlanLoop(userTask, originalPlanRemainder, callGeminiFunc, true, contextSummaryForNextStep);
                overallExecutionLog.push(...remainderExecutionResult.log);
                contextSummaryForNextStep = remainderExecutionResult.finalContext;
                allOriginalStagesCompleted = remainderExecutionResult.allStepsCompletedSuccessfully;
              } else {
                allOriginalStagesCompleted = true;
              }
            } else {
              overallExecutionLog.push({ stage: currentStageNumber, step: "Step Fix Failed", tool: "System", error: "The implemented fix also failed.", status: "system_error" });
              allOriginalStagesCompleted = false;
            }
          } else if (recoveryOutcome.recoveryType === "FULL_REPLAN") {
            overallExecutionLog.push({ stage: currentStageNumber, step: "Executing Full Replan", tool: "System", result: `Attempting to execute new ${recoveryOutcome.planSegment.length}-stage plan.`, status: "system_action" });
            recoveryExecutionResult = await executePlanLoop(userTask, recoveryOutcome.planSegment, callGeminiFunc, true, contextBeforeThisStage);
            overallExecutionLog.push(...recoveryExecutionResult.log);
            contextSummaryForNextStep = recoveryExecutionResult.finalContext;
            allOriginalStagesCompleted = recoveryExecutionResult.allStepsCompletedSuccessfully;
          }
        } else {
          overallExecutionLog.push({ stage: currentStageNumber, step: "Replanning Failed (System)", tool: "System", error: recoveryOutcome.error || "No recovery plan generated.", status: "system_error" });
          allOriginalStagesCompleted = false;
        }
        break;
      }
    }
  }
  return { log: overallExecutionLog, finalContext: contextSummaryForNextStep, allStepsCompletedSuccessfully: allOriginalStagesCompleted };
}

// --- Main API Endpoint ---
app.post('/api/generate-plan', async (req, res) => {
  const userTask = req.body.task;
  if (!userTask) {
    return res.status(400).json({ message: "Task is required in the request body.", context: { originalTask: userTask || null } });
  }
  if (!genAI) {
    return res.status(500).json({ message: "API client not initialized.", details: "Server configuration issue: GEMINI_API_KEY may be missing.", context: { originalTask: userTask } });
  }

  try {
    const planResult = await generatePlanWithGemini(userTask, callGemini);

    if (!planResult.success) { // Check the success flag
      return res.status(500).json({
        message: planResult.message || "Failed to generate plan.", // Use message from planResult
        details: planResult.details,
        context: { originalTask: userTask, rawResponse: planResult.rawResponse }
      });
    }
    const planArray = planResult.plan;

    // Call executePlanLoop and get the structured response
    const executionResult = await executePlanLoop(userTask, planArray, callGemini);

    res.json({
      originalTask: userTask,
      plan: planArray, // This is the initial plan; executionLog might contain info about new plans
      executionLog: executionResult.log, // The comprehensive log
      // Optionally, include overall success status and final context if useful for client
      // allStepsCompletedSuccessfully: executionResult.allStepsCompletedSuccessfully,
      // finalContextSummary: executionResult.finalContext
    });

  } catch (unexpectedError) {
    console.error("Unexpected error in /api/generate-plan route handler:", unexpectedError);
    res.status(500).json({ message: "An unexpected server error occurred.", details: unexpectedError.message, context: { originalTask: userTask } });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
