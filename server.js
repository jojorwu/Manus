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
    return "Error: Gemini API key not configured or client not initialized.";
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(promptString);
    const response = await result.response;
    const text = response.text();
    return text;
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return `Error generating content: ${error.message}`;
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
    res.status(500).send(`Error calling Gemini: ${error.message}`);
  }
});

// POST endpoint for generating a plan
app.post('/api/generate-plan', async (req, res) => {
  const userTask = req.body.task;
  if (!userTask) {
    return res.status(400).json({ error: "Task is required" });
  }

  if (!genAI) {
    return res.status(500).json({ error: "Gemini API client not initialized. Check API key." });
  }

  // Refined Planning Prompt
  const planningPrompt = `User task: '${userTask}'. Break this down into a JSON array of short, actionable, and logically sequenced steps to achieve the task. The steps should be granular enough to be executed one by one. The output should be only the JSON array. For example, for 'Research the history of the internet', steps might be: ["Define scope of research", "Identify key milestones", "Find primary sources for early development", "Summarize findings into a timeline"].`;

  try {
    // Planning stage (first Gemini call)
    const planResponseString = await callGemini(planningPrompt); // Use refined planningPrompt
    let cleanedPlanResponseString = planResponseString.trim();
    if (cleanedPlanResponseString.startsWith('```json')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(7).trim();
    } else if (cleanedPlanResponseString.startsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(3).trim();
    }
    if (cleanedPlanResponseString.endsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.slice(0, -3).trim();
    }

    let planArray;
    try {
      planArray = JSON.parse(cleanedPlanResponseString);
      } catch (parseError) {
        console.error("Error parsing Gemini response for plan:", parseError, "Raw response:", cleanedPlanResponseString);
        return res.status(500).json({ error: "Failed to parse plan from Gemini.", details: parseError.message, rawResponse: cleanedPlanResponseString, originalTask: userTask });
      }

      if (!Array.isArray(planArray) || planArray.length === 0) {
        console.error("Gemini generated an empty or invalid plan:", cleanedPlanResponseString);
        return res.status(500).json({ error: "Failed to generate a valid plan.", details: "Gemini returned an empty or invalid plan.", rawResponse: cleanedPlanResponseString, originalTask: userTask });
      }

      // Execution Loop Stage (New)
      const executionLog = [];
      let contextSummaryForNextStep = "No previous steps executed yet.\n\n"; // Initial context

      for (const stepDescription of planArray) {
        if (typeof stepDescription !== 'string' || !stepDescription.trim()) {
          console.warn("Skipping invalid step in plan:", stepDescription);
          executionLog.push({ step: String(stepDescription), error: "Invalid step description in plan.", status: "skipped" });
          continue;
        }

        // Ensure contextSummaryForNextStep does not grow excessively (optional simple check)
        // For this subtask, we'll keep it simple and not truncate aggressively.
        // A more advanced solution might summarize if it exceeds a token limit.

        // Refined Step Execution Prompt
        const executionPrompt = `Original task: '${userTask}'.\n\nContext from previous completed steps:\n${contextSummaryForNextStep}\nConsidering the 'Original task' and the 'Context from previous completed steps', provide a concise output for successfully completing the current step: '${stepDescription}'. Focus only on the output for this specific step.`;

        try {
          const stepResultText = await callGemini(executionPrompt);
          executionLog.push({ step: stepDescription, result: stepResultText, status: "completed" });
          // Append structured context
          contextSummaryForNextStep += `Summary of step "${stepDescription}": ${stepResultText}\n\n`;
        } catch (stepError) {
          console.error(`Error calling callGemini for step execution ('${stepDescription}'):`, stepError);
          executionLog.push({ step: stepDescription, error: stepError.message || "Unknown error during step execution.", status: "failed" });
          break; // Terminate loop on first failure
        }
      }

      res.json({
        originalTask: userTask,
        plan: planArray,
        executionLog: executionLog
      });

    } catch (planningError) { // Catches errors from the first callGemini (planning) or initial parsing
      console.error("Error in planning stage of /api/generate-plan:", planningError);
      res.status(500).json({ error: "Failed to generate plan due to an internal error.", details: planningError.message, originalTask: userTask });
    }
  } catch (initialError) { // Catches errors if genAI is not initialized, or userTask is missing
    console.error("Initial error in /api/generate-plan:", initialError);
    res.status(500).json({ error: "Failed to process request due to a setup or configuration issue.", details: initialError.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
