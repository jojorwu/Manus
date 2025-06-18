// utils/taskPathUtils.js
const path = require('path');
// Import savedTasksBaseDir from core/dependencies.js
// The path is relative from 'utils' up to root, then down to 'core'
const { savedTasksBaseDir } = require('../core/dependencies.js');

/**
 * Constructs the full directory path for a given task ID.
 * Includes a date-based subfolder (YYYY-MM-DD) and a 'task_' prefix for the ID.
 * @param {string} taskId - The unique ID of the task (e.g., a timestamp or UUID).
 * @returns {string} The full path to the task's directory.
 * @throws {Error} If taskId is invalid.
 */
function getTaskDirectoryPath(taskId) {
    const today = new Date().toISOString().split('T')[0];

    if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
        console.error('[taskPathUtils] Invalid or empty taskId provided to getTaskDirectoryPath.');
        // In a real scenario, you might have a more specific error type or handling
        throw new Error('Invalid taskId provided for path resolution.');
    }

    // TODO: This date-based folder structure assumes tasks are always created/accessed under "today".
    // For loading older tasks or more robust task path resolution, a metadata store or
    // a different directory structure (e.g., based on full taskId without date folders) would be needed.
    return path.join(savedTasksBaseDir, today, taskId.startsWith('task_') ? taskId : `task_${taskId}`);
}

module.exports = {
    getTaskDirectoryPath
};
