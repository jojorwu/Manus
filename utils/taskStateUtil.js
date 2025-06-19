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
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath (and thus dirname) is expected to be constructed safely by the caller using system-generated IDs and base paths.
        await fs.promises.mkdir(dirname, { recursive: true });

        const now = new Date().toISOString();
        taskStateObject.updatedAt = now;
        if (!taskStateObject.createdAt) {
            taskStateObject.createdAt = now;
        }

        const jsonData = JSON.stringify(taskStateObject, null, 2);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is expected to be constructed safely by the caller.
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

        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is expected to be constructed safely by the caller.
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

/**
 * Saves an array of journal entries to a JSONL file asynchronously.
 * Each entry is a JSON string on a new line.
 * Creates the directory if it doesn't exist.
 *
 * @param {string} parentTaskId - The ID of the parent task.
 * @param {Array<Object>} journalEntries - An array of journal entry objects.
 * @param {string} tasksBaseDir - The base directory for saved tasks (e.g., 'saved_tasks').
 * @returns {Promise<{success: boolean, message: string, filePath?: string, error?: any}>}
 */
async function saveTaskJournal(parentTaskId, journalEntries, tasksBaseDir) {
    try {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const year = now.getFullYear();
        const dateDirName = `tasks_${month}${day}${year}`;

        const dateDirPath = path.join(tasksBaseDir, dateDirName);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- dateDirPath is constructed from a configured base path and system-generated date.
        await fs.promises.mkdir(dateDirPath, { recursive: true });

        const fileName = `task_journal_${parentTaskId}.jsonl`;
        const filePath = path.join(dateDirPath, fileName);

        // Convert each entry to a JSON string and join with newlines
        // Ensure a newline at the very end for proper JSONL format
        const jsonlData = journalEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is constructed from a configured base path, system date, and system-generated parentTaskId.
        await fs.promises.writeFile(filePath, jsonlData, 'utf8');

        console.log(`TaskStateUtil: Task journal saved successfully to ${filePath}`);
        return { success: true, message: `Task journal saved to ${filePath}`, filePath: filePath };
    } catch (error) {
        console.error(`TaskStateUtil: Error saving task journal for parentTaskId ${parentTaskId}. Error: ${error.message}`);
        return { success: false, message: `Failed to save task journal for parentTaskId ${parentTaskId}`, error: error };
    }
}

/**
 * Loads task journal entries from a JSONL file asynchronously.
 * Searches for the file in dated subdirectories.
 *
 * @param {string} parentTaskId - The ID of the parent task.
 * @param {string} tasksBaseDir - The base directory for saved tasks (e.g., 'saved_tasks').
 * @returns {Promise<{success: boolean, message: string, journalEntries?: Array<Object>, error?: any}>}
 */
async function loadTaskJournal(parentTaskId, tasksBaseDir) {
    const fileName = `task_journal_${parentTaskId}.jsonl`;
    let foundFilePath = null;

    try {
        // Check if tasksBaseDir itself exists
        try {
            await fs.promises.access(tasksBaseDir, fs.constants.F_OK);
        } catch (baseDirError) {
            console.warn(`TaskStateUtil: Base tasks directory not found at ${tasksBaseDir}. Cannot load journal.`);
            return { success: false, message: `Base tasks directory not found: ${tasksBaseDir}`, journalEntries: null };
        }

        // eslint-disable-next-line security/detect-non-literal-fs-filename -- tasksBaseDir is a configured, trusted base path.
        const allDirents = await fs.promises.readdir(tasksBaseDir, { withFileTypes: true });
        const dateDirs = allDirents
            .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('tasks_'))
            .map(dirent => dirent.name)
            .sort((a, b) => b.localeCompare(a)); // Sort to check newest first

        for (const dateDir of dateDirs) {
            const tryPath = path.join(tasksBaseDir, dateDir, fileName);
            try {
                await fs.promises.access(tryPath, fs.constants.F_OK);
                foundFilePath = tryPath;
                break;
            } catch (fileAccessError) {
                // File not in this directory, continue searching
            }
        }

        if (!foundFilePath) {
            const message = `TaskStateUtil: Journal file ${fileName} not found in any dated subdirectory under ${tasksBaseDir}.`;
            // console.log(message); // It's normal for a journal not to exist yet.
            return { success: true, message: message, journalEntries: null }; // Return true, but null entries
        }

        // eslint-disable-next-line security/detect-non-literal-fs-filename -- foundFilePath is determined by searching for system-generated filenames within controlled subdirectories.
        const fileContent = await fs.promises.readFile(foundFilePath, 'utf8');
        if (!fileContent.trim()) {
            console.log(`TaskStateUtil: Journal file ${foundFilePath} is empty.`);
            return { success: true, message: `Journal file ${foundFilePath} is empty.`, journalEntries: [] };
        }

        const lines = fileContent.trim().split('\n');
        const journalEntries = lines.map(line => JSON.parse(line));

        console.log(`TaskStateUtil: Task journal loaded successfully from ${foundFilePath}`);
        return { success: true, message: `Task journal loaded from ${foundFilePath}`, journalEntries: journalEntries };

    } catch (error) {
        console.error(`TaskStateUtil: Error loading task journal ${fileName}. Error: ${error.message}`);
        return { success: false, message: `Failed to load task journal ${fileName}`, error: error, journalEntries: null };
    }
}


module.exports = {
    saveTaskState,
    loadTaskState,
    saveTaskJournal,
    loadTaskJournal
};
