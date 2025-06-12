const fs = require('fs');
const path = require('path');
const { TaskStatuses } = require('../core/constants');
const logger = require('../core/logger');

/**
 * Base class for worker agents. Handles common task processing logic,
 * including task queue subscription, tool execution with timeout,
 * result/error handling, and configuration loading.
 */
class BaseAgent {
    /**
     * Constructs a BaseAgent.
     * @param {object} subTaskQueue - The queue for receiving sub-tasks.
     * @param {object} resultsQueue - The queue for sending results of sub-tasks.
     * @param {Map<string, object>} toolsMap - A map of tool names to tool instances.
     * @param {string} agentRole - The role of this agent (e.g., "ResearchAgent", "UtilityAgent").
     * @param {object} agentApiKeysConfig - Configuration object containing API keys needed by tools.
     */
    constructor(subTaskQueue, resultsQueue, toolsMap, agentRole, agentApiKeysConfig) {
        this.subTaskQueue = subTaskQueue;
        this.resultsQueue = resultsQueue;
        this.toolsMap = toolsMap;
        this.agentRole = agentRole;
        this.agentApiKeysConfig = agentApiKeysConfig; // May be used by subclasses for tool execution

        this.config = this.loadWorkerConfig();
    }

    /**
     * Loads the worker agent configuration from `config/workerAgentConfig.json`.
     * Handles errors by using default values and logging warnings/errors.
     * The configuration includes default tool timeout and specific timeouts per tool.
     * @returns {object} The loaded configuration object, merged with defaults.
     * @private
     */
    loadWorkerConfig() {
        const configPath = path.join(__dirname, '..', 'config', 'workerAgentConfig.json');
        const defaultConfig = {
            defaultToolTimeoutMs: 30000,
            toolTimeouts: {}
        };
        try {
            if (fs.existsSync(configPath)) {
                const configData = fs.readFileSync(configPath, 'utf8');
                const loadedConfig = JSON.parse(configData);
                // Merge with defaults to ensure all keys are present
                return { ...defaultConfig, ...loadedConfig };
            } else {
                logger.warn(`${this.agentRole}: workerAgentConfig.json not found at ${configPath}. Using default timeout values.`, { agentRole: this.agentRole, filePath: configPath });
                return defaultConfig;
            }
        } catch (error) {
            logger.error(`${this.agentRole}: Error loading workerAgentConfig.json from ${configPath}. Using default timeout values.`, { agentRole: this.agentRole, filePath: configPath, error: error.message, stack: error.stack });
            return defaultConfig;
        }
    }

    startListening() {
        logger.info(`${this.agentRole} starting to listen for tasks on role: ${this.agentRole}`, { agentRole: this.agentRole });
        this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
    }

    /**
     * Retrieves the timeout duration for a given tool.
     * It first checks for a tool-specific timeout in `this.config.toolTimeouts`.
     * If not found, it returns the `this.config.defaultToolTimeoutMs`.
     * @param {string} toolName - The name of the tool.
     * @returns {number} The timeout duration in milliseconds.
     */
    getToolTimeout(toolName) {
        return this.config.toolTimeouts?.[toolName] || this.config.defaultToolTimeoutMs;
    }

