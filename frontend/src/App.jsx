import React, { useState, useEffect, useCallback } from 'react'; // Added useEffect, useCallback
import axios from 'axios';
import TaskInputForm from '@/components/TaskInputForm';
import ResultsDisplay from '@/components/ResultsDisplay';
import AISettingsDialog from '@/components/AISettingsDialog';
import AgentSelector from '@/components/AgentSelector'; // Import AgentSelector
import { Button } from "@/components/ui/button";
import { Settings } from 'lucide-react';
// import './App.css';

function App() {
  const [isLoading, setIsLoading] = useState(false); // Main task loading
  const [apiResponse, setApiResponse] = useState(null);
  const [error, setError] = useState(null); // Main task error
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);

  const [agentsList, setAgentsList] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [agentError, setAgentError] = useState(null);

  const fetchAgentInstances = useCallback(async () => {
    setIsLoadingAgents(true);
    setAgentError(null);
    try {
      const response = await axios.get('/api/agent-instances'); // Assuming this endpoint
      setAgentsList(response.data || []);
      if (!selectedAgentId && response.data && response.data.length > 0) {
        setSelectedAgentId(response.data[0].id); // Select first agent by default
      }
    } catch (err) {
      console.error("Failed to fetch agent instances:", err);
      setAgentError(err.response?.data?.message || err.message || "Failed to load agents.");
      setAgentsList([]); // Clear list on error
    } finally {
      setIsLoadingAgents(false);
    }
  }, [selectedAgentId]); // selectedAgentId in dep array to re-evaluate default selection if it becomes null

  useEffect(() => {
    fetchAgentInstances();
  }, [fetchAgentInstances]); // Call on mount and if fetchAgentInstances changes (e.g. due to selectedAgentId logic)

  const handleAgentSelect = (agentId) => {
    setSelectedAgentId(agentId);
  };

  const handleTaskSubmit = async (taskString, files) => {
    if (!selectedAgentId) {
      setError("Пожалуйста, выберите агента перед отправкой задачи.");
      // No need to set isLoading(false) here as it's not set true yet
      return;
    }
    setIsLoading(true);
    setApiResponse(null);
    setError(null); // Clear previous main task errors

    const formData = new FormData();
    formData.append('task', taskString);
    formData.append('agentId', selectedAgentId);

    if (files && files.length > 0) {
      files.forEach(file => {
        formData.append('files', file, file.name);
      });
    }

    try {
      // Assuming '/api/generate-plan' is the endpoint that will handle multipart/form-data
      // and has been updated or will be updated to accept agentId and files.
      // Axios will automatically set Content-Type to multipart/form-data when FormData is used.
      const response = await axios.post('http://localhost:3000/api/generate-plan', formData);
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
      <header className="mb-8 text-center w-full flex justify-between items-center">
        {/* Empty div for spacing if needed, or adjust justification */}
        <div className="w-10 h-10"> {/* Placeholder for spacing, adjust as needed */} </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-primary">AI Agent Interface</h1>
        <Button variant="outline" size="icon" onClick={() => setIsSettingsDialogOpen(true)} aria-label="Open AI Settings">
          <Settings className="h-5 w-5" />
        </Button>
      </header>

      <main className="w-full max-w-4xl space-y-8 flex-grow flex flex-col">
        <div className="flex flex-col items-center space-y-4">
          <AgentSelector
            agents={agentsList}
            selectedAgentId={selectedAgentId}
            onAgentSelect={handleAgentSelect}
            onRefreshAgents={fetchAgentInstances}
            isLoading={isLoadingAgents}
          />
          {agentError && <p className="text-sm text-red-500">{agentError}</p>}
        </div>

        <TaskInputForm onSubmit={handleTaskSubmit} isLoading={isLoading} />

        {isLoading && (
          <div className="flex justify-center items-center py-10 flex-grow">
            <p className="text-lg text-muted-foreground animate-pulse">
              Processing your task, please wait...
            </p>
          </div>
        )}

        {!isLoading && <ResultsDisplay apiResponse={apiResponse} error={error} />}
      </main>

      <AISettingsDialog
        isOpen={isSettingsDialogOpen}
        onOpenChange={setIsSettingsDialogOpen}
        // onSettingsSave={() => console.log("Settings saved callback from App")} // Optional
      />

      <footer className="text-sm text-muted-foreground mt-auto pt-8">
        <p>© {new Date().getFullYear()} AI Agent Project</p>
      </footer>
    </div>
  );
}

export default App;
