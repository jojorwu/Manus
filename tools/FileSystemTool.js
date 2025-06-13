// tools/FileSystemTool.js
const fsp = require('fs').promises; // Renamed for clarity
const fs = require('fs'); // For createWriteStream (synchronous part of stream setup)
const path = require('path');
const PDFDocument = require('pdfkit');

class FileSystemTool {
    constructor(taskWorkspaceDir) {
        if (!taskWorkspaceDir || typeof taskWorkspaceDir !== 'string' || taskWorkspaceDir.trim() === "") {
            throw new Error("FileSystemTool: taskWorkspaceDir is required and must be a non-empty string.");
        }
        this.taskWorkspaceDir = path.resolve(taskWorkspaceDir); // Ensure it's an absolute path
        // Create the base workspace directory if it doesn't exist
        fsp.mkdir(this.taskWorkspaceDir, { recursive: true })
            .catch(err => console.error(`FileSystemTool: Failed to create root taskWorkspaceDir ${this.taskWorkspaceDir} on construction:`, err));
    }

    async _getSafePath(userPath = '') {
        if (typeof userPath !== 'string') {
            console.error("FileSystemTool._getSafePath: userPath was not a string, which is unexpected internally.");
            throw new Error("FileSystemTool: Internal error - userPath must be a string for _getSafePath.");
        }
        const normalizedUserPath = path.normalize(userPath);
        if (normalizedUserPath.split(path.sep).includes('..')) {
            throw new Error("FileSystemTool: Relative path components '..' are not allowed.");
        }
        const resolvedPath = path.join(this.taskWorkspaceDir, normalizedUserPath);
        if (!resolvedPath.startsWith(this.taskWorkspaceDir) && resolvedPath !== this.taskWorkspaceDir) {
            console.error(`FileSystemTool: Path traversal attempt. Workspace: '${this.taskWorkspaceDir}', UserPath: '${userPath}', Resolved: '${resolvedPath}'`);
            throw new Error("FileSystemTool: Path traversal attempt detected.");
        }
        let dirToEnsure;
        let isDirectoryLike = userPath === '' || normalizedUserPath.endsWith(path.sep);
        if (!isDirectoryLike && path.extname(normalizedUserPath) === '') {
            try {
                const stats = await fsp.stat(resolvedPath);
                if (stats.isDirectory()) {
                    isDirectoryLike = true;
                }
            } catch (e) {
                if (path.basename(normalizedUserPath) !== '') {
                    isDirectoryLike = false;
                } else {
                    isDirectoryLike = true;
                }
            }
        }
        if (isDirectoryLike) {
            dirToEnsure = resolvedPath;
        } else {
            dirToEnsure = path.dirname(resolvedPath);
        }
        await fsp.mkdir(dirToEnsure, { recursive: true });
        return resolvedPath;
    }