    /**
     * Processes a task message received from the sub-task queue.
     * This method handles tool selection, input validation (via abstract method),
     * tool execution (via abstract method) with timeout, error handling,
     * and enqueuing the result to the results queue.
     * @param {object} taskMessage - The task message object.
     * @param {string} taskMessage.tool_name - The name of the tool to execute.
     * @param {object} taskMessage.sub_task_input - The input for the sub-task.
     * @param {string} taskMessage.sub_task_id - The ID of the sub-task.
     * @param {string} taskMessage.parent_task_id - The ID of the parent task.
     * @async
     */
    async processTaskMessage(taskMessage) {
        // Use debug for full task message, info for concise log
        logger.debug(`${this.agentRole}: Received full task message:`, { agentRole: this.agentRole, taskMessage });
        logger.info(`${this.agentRole}: Received task message for tool '${taskMessage.tool_name}' (sub_task_id: ${taskMessage.sub_task_id})`, { agentRole: this.agentRole, toolName: taskMessage.tool_name, subTaskId: taskMessage.sub_task_id, parentTaskId: taskMessage.parent_task_id });

        const { tool_name, sub_task_input, sub_task_id, parent_task_id } = taskMessage;
        let outcome = { result_data: null, error_details: null }; // Renamed to match expected fields in resultMsg
        let status = TaskStatuses.FAILED;

        const selectedTool = this.toolsMap.get(tool_name); // Assuming toolsMap is a Map

        if (selectedTool) {
            const validation = this.validateToolInput(tool_name, sub_task_input);
            if (validation.isValid) {
                const timeoutDuration = this.getToolTimeout(tool_name);
                logger.info(`${this.agentRole}: Executing tool '${tool_name}' for sub_task_id ${sub_task_id} with timeout ${timeoutDuration}ms.`, { agentRole: this.agentRole, toolName: tool_name, subTaskId: sub_task_id, timeout: timeoutDuration });

                const executionPromise = this.executeTool(selectedTool, sub_task_input, tool_name, this.agentApiKeysConfig); // Pass config if needed by tools

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutDuration}ms`)), timeoutDuration)
                );

                try {
                    const toolResult = await Promise.race([executionPromise, timeoutPromise]);

                    if (typeof toolResult === 'object' && toolResult !== null && toolResult.success === false) {
                        // Tool reported a controlled failure
                        outcome.error_details = { message: toolResult.error || "Tool reported an error without details." };
                        // status remains TaskStatuses.FAILED (default)
                        logger.warn(`${this.agentRole}: Tool '${tool_name}' reported a controlled failure for sub_task_id ${sub_task_id}.`, {
                            agentRole: this.agentRole,
                            toolName: tool_name,
                            subTaskId: sub_task_id,
                            error: outcome.error_details.message
                        });
                    } else {
                        // Tool execution is considered successful
                        if (typeof toolResult === 'object' && toolResult !== null && toolResult.hasOwnProperty('data') && toolResult.success === true) {
                            outcome.result_data = toolResult.data;
                        } else {
                            outcome.result_data = toolResult; // Handle direct primitive/object returns
                        }
                        status = TaskStatuses.COMPLETED;
                    }
                } catch (error) { // Handles exceptions from executeTool or timeout
                    logger.error(`${this.agentRole}: Error executing tool '${tool_name}' for sub_task_id ${sub_task_id}.`, { agentRole: this.agentRole, toolName: tool_name, subTaskId: sub_task_id, error: error.message, stack: error.stack });
                    outcome.error_details = { message: error.message || "Tool execution failed or timed out." };
                    // status remains TaskStatuses.FAILED (default)
                    // if (error.stack) outcome.error_details.stack = error.stack; // Already included by logger.error if error is passed as metadata
                }
            } else {
                logger.warn(`${this.agentRole}: Invalid input for tool '${tool_name}' on sub_task_id ${sub_task_id}: ${validation.error}`, { agentRole: this.agentRole, toolName: tool_name, subTaskId: sub_task_id, validationError: validation.error });
                outcome.error_details = { message: `Invalid input for tool '${tool_name}': ${validation.error}` };
            }
        } else {
            logger.error(`${this.agentRole}: Unknown tool '${tool_name}' for role ${this.agentRole}. Sub_task_id: ${sub_task_id}`, { agentRole: this.agentRole, toolName: tool_name, subTaskId: sub_task_id });
            outcome.error_details = { message: `Unknown tool '${tool_name}' for ${this.agentRole}.` };
        }

        const resultMessage = {
            sub_task_id,
            parent_task_id,
            worker_role: this.agentRole, // 'worker_role' seems to be what Orchestrator expects for result routing
            status,
            result_data: outcome.result_data,
            error_details: outcome.error_details,
        };

        logger.info(`${this.agentRole}: Sending result for sub_task_id ${sub_task_id}. Status: ${status}`, { agentRole: this.agentRole, subTaskId: sub_task_id, status });
        logger.debug(`${this.agentRole}: Full result message for sub_task_id ${sub_task_id}:`, { agentRole: this.agentRole, resultMessage });
        this.resultsQueue.enqueueResult(parent_task_id, resultMessage);
    }

    // Abstract methods to be implemented by subclasses
    /**
     * Validates the input for a given tool.
     * This method MUST be implemented by subclasses.
     * @param {string} tool_name - The name of the tool.
     * @param {object} sub_task_input - The input for the sub-task.
     * @returns {{isValid: boolean, error: string|null}} An object indicating if the input is valid, and an error message if not.
     * @abstract
     */
    validateToolInput(tool_name, sub_task_input) {
        // This method MUST be overridden by subclasses
        logger.error(`${this.agentRole}: validateToolInput() called on BaseAgent. Subclasses must override this method.`, { agentRole: this.agentRole, toolName: tool_name });
        return { isValid: false, error: "validateToolInput not implemented in subclass." };
    }

    /**
     * Executes the given tool with the provided input.
     * This method MUST be implemented by subclasses.
     * @param {object} toolInstance - The instance of the tool to execute.
     * @param {object} sub_task_input - The input for the tool.
     * @param {string} tool_name - The name of the tool (for logging or specific handling if needed).
     * @param {object} agentApiKeysConfig - API keys configuration, in case the tool's execute method needs it directly.
     * @returns {Promise<any>} A promise that resolves with the result of the tool execution.
     * @async
     * @abstract
     */
    async executeTool(toolInstance, sub_task_input, tool_name, agentApiKeysConfig) {
        // This method MUST be overridden by subclasses
        logger.error(`${this.agentRole}: executeTool() called on BaseAgent. Subclasses must override this method.`, { agentRole: this.agentRole, toolName: tool_name });
        // To prevent unhandled promise rejections if not overridden:
        return Promise.reject(new Error("executeTool not implemented in subclass."));
    }
}

module.exports = BaseAgent;
