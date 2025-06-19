// tools/FileDownloaderTool.js
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
// const { Writable } = require('stream'); // Removed as unused

class FileDownloaderTool {
    constructor(taskWorkspaceDir) {
        if (!taskWorkspaceDir || typeof taskWorkspaceDir !== 'string' || taskWorkspaceDir.trim() === "") {
            throw new Error("FileDownloaderTool: taskWorkspaceDir is required and must be a non-empty string.");
        }
        this.taskWorkspaceDir = path.resolve(taskWorkspaceDir);
        // Ensure base workspace directory exists (synchronous for constructor is acceptable for this)
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- taskWorkspaceDir is resolved from a constructor argument, expected to be a safe base path.
        if (!fs.existsSync(this.taskWorkspaceDir)) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- taskWorkspaceDir is resolved from a constructor argument, expected to be a safe base path.
            fs.mkdirSync(this.taskWorkspaceDir, { recursive: true });
        }
    }

    async _getSafePath(userPath = '') {
        if (typeof userPath !== 'string') {
            throw new Error("FileDownloaderTool: userPath must be a string.");
        }

        // Sanitize each path component to prevent malicious characters.
        const sanitizedUserPath = userPath
            .split(path.sep)
            .map(part => part.replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 255))
            .join(path.sep);

        const normalizedUserPath = path.normalize(sanitizedUserPath);

        // Double check for path traversal components after sanitization and normalization
        if (normalizedUserPath.includes('..')) {
            throw new Error("FileDownloaderTool: Relative path components '..' are not allowed, even after sanitization.");
        }

        const resolvedPath = path.join(this.taskWorkspaceDir, normalizedUserPath);

        // Final check to ensure the path does not escape the workspace directory
        if (!resolvedPath.startsWith(this.taskWorkspaceDir)) {
            console.error(`FileDownloaderTool: Path traversal attempt. Workspace: '${this.taskWorkspaceDir}', UserPath: '${userPath}', Sanitized: '${sanitizedUserPath}', Resolved: '${resolvedPath}'`);
            throw new Error("FileDownloaderTool: Path traversal attempt detected.");
        }
        // For downloading, we always ensure the directory for the file exists.
        const dirToEnsure = path.dirname(resolvedPath);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirToEnsure is derived from a sanitized and validated path.
        await fsp.mkdir(dirToEnsure, { recursive: true });
        return resolvedPath;
    }

    _sanitizeFilename(filename) {
        if (typeof filename !== 'string') return 'downloaded_file';
        // Remove or replace invalid characters: / \ ? < > : * | " and control characters, limit length
        const controlCharsRegex = /[\x00-\x1f\x7f-\x9f]/g; // Used to strip control characters from filenames derived from content-disposition headers. These ranges cover common problematic characters. eslint-disable-line no-control-regex
        let sanitized = filename.replace(controlCharsRegex, '');
        sanitized = sanitized.replace(/[/?<>:*|" ":\s]/g, '_'); // Common invalid chars and whitespace (removed unnecessary escape for :)
        sanitized = sanitized.substring(0, 200); // Limit length to prevent overly long filenames
        if (sanitized.trim() === "") return 'downloaded_file';
        return sanitized;
    }

    _extractFilename(url, headers) {
        let filename = 'downloaded_file'; // Default filename
        if (headers && headers['content-disposition']) {
            const disposition = headers['content-disposition'];
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i;
            const matches = filenameRegex.exec(disposition);
            if (matches != null && matches[1]) {
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        if (filename === 'downloaded_file' || !filename.trim()) {
            try {
                const parsedUrl = new URL(url);
                const basename = path.basename(parsedUrl.pathname);
                if (basename.trim() && basename !== "/") { // Ensure basename is not empty or just a slash
                    filename = basename;
                }
            } catch (e) {
                // Invalid URL, stick with default or previously extracted filename
                console.warn(`FileDownloaderTool: Could not parse URL for filename extraction: ${url}`);
            }
        }
        return this._sanitizeFilename(filename);
    }

    async download_file(params) {
        if (!params || typeof params.url !== 'string' || params.url.trim() === "") {
            return { result: null, error: "Invalid input: 'url' is required and must be a non-empty string." };
        }

        const { url, directory = '', filename: userSpecifiedFilename } = params;
        const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
        let finalFilename = userSpecifiedFilename;
        let safeFilePath;

        try {
            // 1. HEAD request (optional, for headers and size check)
            let headResponse;
            let initialContentLength = null;
            // let contentType = null; // Ensured removed as unused

            try {
                headResponse = await axios({ method: 'head', url, timeout: 10000 });
                if (headResponse.headers['content-length']) {
                    initialContentLength = parseInt(headResponse.headers['content-length'], 10);
                    if (initialContentLength > MAX_FILE_SIZE_BYTES) {
                        return { result: null, error: `File size (${initialContentLength} bytes) exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes.` };
                    }
                }
                // contentType = headResponse.headers['content-type']; // Value is not used
                if (!finalFilename) {
                    finalFilename = this._extractFilename(url, headResponse.headers);
                }
            } catch (headError) {
                console.warn(`FileDownloaderTool: HEAD request for ${url} failed or is not supported: ${headError.message}. Proceeding with GET request.`);
                // If HEAD fails with specific client errors (403, 404), it's a good indicator to stop.
                if (headError.response && (headError.response.status === 403 || headError.response.status === 404)) {
                     return { result: null, error: `Failed to access URL ${url}: Server responded with status ${headError.response.status}.` };
                }
                // For other errors, we'll try GET but won't have Content-Length beforehand.
            }

            if (!finalFilename) { // If still no filename (e.g. HEAD failed and no user-provided filename)
                finalFilename = this._extractFilename(url, null); // Try extracting from URL path only
            }
            finalFilename = this._sanitizeFilename(finalFilename); // Ensure it's sanitized again if derived from URL after failed HEAD

            safeFilePath = await this._getSafePath(path.join(directory, finalFilename));

            // Ensure we are not trying to write to a directory path
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
            if (safeFilePath.endsWith(path.sep) || (await fsp.stat(safeFilePath).catch(() => null))?.isDirectory()) {
                 const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
                 return { result: null, error: `Cannot download file, path '${displayPath}' may refer to a directory or is invalid.`};
            }

            // 2. GET request for actual download
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
            const writer = fs.createWriteStream(safeFilePath);
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                timeout: 30000, // 30 seconds timeout for the download itself
            });

            // Check Content-Length again if not available from HEAD (or if HEAD failed)
            if (initialContentLength === null && response.headers['content-length']) {
                const getContentLength = parseInt(response.headers['content-length'], 10);
                if (getContentLength > MAX_FILE_SIZE_BYTES) {
                    response.data.destroy(); // Abort stream
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
                    try { await fsp.unlink(safeFilePath); } catch (e) { /* ignore cleanup error */ }
                    return { result: null, error: `File size (${getContentLength} bytes) from GET request exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes.` };
                }
            }

            let receivedBytes = 0;
            response.data.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_FILE_SIZE_BYTES) {
                    response.data.destroy(); // Abort stream
                    writer.close(() => { // Close writer and then attempt to unlink
                         // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath
                         fsp.unlink(safeFilePath).catch(e => console.error(`FileDownloaderTool: Failed to clean up oversized file ${safeFilePath}: ${e.message}`));
                    });
                    // Note: The promise might have already resolved or rejected by this point if 'finish' or 'error' on writer happened first.
                    // This is an attempt to stop further writing. The main promise handles resolution.
                }
            });

            return new Promise((resolve, reject) => {
                response.data.pipe(writer);
                // let error = null; // Removed as unused
                writer.on('finish', () => {
                    if (receivedBytes > MAX_FILE_SIZE_BYTES) { // Final check after stream finishes
                        // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
                        fsp.unlink(safeFilePath)
                           .then(() => reject({ result: null, error: `Download aborted: File size (${receivedBytes} bytes) exceeded maximum of ${MAX_FILE_SIZE_BYTES} bytes.`}))
                           .catch(unlinkErr => reject({ result: null, error: `Download aborted due to size, and failed to delete partial file: ${unlinkErr.message}`}));
                    } else {
                        const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
                        resolve({ result: `File '${displayPath}' downloaded successfully. Size: ${receivedBytes} bytes.`, error: null });
                    }
                });
                writer.on('error', err => {
                    // error = err; // Removed assignment to unused variable
                    writer.close(); // Ensure stream is closed
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
                    fsp.unlink(safeFilePath).catch(e => console.error(`FileDownloaderTool: Failed to clean up partially downloaded file ${safeFilePath} after writer error: ${e.message}`));
                    reject({ result: null, error: `Failed to write file to disk: ${err.message}` });
                });
                response.data.on('error', err => { // Handle errors from the response stream itself
                    // error = err; // Removed assignment to unused variable
                    writer.close();
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
                    fsp.unlink(safeFilePath).catch(e => console.error(`FileDownloaderTool: Failed to clean up partially downloaded file ${safeFilePath} after response error: ${e.message}`));
                    reject({ result: null, error: `Failed to download file, stream error: ${err.message}` });
                });
            });

        } catch (error) { // Catches errors from _getSafePath, initial axios calls (if not caught locally), or other setup issues
            console.error(`FileDownloaderTool.download_file: General error for URL '${url}':`, error.message);
            // Attempt to clean up if safeFilePath was determined and an error occurred before or during streaming
            if (safeFilePath) {
                // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeFilePath is sanitized by _getSafePath.
                try { await fsp.unlink(safeFilePath); } catch (e) { /* ignore cleanup error */ }
            }
            return { result: null, error: error.message };
        }
    }
}

module.exports = FileDownloaderTool;
