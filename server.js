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

  const prompt = `User task: '${userTask}'. Break this down into a JSON array of short, actionable steps. The output should be only the JSON array. For example, for 'Research the history of the internet', steps might be: ["Define scope of research", "Identify key milestones", "Find primary sources for early development", "Summarize findings into a timeline"].`;

  try {
    const geminiResponseString = await callGemini(prompt);

    // Attempt to remove potential markdown backticks and "json" prefix if present
    let cleanedResponseString = geminiResponseString.trim();
    if (cleanedResponseString.startsWith('```json')) {
      cleanedResponseString = cleanedResponseString.substring(7).trim();
    } else if (cleanedResponseString.startsWith('```')) {
      cleanedResponseString = cleanedResponseString.substring(3).trim();
    }
    if (cleanedResponseString.endsWith('```')) {
      cleanedResponseString = cleanedResponseString.slice(0, -3).trim();
    }

    try {
      const planArray = JSON.parse(cleanedResponseString);
      if (Array.isArray(planArray) && planArray.length > 0) {
        const firstStep = planArray[0];
        const executionPrompt = `Regarding the overall user task: '${userTask}', please execute the following step from the plan: '${firstStep}'. Provide a concise text result for completing this specific step. Focus only on the result of this single step.`;

        let firstStepExecutionResult = null;
        let executionError = null;

        try {
          firstStepExecutionResult = await callGemini(executionPrompt);
        } catch (execError) {
          console.error("Error calling callGemini for step execution:", execError);
          executionError = `Failed to execute first step: ${execError.message}`;
        }

        res.json({
          plan: planArray,
          executedStep: firstStep,
          firstStepExecutionResult: firstStepExecutionResult,
          executionError: executionError
        });

      } else if (Array.isArray(planArray) && planArray.length === 0) {
        console.error("Gemini generated an empty plan:", cleanedResponseString);
        res.status(500).json({ error: "Failed to generate a valid plan.", details: "Gemini returned an empty plan.", rawResponse: cleanedResponseString });
      } else {
        console.error("Gemini response was not a JSON array:", cleanedResponseString);
        res.status(500).json({ error: "Failed to generate a valid plan.", details: "Gemini response was not a JSON array.", rawResponse: geminiResponseString });
      }
    } catch (parseError) {
      console.error("Error parsing Gemini response for plan:", parseError, "Raw response:", cleanedResponseString);
      res.status(500).json({ error: "Failed to parse plan from Gemini.", details: parseError.message, rawResponse: cleanedResponseString });
    }
  } catch (error) {
    // This catches errors from the first callGemini (planning)
    console.error("Error calling callGemini in /api/generate-plan for planning:", error);
    res.status(500).json({ error: "Failed to generate plan due to an internal error.", details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
