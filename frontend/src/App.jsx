import React, { useState } from 'react';
import axios from 'axios';
import TaskInputForm from '@/components/TaskInputForm';
import ResultsDisplay from '@/components/ResultsDisplay'; // Import ResultsDisplay
// import './App.css';

function App() {
  const [isLoading, setIsLoading] = useState(false);
  const [apiResponse, setApiResponse] = useState(null);
  const [error, setError] = useState(null);

  const handleTaskSubmit = async (taskString) => {
    setIsLoading(true);
    setApiResponse(null);
    setError(null);

    try {
      const response = await axios.post('http://localhost:3000/api/generate-plan', { task: taskString });
      setApiResponse(response.data);
    } catch (err) {
      console.error("API call error:", err);
      if (err.response && err.response.data && err.response.data.message) {
        setError(err.response.data.message + (err.response.data.details ? ` (Details: ${err.response.data.details})` : ''));
      } else if (err.message) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred during the API call.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center p-4 sm:p-8">
      <header className="mb-8 text-center w-full"> {/* Added w-full for consistency */}
        <h1 className="text-3xl sm:text-4xl font-bold text-primary">AI Agent Interface</h1>
      </header>

      {/* Ensure main takes up available space and centers its content if narrower than max-w-4xl */}
      <main className="w-full max-w-4xl space-y-8 flex-grow flex flex-col">
        <TaskInputForm onSubmit={handleTaskSubmit} isLoading={isLoading} />

        {isLoading && (
          <div className="flex justify-center items-center py-10 flex-grow">
            <p className="text-lg text-muted-foreground animate-pulse">
              Processing your task, please wait...
            </p>
            {/* Consider adding a spinner component here later */}
          </div>
        )}

        {/* ResultsDisplay will handle null apiResponse or error and display appropriately */}
        {/* It is rendered when not loading, and will show results, error, or initial prompt */}
        {!isLoading && <ResultsDisplay apiResponse={apiResponse} error={error} />}

      </main>

      <footer className="text-sm text-muted-foreground mt-auto pt-8">
        <p>© {new Date().getFullYear()} AI Agent Project</p>
      </footer>
    </div>
  );
}

export default App;
