import React, { useState } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function TaskInputForm({ onSubmit, isLoading }) {
  const [taskText, setTaskText] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!taskText.trim()) {
      // Optionally, provide user feedback e.g., alert("Please enter a task.");
      return;
    }
    onSubmit(taskText);
    // setTaskText(''); // Optional: Clear input after submission
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center w-full">
      <Input
        type="text"
        placeholder="Enter your task for the AI agent..."
        value={taskText}
        onChange={(e) => setTaskText(e.target.value)}
        disabled={isLoading}
        className="flex-grow text-lg p-4 sm:p-3" // Adjusted padding for better text visibility
      />
      <Button
        type="submit"
        disabled={isLoading}
        className="w-full sm:w-auto text-lg p-4 sm:p-3" // Adjusted padding
      >
        {isLoading ? "Processing..." : "Generate Plan & Execute"}
      </Button>
    </form>
  );
}

export default TaskInputForm;
