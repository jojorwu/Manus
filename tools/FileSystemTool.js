// tools/FileSystemTool.js
const fs = require('fs').promises;
const path = require('path');

class FileSystemTool {
    constructor(taskWorkspaceDir) {
        if (!taskWorkspaceDir || typeof taskWorkspaceDir !== 'string' || taskWorkspaceDir.trim() === "") {
            throw new Error("FileSystemTool: taskWorkspaceDir is required and must be a non-empty string.");
        }
        this.taskWorkspaceDir = path.resolve(taskWorkspaceDir); // Ensure it's an absolute path
        // Create the base workspace directory if it doesn't exist
        // This is done once at construction to ensure the root exists.
        // Individual methods will ensure subdirectories exist via _getSafePath.
        fs.mkdir(this.taskWorkspaceDir, { recursive: true })
            .catch(err => console.error(`FileSystemTool: Failed to create root taskWorkspaceDir ${this.taskWorkspaceDir} on construction:`, err));
    }

    async _getSafePath(userPath = '') {
        if (typeof userPath !== 'string') {
            // This case should ideally be caught by param validation in public methods
            console.error("FileSystemTool._getSafePath: userPath was not a string, which is unexpected internally.");
            throw new Error("FileSystemTool: Internal error - userPath must be a string for _getSafePath.");
        }

        // Prevent path traversal by checking for '..' components.
        const normalizedUserPath = path.normalize(userPath);
        if (normalizedUserPath.split(path.sep).includes('..')) {
            throw new Error("FileSystemTool: Relative path components '..' are not allowed.");
        }

        const resolvedPath = path.join(this.taskWorkspaceDir, normalizedUserPath);

        // Security check: Ensure the resolved path is still within or is the taskWorkspaceDir
        if (!resolvedPath.startsWith(this.taskWorkspaceDir) && resolvedPath !== this.taskWorkspaceDir) {
             // Log more details for debugging this sensitive check
            console.error(`FileSystemTool: Path traversal attempt. Workspace: '${this.taskWorkspaceDir}', UserPath: '${userPath}', Resolved: '${resolvedPath}'`);
            throw new Error("FileSystemTool: Path traversal attempt detected.");
        }

        // Determine the directory to ensure exists.
        // If userPath looks like a directory (empty or ends with a separator), we ensure resolvedPath.
        // Otherwise, we ensure the parent directory of resolvedPath.
        let dirToEnsure;
        if (userPath === '' || normalizedUserPath.endsWith(path.sep) || (await fs.stat(resolvedPath).catch(() => null))?.isDirectory()) {
             // If it's intended to be a directory (or already exists as one), ensure this path.
            dirToEnsure = resolvedPath;
        } else {
            // Otherwise, it's a file path, ensure its parent directory.
            dirToEnsure = path.dirname(resolvedPath);
        }

        await fs.mkdir(dirToEnsure, { recursive: true });

        return resolvedPath;
    }

    async create_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            return { result: null, error: "Invalid input: 'filename' is required and must be a non-empty string." };
        }
        // Allow empty string content, but not other types.
        if (params.content === undefined || params.content === null || typeof params.content !== 'string') {
            return { result: null, error: "Invalid input: 'content' is required and must be a string (can be empty)." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);

        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            // Ensure we are not trying to write to a directory path that was resolved by _getSafePath
            if (safeFilePath.endsWith(path.sep) || (await fs.stat(safeFilePath).catch(() => null))?.isDirectory()) {
                 return { result: null, error: `Cannot create file, path '${relativeFilePath}' refers to a directory or would overwrite one.`};
            }
            await fs.writeFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            return { result: `File '${displayPath}' created successfully.`, error: null };
        } catch (error) {
            console.error(`FileSystemTool.create_file: Error creating file '${relativeFilePath}':`, error.message);
            return { result: null, error: error.message };
        }
    }

    async read_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            return { result: null, error: "Invalid input: 'filename' is required and must be a non-empty string." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        let safeFilePath;

        try {
            safeFilePath = await this._getSafePath(relativeFilePath);
             // Ensure we are not trying to read a directory path
            if (safeFilePath.endsWith(path.sep) || (await fs.stat(safeFilePath).catch(() => null))?.isDirectory()) {
                 return { result: null, error: `Cannot read file, path '${relativeFilePath}' refers to a directory.`};
            }
            await fs.access(safeFilePath);
            const content = await fs.readFile(safeFilePath, 'utf8');
            return { result: content, error: null };
        } catch (error) {
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath || path.join(this.taskWorkspaceDir, relativeFilePath) );
            if (error.code === 'ENOENT') {
                console.warn(`FileSystemTool.read_file: File not found '${displayPath}'.`);
                return { result: null, error: `File not found: '${displayPath}'.` };
            }
            console.error(`FileSystemTool.read_file: Error reading file '${displayPath}':`, error.message);
            return { result: null, error: error.message };
        }
    }

    async append_to_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            return { result: null, error: "Invalid input: 'filename' is required and must be a non-empty string." };
        }
        if (typeof params.content !== 'string' || params.content === "") { // Content must be non-empty for append
            return { result: null, error: "Invalid input: 'content' is required and must be a non-empty string for append." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);

        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            if (safeFilePath.endsWith(path.sep) || (await fs.stat(safeFilePath).catch(() => null))?.isDirectory()) {
                 return { result: null, error: `Cannot append to file, path '${relativeFilePath}' refers to a directory.`};
            }
            await fs.appendFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            return { result: `Content appended to '${displayPath}'.`, error: null };
        } catch (error) {
            console.error(`FileSystemTool.append_to_file: Error appending to file '${relativeFilePath}':`, error.message);
            return { result: null, error: error.message };
        }
    }

    async overwrite_file(params) {
        return this.create_file(params); // fs.writeFile overwrites by default
    }

    async list_files(params = {}) {
        const directory = params.directory || '';
        try {
            const safeDirPath = await this._getSafePath(directory);

            const stats = await fs.stat(safeDirPath).catch(e => {
                if (e.code === 'ENOENT') return null; // Path doesn't exist
                throw e; // Other error
            });

            if (!stats) { // Path does not exist
                 const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                 console.warn(`FileSystemTool.list_files: Directory not found '${displayPath}'.`);
                 return { result: null, error: `Directory not found: '${displayPath}'.` };
            }
            if (!stats.isDirectory()) {
                const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                return { result: null, error: `'${displayPath}' is not a directory.` };
            }

            const dirents = await fs.readdir(safeDirPath, { withFileTypes: true });
            const files = [];
            const directories = [];
            for (const dirent of dirents) {
                if (dirent.isFile()) {
                    files.push(dirent.name);
                } else if (dirent.isDirectory()) {
                    directories.push(dirent.name);
                }
            }
            files.sort();
            directories.sort();
            return { result: { files, directories }, error: null };
        } catch (error) {
            const displayPath = path.relative(this.taskWorkspaceDir, path.join(this.taskWorkspaceDir, directory) );
            if (error.code === 'ENOENT') { // Should be caught by stat check now, but as fallback
                 console.warn(`FileSystemTool.list_files: Directory not found '${displayPath}'.`);
                return { result: null, error: `Directory not found: '${displayPath}'.` };
            }
            console.error(`FileSystemTool.list_files: Error listing files in directory '${displayPath}':`, error.message);
            return { result: null, error: error.message };
        }
    }
}

module.exports = FileSystemTool;
