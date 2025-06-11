const fs = require('fs').promises; // Use promise-based fs
const path = require('path');

class FileSystemTool {
  constructor(workspaceDir) {
    this.workspaceDir = path.resolve(workspaceDir); // Ensure workspaceDir is an absolute path
    console.log(`FileSystemTool initialized with workspace: ${this.workspaceDir}`);
    // Ensure workspace directory exists, similar to server.js logic (optional here, if server guarantees it)
    // For robustness, this tool could also check/create it.
    // const fsSync = require('fs');
    // if (!fsSync.existsSync(this.workspaceDir)) {
    //   fsSync.mkdirSync(this.workspaceDir, { recursive: true });
    //   console.log(`FileSystemTool created workspace directory: ${this.workspaceDir}`);
    // }
  }

  // Helper to securely resolve file path within workspace
  _getSafePath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.trim() === '') {
        return { error: "File path cannot be empty." };
    }
    // Normalize the relative path (e.g., resolve '..', '.', multiple slashes)
    const normalizedRelativePath = path.normalize(relativePath);

    // Prevent path traversal by ensuring the resolved path is still within the workspace
    const absolutePath = path.resolve(this.workspaceDir, normalizedRelativePath);

    if (!absolutePath.startsWith(this.workspaceDir + path.sep) && absolutePath !== this.workspaceDir) {
         // The check `absolutePath !== this.workspaceDir` is added for cases where relativePath might be "" or "."
         // and we want to allow operations on the workspaceDir itself if needed,
         // though for readFile/writeFile, a file name is usually expected.
         // A stricter check might be `!absolutePath.startsWith(this.workspaceDir + path.sep)`
         // if we only allow operations on files *within* the workspace, not the workspace dir itself.
         // For now, this is a reasonable security check.
      return { error: "Path traversal attempt detected or invalid path." };
    }
    // Additional check to prevent operating on hidden files or directories directly if desired
    if (path.basename(normalizedRelativePath).startsWith('.')) {
        // Allow .placeholder or other specific dotfiles if needed by explicitly checking their full name
        if (path.basename(normalizedRelativePath) !== '.placeholder') { // Example allowance
            return { error: "Operations on most hidden files or directories are not allowed." };
        }
    }

    return { safePath: absolutePath, error: null };
  }

  async execute({ operation, filePath, content }) {
    if (!operation || !filePath) {
      return { result: null, error: "Operation and filePath are required for FileSystemTool." };
    }

    const pathValidation = this._getSafePath(filePath);
    if (pathValidation.error) {
      return { result: null, error: pathValidation.error };
    }
    const safeFilePath = pathValidation.safePath;

    try {
      if (operation === "readFile") {
        const fileContent = await fs.readFile(safeFilePath, 'utf8');
        return { result: fileContent, error: null };
      } else if (operation === "writeFile") {
        if (typeof content !== 'string') {
          return { result: null, error: "Content must be a string for writeFile operation." };
        }
        // For writeFile, ensure parent directory of safeFilePath exists if filePath includes subdirectories
        const parentDir = path.dirname(safeFilePath);
        if (parentDir !== this.workspaceDir && !parentDir.startsWith(this.workspaceDir + path.sep)) {
            // This check ensures we are not trying to create directories outside the workspace,
            // even if the file path itself would resolve inside due to a filename like "../workspace_file.txt"
            // which _getSafePath might allow if workspaceDir is /app/agent_workspace and path is ../agent_workspace/file.txt
            return { result: null, error: "Cannot write file to a location that results in parent directory creation outside the workspace."};
        }
        await fs.mkdir(parentDir, { recursive: true }); // Create parent dirs if they don't exist within workspace

        await fs.writeFile(safeFilePath, content, 'utf8');
        return { result: `File successfully written to '${filePath}'.`, error: null };
      } else {
        return { result: null, error: `Unsupported operation '${operation}'. Must be 'readFile' or 'writeFile'.` };
      }
    } catch (e) {
      console.error(`FileSystemTool error during operation '${operation}' on '${filePath}':`, e);
      if (e.code === 'ENOENT') {
        return { result: null, error: `File system error: File or path not found at '${filePath}'.` };
      } else if (e.code === 'EACCES') {
        return { result: null, error: `File system error: Permission denied for '${filePath}'.` };
      }
      return { result: null, error: `File system error during ${operation}: ${e.message}` };
    }
  }
}

module.exports = FileSystemTool;
