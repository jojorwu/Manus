// utils/taskStateUtil.js
const fs = require('fs').promises; // Using promises API directly
const path = require('path');
const logger = require('../core/logger'); // Import the logger

/**
 * Saves the task state object to a JSON file asynchronously.
 * Creates the directory if it doesn't exist.
 *
 * @param {object} taskStateObject - The task state object to save.
 * @param {string} filePath - The full path to the file where the state should be saved.
 * @returns {Promise<{success: boolean, message: string, error?: any}>}
 */
async function saveTaskState(taskStateObject, filePath) {
    try {
        const dirname = path.dirname(filePath);
        await fs.promises.mkdir(dirname, { recursive: true });

        const now = new Date().toISOString();
        taskStateObject.updatedAt = now;
        if (!taskStateObject.createdAt) {
            taskStateObject.createdAt = now;
        }

        const jsonData = JSON.stringify(taskStateObject, null, 2);
        await fs.writeFile(filePath, jsonData, 'utf8'); // fs.promises.writeFile

        logger.info(`TaskStateUtil: Task state saved successfully to ${filePath}`, { filePath });
        return { success: true, message: `Task state saved to ${filePath}` };
    } catch (error) {
        logger.error(`TaskStateUtil: Error saving task state to ${filePath}.`, { filePath, error: error.message, stack: error.stack });
        return { success: false, message: `Failed to save task state to ${filePath}`, error: error };
    }
}

/**
 * Loads the task state object from a JSON file asynchronously.
 *
 * @param {string} filePath - The full path to the file from where the state should be loaded.
 * @returns {Promise<{success: boolean, message: string, taskState?: object, error?: any}>}
 */
async function loadTaskState(filePath) {
    try {
        // Check file existence asynchronously
        try {
            await fs.access(filePath, fs.constants.F_OK); // fs.promises.access
        } catch (fileNotFoundError) {
            const message = `TaskStateUtil: File not found at ${filePath}`;
            logger.warn(message, { filePath }); // It's a common case, so warn might be enough
            return { success: false, message: message, error: new Error(message) }; // Return an error object for consistency
        }

        const jsonData = await fs.readFile(filePath, 'utf8'); // fs.promises.readFile
        const taskState = JSON.parse(jsonData);

        logger.info(`TaskStateUtil: Task state loaded successfully from ${filePath}`, { filePath });
        return { success: true, message: `Task state loaded from ${filePath}`, taskState: taskState };
    } catch (error) {
        // This catch will handle errors from readFile (other than not found if access failed) and JSON.parse
        logger.error(`TaskStateUtil: Error loading task state from ${filePath}.`, { filePath, error: error.message, stack: error.stack });
        return { success: false, message: `Failed to load task state from ${filePath}`, error: error };
    }
}

module.exports = {
    saveTaskState,
    loadTaskState
};
