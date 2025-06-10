const taskInput = document.getElementById('taskInput');
const planButton = document.getElementById('planButton');
const statusArea = document.getElementById('statusArea');

planButton.addEventListener('click', async () => {
  const originalTask = taskInput.value; // Store original task
  statusArea.innerHTML = ''; // Clear previous messages

  if (!originalTask.trim()) {
    statusArea.textContent = 'Please enter a task.';
    return;
  }

  // Initial "loading" message
  const loadingP = document.createElement('p');
  // Updated loading message
  loadingP.textContent = 'Processing your task... Generating plan and executing steps.';
  statusArea.appendChild(loadingP);

  try {
    const response = await fetch('/api/generate-plan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // Ensure 'originalTask' is used here, not 'task' if that was a typo from previous steps
      body: JSON.stringify({ task: originalTask }),
    });

    // Removed duplicated line here
    const result = await response.json(); // Expect { originalTask, plan, executionLog }
    statusArea.innerHTML = ''; // Clear loading message

    // --- Display Original Task ---
    const taskHeading = document.createElement('h3');
    taskHeading.textContent = 'Your Task:';
    statusArea.appendChild(taskHeading);
    const taskP = document.createElement('p');
    // Use result.originalTask from server response if available, otherwise fallback to input
    taskP.textContent = result.originalTask || originalTask;
    statusArea.appendChild(taskP);
    statusArea.appendChild(document.createElement('hr'));

    if (response.ok) {
      // --- Display Generated Plan ---
      const planHeading = document.createElement('h3');
      planHeading.textContent = 'Generated Plan:';
      statusArea.appendChild(planHeading);
      const planOl = document.createElement('ol');
      if (result.plan && Array.isArray(result.plan) && result.plan.length > 0) {
        result.plan.forEach(stepDesc => {
          const li = document.createElement('li');
          li.textContent = stepDesc;
          planOl.appendChild(li);
        });
      } else {
        const p = document.createElement('p');
        p.textContent = 'No plan could be generated or the plan is empty.';
        planOl.appendChild(p); // Append to OL to keep structure, or directly to statusArea
      }
      statusArea.appendChild(planOl);
      statusArea.appendChild(document.createElement('hr'));

      // --- Display Execution Log ---
      const logHeading = document.createElement('h3');
      logHeading.textContent = 'Execution Log:';
      statusArea.appendChild(logHeading);

      const logUl = document.createElement('ul'); // Unordered list for log entries
      logUl.classList.add('execution-log'); // Add class for potential styling

      if (result.executionLog && Array.isArray(result.executionLog) && result.executionLog.length > 0) {
        result.executionLog.forEach(entry => {
          const logLi = document.createElement('li');
          // Display Step Description and Tool Name
          logLi.innerHTML = `<strong>Step:</strong> ${entry.step || 'N/A'} <span class="tool-name">(using tool: ${entry.tool || 'N/A'})</span>`;

          const statusSpan = document.createElement('span');
          statusSpan.classList.add('status', entry.status); // "status completed", "status failed", or "status skipped"
          statusSpan.textContent = ` (${entry.status})`;
          logLi.appendChild(statusSpan);

          if (entry.status === "completed") {
            const resultP = document.createElement('p');
            resultP.classList.add('log-result');
            resultP.textContent = `Result: ${entry.result || 'No specific result.'}`;
            logLi.appendChild(resultP);
          } else if (entry.status === "failed") {
            const errorP = document.createElement('p');
            errorP.classList.add('log-error');
            errorP.textContent = `Error: ${entry.error || 'Unknown error.'}`;
            logLi.appendChild(errorP);
          } else if (entry.status === "skipped") {
             const skippedP = document.createElement('p');
             skippedP.classList.add('log-skipped');
             skippedP.textContent = `Skipped: ${entry.error || 'Step was skipped.'}`;
             logLi.appendChild(skippedP);
          }
          logUl.appendChild(logLi);
        });
      } else {
        const p = document.createElement('p');
        p.textContent = 'No execution log available.';
        logUl.appendChild(p);
      }
      statusArea.appendChild(logUl);

      // Indicate if not all plan steps were executed
      if (result.plan && result.executionLog && result.plan.length > result.executionLog.length) {
        const lastExecutedEntry = result.executionLog[result.executionLog.length - 1];
        if (lastExecutedEntry && lastExecutedEntry.status === 'failed') {
          const noteP = document.createElement('p');
          noteP.style.marginTop = '10px';
          noteP.innerHTML = `<em>Execution stopped after failed step. Subsequent steps in the plan were not attempted.</em>`;
          statusArea.appendChild(noteP);
        }
      }

    } else { // Handle errors from the server (e.g., Gemini API failure during planning)
      const errorHeading = document.createElement('h3');
      errorHeading.textContent = 'Error:';
      errorHeading.classList.add('status', 'failed'); // Use existing class for red color
      statusArea.appendChild(errorHeading);

      const errorP = document.createElement('p');
      errorP.classList.add('status', 'failed');
      errorP.textContent = `${result.error || response.statusText}. ${result.details || ''}`;
      statusArea.appendChild(errorP);

      if (result.rawResponse) {
        console.warn('Problematic raw response from server:', result.rawResponse);
        const rawLabel = document.createElement('p');
        rawLabel.textContent = "Raw server response (see console for details if truncated):";
        statusArea.appendChild(rawLabel);
        const rawPre = document.createElement('pre'); // Changed from rawP to rawPre
        rawPre.textContent = typeof result.rawResponse === 'string' ? result.rawResponse.substring(0, 500) + (result.rawResponse.length > 500 ? "..." : "") : JSON.stringify(result.rawResponse).substring(0,500) + "...";
        statusArea.appendChild(rawPre);
      }
    }
  } catch (error) {
    console.error('Fetch error:', error);
    // Clear statusArea and show a simple error message if fetch itself fails
    statusArea.innerHTML = '';
    const errorP = document.createElement('p');
    errorP.textContent = 'Failed to send request or process response. Check browser console for details.';
    errorP.style.color = 'red';
    statusArea.appendChild(errorP);
  }
});
