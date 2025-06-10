import React from 'react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";

function ResultsDisplay({ apiResponse, error }) {
  if (error) {
    return (
      <Alert variant="destructive" className="mt-6">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          {typeof error === 'string' ? error : JSON.stringify(error, null, 2)}
        </AlertDescription>
      </Alert>
    );
  }

  if (!apiResponse) {
    // This case should ideally be handled by App.jsx's conditional rendering
    // (i.e., not rendering this component if there's no apiResponse and no error).
    // However, as a fallback or if App.jsx logic changes:
    return (
        <div className="p-6 border rounded-lg shadow-md bg-card mt-6">
            <h2 className="text-xl font-semibold text-card-foreground mb-3">Agent Output</h2>
            <p className="text-muted-foreground">Submit a task to see the results.</p>
        </div>
    );
  }

  const { originalTask, plan, executionLog } = apiResponse;

  return (
    <div className="space-y-6 mt-6 w-full">
      {/* Original Task Section */}
      {originalTask && (
        <Card>
          <CardHeader>
            <CardTitle>Original Task</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{originalTask}</p>
          </CardContent>
        </Card>
      )}

      {/* Generated Plan Section */}
      {plan && Array.isArray(plan) && plan.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Generated Plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {plan.map((stageObj, stageIndex) => (
              <div key={`stage-${stageObj.stage || stageIndex}`}>
                <h4 className="text-lg font-semibold mb-2 text-primary">Stage {stageObj.stage}</h4>
                <ol className="list-decimal list-inside space-y-1 pl-4">
                  {stageObj.steps && Array.isArray(stageObj.steps) && stageObj.steps.map((step, stepIdx) => (
                    <li key={`stage-${stageObj.stage}-step-${stepIdx}`} className="text-sm text-muted-foreground">
                      {step.stepDescription} <span className="text-xs italic text-accent-foreground/80">(Tool: {step.toolName})</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Execution Log Section */}
      {executionLog && Array.isArray(executionLog) && executionLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Execution Log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {executionLog.map((logEntry, index) => (
              <Card key={`log-${index}`} className="p-3 bg-secondary/30">
                <CardHeader className="p-0 mb-1">
                    <CardTitle className="text-sm font-semibold">
                        Stage {logEntry.stage} - Step: "{logEntry.step}"
                    </CardTitle>
                    <CardDescription className="text-xs">Tool: {logEntry.tool}</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <p className={`text-xs font-medium ${
                    logEntry.status === "completed" ? "text-green-600 dark:text-green-400" :
                    logEntry.status === "failed" ? "text-red-600 dark:text-red-400" :
                    "text-gray-500 dark:text-gray-400"
                  }`}>
                    Status: {logEntry.status}
                  </p>
                  {logEntry.status === "completed" && logEntry.result && (
                    <div className="mt-1 text-xs text-muted-foreground bg-background/50 p-2 rounded">
                      <strong>Result:</strong>
                      <pre className="whitespace-pre-wrap break-all">{logEntry.result}</pre>
                    </div>
                  )}
                  {logEntry.status === "failed" && logEntry.error && (
                    <div className="mt-1 text-xs text-red-700 dark:text-red-500 bg-destructive/10 p-2 rounded">
                      <strong>Error:</strong>
                      <pre className="whitespace-pre-wrap break-all">{logEntry.error}</pre>
                    </div>
                  )}
                   {logEntry.status === "skipped" && (
                    <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 bg-muted/20 p-2 rounded">
                      <strong>Info:</strong> {logEntry.error || "Step was skipped."}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ResultsDisplay;
