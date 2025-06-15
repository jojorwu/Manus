import React from 'react';
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Check, RefreshCw, Loader2, Users, ChevronDown } from 'lucide-react';

const StatusIndicator = ({ status }) => {
  let bgColor = 'bg-gray-400'; // Default for offline or unknown
  let textColor = 'text-gray-700';
  let borderColor = 'border-gray-500';
  let statusText = status || 'unknown';

  if (status === 'idle') {
    bgColor = 'bg-green-100 dark:bg-green-900';
    textColor = 'text-green-700 dark:text-green-300';
    borderColor = 'border-green-500 dark:border-green-600';
    statusText = 'Idle';
  } else if (status === 'busy') {
    bgColor = 'bg-yellow-100 dark:bg-yellow-900';
    textColor = 'text-yellow-700 dark:text-yellow-300';
    borderColor = 'border-yellow-500 dark:border-yellow-600';
    statusText = 'Busy';
  } else if (status === 'error') {
    bgColor = 'bg-red-100 dark:bg-red-900';
    textColor = 'text-red-700 dark:text-red-300';
    borderColor = 'border-red-500 dark:border-red-600';
    statusText = 'Error';
  } else if (status === 'offline') {
    bgColor = 'bg-gray-100 dark:bg-gray-700';
    textColor = 'text-gray-500 dark:text-gray-300';
    borderColor = 'border-gray-400 dark:border-gray-500';
    statusText = 'Offline';
  }

  return (
    <Badge variant="outline" className={`px-2 py-0.5 text-xs ${textColor} ${bgColor} border ${borderColor}`}>
      {statusText.charAt(0).toUpperCase() + statusText.slice(1)}
    </Badge>
  );
};


function AgentSelector({
  agents,
  selectedAgentId,
  onAgentSelect,
  onRefreshAgents,
  isLoading = false
}) {
  const selectedAgent = agents && agents.find(agent => agent.id === selectedAgentId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto min-w-[200px] flex justify-between items-center">
          <span className="truncate">
            {isLoading && !selectedAgent && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {selectedAgent ? (
              <div className="flex items-center">
                <Users className="mr-2 h-4 w-4 text-muted-foreground" />
                {selectedAgent.name}
                <span className="ml-2 text-xs text-muted-foreground">({selectedAgent.status})</span>
              </div>
            ) : (
              isLoading ? "Загрузка агентов..." : "Выберите агента..."
            )}
          </span>
          {!isLoading && <ChevronDown className="ml-1 h-4 w-4 opacity-50" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-full sm:w-72 md:w-80 max-h-[50vh] overflow-y-auto"> {/* Increased width & max height */}
        <DropdownMenuLabel>Доступные агенты</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {agents && agents.length > 0 ? (
          agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onAgentSelect(agent.id)}
              className="flex justify-between items-center cursor-pointer"
            >
              <div className="flex flex-col">
                <span className="font-medium">{agent.name}</span>
                <span className="text-xs text-muted-foreground">{agent.type || 'N/A Type'}</span>
              </div>
              <div className="flex items-center">
                <StatusIndicator status={agent.status} />
                {agent.id === selectedAgentId && <Check className="ml-2 h-4 w-4 text-green-500" />}
              </div>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            {isLoading ? "Загрузка..." : "Нет доступных агентов."}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRefreshAgents} className="cursor-pointer">
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Обновить список
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export default AgentSelector;
