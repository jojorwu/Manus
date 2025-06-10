const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Added for Gemini
const app = express();
const port = 3000;

// Initialize GoogleGenerativeAI
const apiKey = process.env.GEMINI_API_KEY;
let genAI;
if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
} else {
  console.warn('GEMINI_API_KEY environment variable not set. Gemini functionality will be disabled.');
}

// Async helper function to call Gemini
async function callGemini(promptString) {
  if (!genAI) {
    // This case should ideally be caught before calling callGemini,
    // but as a safeguard within the function itself:
    throw new Error("Gemini API client not initialized. Check API key.");
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(promptString);
    const response = await result.response;
    const text = response.text();
    return text;
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    // Re-throw or throw a new error to be caught by the caller
    throw new Error(`Error generating content from Gemini: ${error.message}`);
  }
}

// --- Tool Definition: WebSearchSimulatorTool ---
class WebSearchSimulatorTool {
  async execute(inputObject) {
    if (!inputObject || typeof inputObject.query !== 'string') {
      return { result: null, error: "Invalid input: query string is required." };
    }

    const originalQuery = inputObject.query;
    const query = originalQuery.toLowerCase();

    if (query.includes("history of ai") || query.includes("ai history")) {
      return {
        result: "Simulated Search Result: The history of AI dates back to antiquity, with philosophical roots. Modern AI began in the mid-20th century with pioneers like Alan Turing, John McCarthy, and Marvin Minsky. Key milestones include the Dartmouth Workshop, expert systems, machine learning, and deep learning breakthroughs.",
        error: null
      };
    } else if (query.includes("latest ai breakthroughs") || query.includes("recent ai news")) {
      return {
        result: "Simulated Search Result: Recent AI breakthroughs (as of early 2024) include advancements in large language models (LLMs) like GPT-4 and Gemini, generative AI for images and video, and applications in scientific discovery (e.g., protein folding). Ethical considerations and AI safety remain key discussion points.",
        error: null
      };
    } else if (query.includes("what is langgraph")) {
      return {
        result: "Simulated Search Result: LangGraph is a library for building stateful, multi-actor applications with LLMs. It allows developers to define agentic workflows as graphs, where nodes represent computations (often LLM calls or tool uses) and edges represent the flow of state.",
        error: null
      };
    } else {
      return {
        result: `Simulated Search Result: Your query '${originalQuery}' did not match any specific predefined results. This is a simulated search; in a real system, this would search the web.`,
        error: null
      };
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

// --- Helper Function 1: Generate Plan ---
async function generatePlanWithGemini(userTask, callGeminiFunc) {
  const tools = [
    { name: "GeminiStepExecutor", description: "Useful for general reasoning, text generation, complex instructions, or when no other specific tool seems appropriate." },
    { name: "WebSearchSimulator", description: "Useful for finding specific information, facts, or emulating a web search for a query." }
  ];

  const toolsDescriptionString = tools.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`).join("\n        ");
  const toolNamesArrayStringified = tools.map(tool => `"${tool.name}"`).join(", ");

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
      { "stepDescription": "Search for articles on productivity in remote work", "toolName": "WebSearchSimulator" },
      { "stepDescription": "Search for articles on team collaboration in remote work", "toolName": "WebSearchSimulator" }
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
  let rawResponseFromGemini = "";

  try {
    const planResponseString = await callGeminiFunc(planningPrompt);
    rawResponseFromGemini = planResponseString;
    let cleanedPlanResponseString = planResponseString.trim();
    if (cleanedPlanResponseString.startsWith('```json')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(7).trim();
    } else if (cleanedPlanResponseString.startsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(3).trim();
    }
    if (cleanedPlanResponseString.endsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.slice(0, -3).trim();
    }

    const parsedPlanStages = JSON.parse(cleanedPlanResponseString);

    if (!Array.isArray(parsedPlanStages) || parsedPlanStages.length === 0) {
      console.error("Gemini generated an empty or non-array plan (expected array of stages):", cleanedPlanResponseString);
      return { success: false, message: "Generated plan is empty or not an array of stages.", details: "Gemini returned an empty or non-array plan.", rawResponse: cleanedPlanResponseString };
    }

    // Validate structure of each stage and its steps
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
        if (!tools.find(t => t.name === step.toolName)) {
          console.warn("Plan contains a step with an unknown toolName:", step.toolName, "Step:", step);
        }
      }
    }