    async create_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            return { result: null, error: "Invalid input: 'filename' is required and must be a non-empty string." };
        }
        if (params.content === undefined || params.content === null || typeof params.content !== 'string') {
            return { result: null, error: "Invalid input: 'content' is required and must be a string (can be empty)." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            try {
                const stats = await fsp.stat(safeFilePath);
                if (stats.isDirectory()) {
                    return { result: null, error: `Cannot create file, path '${relativeFilePath}' refers to an existing directory.`};
                }
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            await fsp.writeFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            return { result: `File '${displayPath}' created successfully.`, error: null };
        } catch (error) {
            console.error(`FileSystemTool.create_file: Error creating file '${params.filename}' in directory '${directory}':`, error.message);
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
            const stats = await fsp.stat(safeFilePath).catch(e => {
                if (e.code === 'ENOENT') throw e;
                throw e;
            });
            if (stats && stats.isDirectory()) {
                 return { result: null, error: `Cannot read file, path '${relativeFilePath}' refers to a directory.`};
            }
            const content = await fsp.readFile(safeFilePath, 'utf8');
            return { result: content, error: null };
        } catch (error) {
            const displayPath = safeFilePath ? path.relative(this.taskWorkspaceDir, safeFilePath) : relativeFilePath;
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
        if (typeof params.content !== 'string' || params.content === "") {
            return { result: null, error: "Invalid input: 'content' is required and must be a non-empty string for append." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            try {
                const stats = await fsp.stat(safeFilePath);
                if (stats.isDirectory()) {
                    return { result: null, error: `Cannot append to file, path '${relativeFilePath}' refers to an existing directory.`};
                }
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            await fsp.appendFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            return { result: `Content appended to '${displayPath}'.`, error: null };
        } catch (error) {
            console.error(`FileSystemTool.append_to_file: Error appending to file '${params.filename}' in directory '${directory}':`, error.message);
            return { result: null, error: error.message };
        }
    }

    async overwrite_file(params) {
        return this.create_file(params);
    }

    async list_files(params = {}) {
        const directory = params.directory || '';
        try {
            const safeDirPath = await this._getSafePath(directory);
            const stats = await fsp.stat(safeDirPath).catch(e => {
                if (e.code === 'ENOENT') return null;
                throw e;
            });
            if (!stats) {
                 const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                 console.warn(`FileSystemTool.list_files: Directory not found '${displayPath}'.`);
                 return { result: null, error: `Directory not found: '${displayPath}'.` };
            }
            if (!stats.isDirectory()) {
                const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                return { result: null, error: `'${displayPath}' is not a directory.` };
            }
            const dirents = await fsp.readdir(safeDirPath, { withFileTypes: true });
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
            if (error.code === 'ENOENT') {
                 console.warn(`FileSystemTool.list_files: Directory not found '${displayPath}'.`);
                return { result: null, error: `Directory not found: '${displayPath}'.` };
            }
            console.error(`FileSystemTool.list_files: Error listing files in directory '${displayPath}':`, error.message);
            return { result: null, error: error.message };
        }
    }

    async create_pdf_from_text(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            return { result: null, error: "Invalid input: 'filename' is required and must be a non-empty string." };
        }
        if (!params.filename.toLowerCase().endsWith('.pdf')) {
            return { result: null, error: "Invalid input: 'filename' must end with '.pdf'." };
        }
        if (typeof params.text_content !== 'string') { // Allow empty string for text_content
            return { result: null, error: "Invalid input: 'text_content' is required and must be a string." };
        }
        const directory = params.directory || '';
        const fontSize = params.fontSize || 12;
        const fontName = params.fontName || 'Helvetica'; // Default PDF font
        const relativeFilePath = path.join(directory, params.filename);
        let safeFilePath;

        try {
            safeFilePath = await this._getSafePath(relativeFilePath);
            if (safeFilePath.endsWith(path.sep) || (await fsp.stat(safeFilePath).catch(() => null))?.isDirectory()) {
                 return { result: null, error: `Cannot create PDF, path '${relativeFilePath}' refers to a directory or would overwrite one.`};
            }

            return new Promise((resolve, reject) => {
                const doc = new PDFDocument({
                    size: 'A4',
                    margins: { top: 50, bottom: 50, left: 72, right: 72 },
                    autoFirstPage: false // Add page manually to ensure margins apply to first page too
                });

                const stream = fs.createWriteStream(safeFilePath);
                doc.pipe(stream);

                doc.addPage();
                doc.font(fontName).fontSize(fontSize).text(params.text_content, {
                    align: 'left',
                    lineBreak: true
                });
                doc.end();

                stream.on('finish', () => {
                    const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
                    resolve({ result: `PDF file '${displayPath}' created successfully.`, error: null });
                });
                stream.on('error', (err) => {
                    console.error(`FileSystemTool.create_pdf_from_text: Error writing PDF stream for '${relativeFilePath}':`, err.message);
                    fsp.unlink(safeFilePath).catch(unlinkErr => console.error(`FileSystemTool.create_pdf_from_text: Failed to delete partial PDF '${safeFilePath}':`, unlinkErr.message));
                    reject({ result: null, error: `Failed to write PDF to disk: ${err.message}` });
                });
            }).catch(error => { // Catch rejections from the promise, e.g., if stream.on('error') calls reject
                 return { result: null, error: error.error || error.message }; // Return the nested error object or message
            });

        } catch (error) { // Catch errors from _getSafePath or initial setup
            console.error(`FileSystemTool.create_pdf_from_text: Error creating PDF '${relativeFilePath}':`, error.message);
            return { result: null, error: error.message };
        }
    }
}

module.exports = FileSystemTool;
