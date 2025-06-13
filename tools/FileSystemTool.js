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
        if (typeof params.text_content !== 'string') {
            return { result: null, error: "Invalid input: 'text_content' is required and must be a string." };
        }
        const directory = params.directory || '';
        const fontSize = params.fontSize || 12;
        const fontName = params.fontName || 'Helvetica';
        const customFontFileName = params.customFontFileName || null; // New parameter
        const relativeFilePath = path.join(directory, params.filename);
        let safeFilePath;

        try {
            safeFilePath = await this._getSafePath(relativeFilePath);

            // Check if safeFilePath points to an existing directory before creating write stream
            try {
                const stats = await fsp.stat(safeFilePath);
                if (stats.isDirectory()) {
                    return { result: null, error: `Cannot create PDF, path '${relativeFilePath}' points to an existing directory.` };
                }
            } catch (statError) {
                if (statError.code !== 'ENOENT') { throw statError; } // Re-throw unexpected errors
                // ENOENT is fine, means file doesn't exist, which is expected for creation.
            }

            return new Promise(async (resolve, reject) => { // Made promise callback async for await fsp.access
                const doc = new PDFDocument({
                    size: 'A4',
                    margins: { top: 50, bottom: 50, left: 72, right: 72 },
                    autoFirstPage: false
                });

                const stream = fs.createWriteStream(safeFilePath);
                doc.pipe(stream);
                doc.addPage();

                let effectiveFont = fontName;
                let customFontApplied = false;
                let fontWarning = null;

                if (customFontFileName) {
                    if (typeof customFontFileName !== 'string' || (!customFontFileName.toLowerCase().endsWith('.ttf') && !customFontFileName.toLowerCase().endsWith('.otf'))) {
                        fontWarning = `Invalid 'customFontFileName': Must be a string ending with .ttf or .otf. Falling back to '${fontName}'.`;
                        console.warn(`FileSystemTool: ${fontWarning}`);
                        doc.font(fontName);
                    } else {
                        // Assuming assets/fonts/ is at the root of the project, relative to where the process is run.
                        // __dirname for FileSystemTool.js is tools/
                        const fontPath = path.join(__dirname, '..', 'assets', 'fonts', customFontFileName);
                        try {
                            await fsp.access(fontPath, fs.constants.R_OK);
                            doc.font(fontPath);
                            effectiveFont = customFontFileName;
                            customFontApplied = true;
                            console.log(`FileSystemTool: Using custom font: ${fontPath}`);
                        } catch (fontError) {
                            console.warn(`FileSystemTool: Custom font '${customFontFileName}' not found/readable at '${fontPath}'. Falling back to '${fontName}'. Error: ${fontError.message}`);
                            fontWarning = `Custom font '${customFontFileName}' not found or not readable. Used default font '${fontName}'.`;
                            doc.font(fontName); // Fallback
                        }
                    }
                } else {
                    doc.font(fontName);
                }

                doc.fontSize(fontSize).text(params.text_content, {
                    align: 'left',
                    lineBreak: true
                });
                doc.end();

                stream.on('finish', () => {
                    const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
                    let successMessage = `PDF file '${displayPath}' created successfully. Font used: ${customFontApplied ? effectiveFont : fontName}.`;
                    if (fontWarning) {
                        successMessage += ` Warning: ${fontWarning}`;
                    }
                    resolve({ result: successMessage, error: null });
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