    return { success: true, plan: parsedPlanStages, rawResponse: null }; // Indicate success

  } catch (error) { // Catches errors from callGeminiFunc or JSON.parse
    console.error("Error in generatePlanWithGemini (staged planning):", error);
    const isParsingError = error instanceof SyntaxError;
    const message = isParsingError ? "Failed to parse tool-aware plan from Gemini." : "Failed to generate tool-aware plan due to an API error.";
    return { success: false, message: message, details: error.message, rawResponse: rawResponseFromGemini };
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

// --- Helper Function: Execute Plan Loop (with staged parallel execution) ---
async function executePlanLoop(userTask, planStagesArray, callGeminiFunc) {
  const overallExecutionLog = [];
  let contextSummaryForNextStep = "No previous steps executed yet.\n\n";

  const geminiExecutor = new GeminiStepExecutorTool(callGeminiFunc);
  const searchSimulator = new WebSearchSimulatorTool();
  const availableTools = {
    "GeminiStepExecutor": geminiExecutor,
    "WebSearchSimulator": searchSimulator
  };

  // Outer loop for stages
  for (const stageObj of planStagesArray) {
    const currentStageNumber = stageObj.stage;
    const stepsInStage = stageObj.steps;
    let stageFailed = false;

    if (!Array.isArray(stepsInStage) || stepsInStage.length === 0) {
      console.warn(`Stage ${currentStageNumber} has no steps or invalid steps array. Skipping.`);
      // Optionally log this as a skipped/empty stage in overallExecutionLog if desired
      continue;
    }

    // 3. Parallel Execution of Steps within a Stage
    const stepPromises = stepsInStage.map(async (planStep) => {
      const stepDescription = planStep.stepDescription;
      const toolName = planStep.toolName;

      // Validate individual planStep structure
      if (typeof stepDescription !== 'string' || !stepDescription.trim() ||
          typeof toolName !== 'string' || !toolName.trim()) {
        console.warn("Skipping invalid plan step object in stage:", planStep);
        return {
          originalStep: { stepDescription: String(stepDescription || "Invalid step"), toolName: String(toolName || "N/A") },
          outcome: { error: "Invalid step object structure. Missing/empty stepDescription or toolName." },
          success: false
        };
      }

      const selectedTool = availableTools[toolName];
      if (!selectedTool) {
        console.error(`Unknown tool specified in plan: ${toolName} for step: "${stepDescription}"`);
        return {
          originalStep: planStep,
          outcome: { error: `Unknown tool specified: ${toolName}` },
          success: false
        };
      }

      let currentStepOutcome;
      try {
        if (toolName === "GeminiStepExecutor") {
          currentStepOutcome = await selectedTool.execute(userTask, stepDescription, contextSummaryForNextStep); // All parallel steps in this stage get same initial context
        } else if (toolName === "WebSearchSimulator") {
          currentStepOutcome = await selectedTool.execute({ query: stepDescription });
        } else {
          currentStepOutcome = { result: null, error: `Tool execution logic not implemented for ${toolName}` };
        }
        return { originalStep: planStep, outcome: currentStepOutcome, success: !currentStepOutcome.error };
      } catch (toolError) {
        console.error(`Error during ${toolName}.execute() for step "${stepDescription}":`, toolError);
        return {
          originalStep: planStep,
          outcome: { error: toolError.message || "An unexpected error occurred during tool execution." },
          success: false
        };
      }
    });

    // Wait for all steps in the current stage to complete (or fail individually)
    const stageStepResults = await Promise.all(stepPromises);

    // 4. Handling Results and Context from Parallel Stage
    let stageContextAccumulator = ""; // Accumulate context from successful steps in this stage

    for (const stepResult of stageStepResults) {
      const { originalStep, outcome, success } = stepResult;
      const logEntry = {
        stage: currentStageNumber,
        step: originalStep.stepDescription,
        tool: originalStep.toolName,
        status: success ? "completed" : "failed",
        result: success ? outcome.result : null,
        error: success ? null : outcome.error,
      };
      overallExecutionLog.push(logEntry);

      if (success) {
        stageContextAccumulator += `Result from Stage ${currentStageNumber}, Step "${originalStep.stepDescription}" (using ${originalStep.toolName}): ${outcome.result}\n\n`;
      } else {
        stageFailed = true;
      }
    }

    // Append all context from this stage to the main context summary *after* all parallel steps are processed
    if (stageContextAccumulator) {
        contextSummaryForNextStep += stageContextAccumulator;
    }

    if (stageFailed) {
      console.log(`Stage ${currentStageNumber} failed. Terminating further plan execution.`);
      break; // Terminate outer loop for stages
    }
  }
  return overallExecutionLog;
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

    const executionLog = await executePlanLoop(userTask, planArray, callGemini);

    res.json({
      originalTask: userTask,
      plan: planArray,
      executionLog: executionLog
    });

  } catch (unexpectedError) {
    console.error("Unexpected error in /api/generate-plan route handler:", unexpectedError);
    res.status(500).json({ message: "An unexpected server error occurred.", details: unexpectedError.message, context: { originalTask: userTask } });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
