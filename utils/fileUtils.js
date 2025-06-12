const path = require('path');

/**
 * Generates the full file path for saving a task state.
 *
 * @param {string} taskId - The ID of the task.
 * @param {string} rootDir - The root directory of the application (e.g., path.join(__dirname, '..') from a file in a subdirectory).
 * @returns {string} The full file path for the task state JSON file.
 */
function getTaskStateFilePath(taskId, rootDir) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  const formattedDate = `${month}${day}${year}`;

  const dateDir = `tasks_${formattedDate}`;
  const saveDir = path.join(rootDir, 'saved_tasks', dateDir);
  const filePath = path.join(saveDir, `task_state_${taskId}.json`);

  return filePath;
}

module.exports = {
  getTaskStateFilePath,
};
