// utils/taskStateUtil.js
const fs = require('fs');
const path = require('path');

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
        await fs.promises.writeFile(filePath, jsonData, 'utf8');

        console.log(`TaskStateUtil: Task state saved successfully (async) to ${filePath}`);
        return { success: true, message: `Task state saved to ${filePath}` };
    } catch (error) {
        console.error(`TaskStateUtil: Error saving task state (async) to ${filePath}. Error: ${error.message}`);
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
            await fs.promises.access(filePath, fs.constants.F_OK); // F_OK checks existence
        } catch (fileNotFoundError) {
            const message = `TaskStateUtil: File not found at ${filePath}`;
            console.warn(message);
            return { success: false, message: message, error: new Error(message) };
        }

        const jsonData = await fs.promises.readFile(filePath, 'utf8');
        const taskState = JSON.parse(jsonData); // JSON.parse remains synchronous

        console.log(`TaskStateUtil: Task state loaded successfully (async) from ${filePath}`);
        return { success: true, message: `Task state loaded from ${filePath}`, taskState: taskState };
    } catch (error) {
        // This catch will handle errors from readFile (other than not found if access failed) and JSON.parse
        console.error(`TaskStateUtil: Error loading task state (async) from ${filePath}. Error: ${error.message}`);
        return { success: false, message: `Failed to load task state from ${filePath}`, error: error };
    }
}

module.exports = {
    saveTaskState,
    loadTaskState
};
