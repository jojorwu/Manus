import React, { useState } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import FileUpload from '@/components/FileUpload'; // Import FileUpload

function TaskInputForm({ onSubmit, isLoading }) {
  const [taskText, setTaskText] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]); // State for selected files

  const handleFilesUpdate = (newFiles) => {
    setSelectedFiles(newFiles);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!taskText.trim() && selectedFiles.length === 0) {
      // Optionally, provide user feedback e.g., alert("Please enter a task or select files.");
      return;
    }
    onSubmit(taskText, selectedFiles); // Pass selectedFiles to onSubmit
    // setTaskText(''); // Optional: Clear input after submission
    // setSelectedFiles([]); // Optional: Clear files after submission
  };

  return (
    // Changed to column layout with spacing for better arrangement
    <form onSubmit={handleSubmit} className="space-y-4 w-full">
      <div className="flex flex-col sm:flex-row gap-3 items-stretch">
        <Input
          type="text"
          placeholder="Enter your task for the AI agent..."
          value={taskText}
          onChange={(e) => setTaskText(e.target.value)}
          disabled={isLoading}
          className="flex-grow text-lg p-4 sm:p-3"
        />
        <Button
          type="submit"
          disabled={isLoading}
          className="w-full sm:w-auto text-lg p-4 sm:p-3 shrink-0" // Added shrink-0
        >
          {isLoading ? "Processing..." : "Generate Plan & Execute"}
        </Button>
      </div>
      <FileUpload
        onFilesChange={handleFilesUpdate}
        maxFiles={5}              // Example prop, can be customized or passed down
        maxFileSizeMB={10}        // Example prop
      />
    </form>
  );
}

export default TaskInputForm;
