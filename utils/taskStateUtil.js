// utils/taskStateUtil.js
const fs = require('fs');
const path = require('path');

/**
 * Saves the task state object to a JSON file.
 * Creates the directory if it doesn't exist.
 *
 * @param {object} taskStateObject - The task state object to save.
 * @param {string} filePath - The full path to the file where the state should be saved.
 * @returns {{success: boolean, message: string, error?: any}}
 */
function saveTaskState(taskStateObject, filePath) {
    try {
        // Ensure the directory exists
        const dirname = path.dirname(filePath);
        if (!fs.existsSync(dirname)) {
            fs.mkdirSync(dirname, { recursive: true });
            console.log(`TaskStateUtil: Created directory ${dirname}`);
        }

        // Add/update timestamps
        const now = new Date().toISOString();
        taskStateObject.updatedAt = now;
        if (!taskStateObject.createdAt) {
            taskStateObject.createdAt = now;
        }

        const jsonData = JSON.stringify(taskStateObject, null, 2); // Pretty print JSON
        fs.writeFileSync(filePath, jsonData, 'utf8');

        console.log(`TaskStateUtil: Task state saved successfully to ${filePath}`);
        return { success: true, message: `Task state saved to ${filePath}` };
    } catch (error) {
        console.error(`TaskStateUtil: Error saving task state to ${filePath}. Error: ${error.message}`);
        return { success: false, message: `Failed to save task state to ${filePath}`, error: error };
    }
}

/**
 * Loads the task state object from a JSON file.
 *
 * @param {string} filePath - The full path to the file from where the state should be loaded.
 * @returns {{success: boolean, message: string, taskState?: object, error?: any}}
 */
function loadTaskState(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            const message = `TaskStateUtil: File not found at ${filePath}`;
            console.warn(message);
            return { success: false, message: message, error: new Error(message) };
        }

        const jsonData = fs.readFileSync(filePath, 'utf8');
        const taskState = JSON.parse(jsonData);

        console.log(`TaskStateUtil: Task state loaded successfully from ${filePath}`);
        return { success: true, message: `Task state loaded from ${filePath}`, taskState: taskState };
    } catch (error) {
        console.error(`TaskStateUtil: Error loading task state from ${filePath}. Error: ${error.message}`);
        return { success: false, message: `Failed to load task state from ${filePath}`, error: error };
    }
}

module.exports = {
    saveTaskState,
    loadTaskState
};
