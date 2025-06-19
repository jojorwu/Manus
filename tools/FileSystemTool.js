// tools/FileSystemTool.js
const fsp = require('fs').promises; // Renamed for clarity
const fs = require('fs'); // For createWriteStream (synchronous part of stream setup)
const path =require('path');
const PDFDocument = require('pdfkit');
const { t } = require('../utils/localization');

class FileSystemTool {
    constructor(taskWorkspaceDir) {
        if (!taskWorkspaceDir || typeof taskWorkspaceDir !== 'string' || taskWorkspaceDir.trim() === "") {
            // This error is thrown on construction, so it might not be caught by the standard error handling of execute()
            // For now, keeping it in English as it's a setup error. If localization is needed here, it's more complex.
            // Consider: console.error(t("FS_CONSTRUCTOR_ERROR", { message: "taskWorkspaceDir is required..."}));
            throw new Error("FileSystemTool: taskWorkspaceDir is required and must be a non-empty string.");
        }
        this.taskWorkspaceDir = path.resolve(taskWorkspaceDir); // Ensure it's an absolute path
        // Create the base workspace directory if it doesn't exist
        fsp.mkdir(this.taskWorkspaceDir, { recursive: true })
            .catch(err => console.error(t('FS_ROOT_DIR_CREATION_FAILED_LOG', { componentName: 'FileSystemTool', path: this.taskWorkspaceDir }), err));
    }

    async _getSafePath(userPath = '') {
        if (typeof userPath !== 'string') {
            console.error(t('FS_GETSAFEPATH_NOT_STRING_LOG', { componentName: 'FileSystemTool' }));
            // This is a returned error, already Russian.
            throw new Error("FileSystemTool: Внутренняя ошибка - userPath должен быть строкой для _getSafePath.");
        }

        // Sanitize each path component to prevent malicious characters.
        const sanitizedUserPath = userPath
            .split(path.sep)
            .map(part => part.replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 255))
            .join(path.sep);

        const normalizedUserPath = path.normalize(sanitizedUserPath);

        // Double check for path traversal components after sanitization and normalization
        if (normalizedUserPath.includes('..')) {
            // This is a returned error, already Russian.
            throw new Error("FileSystemTool: Относительные компоненты пути '..' не разрешены, даже после санации.");
        }

        const resolvedPath = path.join(this.taskWorkspaceDir, normalizedUserPath);

        // Final check to ensure the path does not escape the workspace directory
        if (!resolvedPath.startsWith(this.taskWorkspaceDir)) {
            console.error(t('FS_PATH_TRAVERSAL_ATTEMPT_LOG', { componentName: 'FileSystemTool', workspaceDir: this.taskWorkspaceDir, userPath: userPath, sanitizedUserPath: sanitizedUserPath, resolvedPath: resolvedPath }));
            // This is a returned error, already Russian.
            throw new Error("FileSystemTool: Обнаружена попытка обхода пути.");
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
            return { result: null, error: "Неверный ввод: 'filename' является обязательным и должен быть непустой строкой." };
        }
        if (params.content === undefined || params.content === null || typeof params.content !== 'string') {
            return { result: null, error: "Неверный ввод: 'content' является обязательным и должен быть строкой (может быть пустой)." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            try {
                const stats = await fsp.stat(safeFilePath);
                if (stats.isDirectory()) {
                    return { result: null, error: `Не удается создать файл, путь '${relativeFilePath}' указывает на существующую директорию.`};
                }
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            await fsp.writeFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            // Returned result is already Russian.
            return { result: `Файл '${displayPath}' успешно создан.`, error: null };
        } catch (error) {
            console.error(t('FS_CREATE_FILE_ERROR_LOG', { componentName: 'FileSystemTool', filename: params.filename, directory: directory }), error);
            return { result: null, error: error.message };
        }
    }

    async read_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'filename' является обязательным и должен быть непустой строкой." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        let safeFilePath;
        try {
            safeFilePath = await this._getSafePath(relativeFilePath);
            const stats = await fsp.stat(safeFilePath).catch(e => {
                if (e.code === 'ENOENT') throw e; // Handled by specific ENOENT catch below
                throw e; // Other stat errors
            });
            if (stats && stats.isDirectory()) {
                // Returned error is already Russian.
                 return { result: null, error: `Не удается прочитать файл, путь '${relativeFilePath}' указывает на директорию.`};
            }
            const content = await fsp.readFile(safeFilePath, 'utf8');
            return { result: content, error: null };
        } catch (error) {
            const displayPath = safeFilePath ? path.relative(this.taskWorkspaceDir, safeFilePath) : relativeFilePath;
            if (error.code === 'ENOENT') {
                console.warn(t('FS_READ_FILE_NOT_FOUND_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }));
                // Returned error is already Russian.
                return { result: null, error: `Файл не найден: '${displayPath}'.` };
            }
            console.error(t('FS_READ_FILE_ERROR_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }), error);
            return { result: null, error: error.message };
        }
    }

    async append_to_file(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'filename' является обязательным и должен быть непустой строкой." };
        }
        if (typeof params.content !== 'string' || params.content === "") { // Assuming content must be non-empty for append
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'content' является обязательным и должен быть непустой строкой для дозаписи." };
        }
        const directory = params.directory || '';
        const relativeFilePath = path.join(directory, params.filename);
        try {
            const safeFilePath = await this._getSafePath(relativeFilePath);
            try {
                const stats = await fsp.stat(safeFilePath);
                if (stats.isDirectory()) {
                    // Returned error is already Russian.
                    return { result: null, error: `Не удается дописать в файл, путь '${relativeFilePath}' указывает на существующую директорию.`};
                }
            } catch (e) {
                if (e.code !== 'ENOENT') throw e; // If it's not ENOENT, throw and let outer catch handle.
            }
            await fsp.appendFile(safeFilePath, params.content, 'utf8');
            const displayPath = path.relative(this.taskWorkspaceDir, safeFilePath);
            // Returned result is already Russian.
            return { result: `Содержимое добавлено в '${displayPath}'.`, error: null };
        } catch (error) {
            console.error(t('FS_APPEND_FILE_ERROR_LOG', { componentName: 'FileSystemTool', filename: params.filename, directory: directory }), error);
            return { result: null, error: error.message };
        }
    }

    async overwrite_file(params) {
        return this.create_file(params);
    }

    async _recursiveList(fullDirectoryPath, currentDepth, maxDepth, baseWorkspaceDir) {
        const items = [];
        try {
            const dirents = await fsp.readdir(fullDirectoryPath, { withFileTypes: true });
            for (const dirent of dirents) {
                const entryName = dirent.name;
                const entryFullPath = path.join(fullDirectoryPath, entryName);
                // Calculate path relative to the taskWorkspaceDir for consistent output
                const relativeToWorkspacePath = path.relative(baseWorkspaceDir, entryFullPath);

                items.push({
                    path: relativeToWorkspacePath.replace(/\\/g, '/'), // Ensure POSIX-style slashes
                    type: dirent.isDirectory() ? 'directory' : 'file'
                });

                if (dirent.isDirectory() && currentDepth < maxDepth) {
                    const subItems = await this._recursiveList(
                        entryFullPath,
                        currentDepth + 1,
                        maxDepth,
                        baseWorkspaceDir
                    );
                    items.push(...subItems);
                }
            }
        } catch (error) {
            // Log error but don't throw, to allow listing of accessible parts
            console.error(t('FS_RECURSIVE_LIST_ERROR_LOG', { componentName: 'FileSystemTool', path: fullDirectoryPath, message: error.message }));
            // Optionally, could add an error marker to items if needed:
            // items.push({ path: path.relative(baseWorkspaceDir, fullDirectoryPath).replace(/\\/g, '/'), type: 'error', message: error.message });
        }
        return items;
    }


    async list_files(params = {}) {
        const directory = params.directory || ''; // Relative to taskWorkspaceDir
        const recursive = params.recursive === true; // Default to false
        const maxDepth = params.maxDepth === undefined ? 3 : Number(params.maxDepth); // Default to 3 if recursive

        if (isNaN(maxDepth) || maxDepth < 1) {
            return { result: null, error: "Неверный ввод: 'maxDepth' должен быть положительным числом." };
        }

        let safeTargetDirPath; // This will be the absolute path to the target directory
        try {
            // _getSafePath ensures the path is within taskWorkspaceDir and creates it if necessary (though for list_files, it should exist)
            // For list_files, we don't want to create the directory if it doesn't exist, so we add a check.
            safeTargetDirPath = await this._getSafePath(directory);

            try {
                const stats = await fsp.stat(safeTargetDirPath);
                if (!stats.isDirectory()) {
                    const displayPath = path.relative(this.taskWorkspaceDir, safeTargetDirPath).replace(/\\/g, '/');
                    return { result: null, error: `'${displayPath}' не является директорией.` };
                }
            } catch (statError) {
                if (statError.code === 'ENOENT') {
                    const displayPath = path.relative(this.taskWorkspaceDir, safeTargetDirPath).replace(/\\/g, '/');
                    console.warn(t('FS_LIST_FILES_DIR_NOT_FOUND_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }));
                    return { result: null, error: `Директория не найдена: '${displayPath}'.` };
                }
                throw statError; // Other stat errors
            }

        } catch (error) { // Catch errors from _getSafePath (e.g., path traversal)
            console.error(t('FS_LIST_FILES_ERROR_LOG', { componentName: 'FileSystemTool', displayPath: directory }), error);
            if (error.message.startsWith("FileSystemTool:")) return { result: null, error: error.message };
            return { result: null, error: `Ошибка при доступе к директории '${directory}': ${error.message}` };
        }

        try {
            if (recursive) {
                const items = await this._recursiveList(safeTargetDirPath, 1, maxDepth, this.taskWorkspaceDir);
                items.sort((a, b) => a.path.localeCompare(b.path)); // Sort for consistent output
                return { result: items, error: null };
            } else {
                // Non-recursive listing
                const dirents = await fsp.readdir(safeTargetDirPath, { withFileTypes: true });
                const items = [];
                for (const dirent of dirents) {
                    const relativeToWorkspacePath = path.relative(this.taskWorkspaceDir, path.join(safeTargetDirPath, dirent.name));
                    items.push({
                        path: relativeToWorkspacePath.replace(/\\/g, '/'), // Ensure POSIX-style slashes
                        type: dirent.isDirectory() ? 'directory' : 'file'
                    });
                }
                items.sort((a, b) => a.path.localeCompare(b.path)); // Sort for consistent output
                return { result: items, error: null };
            }
        } catch (error) {
            // Catch errors from readdir or recursive list (though _recursiveList also has a try-catch)
            const displayPath = path.relative(this.taskWorkspaceDir, safeTargetDirPath).replace(/\\/g, '/');
            console.error(t('FS_LIST_FILES_ERROR_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }), error);
            return { result: null, error: `Ошибка при чтении содержимого директории '${displayPath}': ${error.message}` };
        }
    }

    async create_pdf_from_text(params) {
        if (!params || typeof params.filename !== 'string' || params.filename.trim() === "") {
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'filename' является обязательным и должен быть непустой строкой." };
        }
        if (!params.filename.toLowerCase().endsWith('.pdf')) {
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'filename' должен заканчиваться на '.pdf'." };
        }
        if (typeof params.text_content !== 'string') {
            // Returned error is already Russian.
            return { result: null, error: "Неверный ввод: 'text_content' является обязательным и должен быть строкой." };
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
                    // Returned error is already Russian.
                    return { result: null, error: `Не удается создать PDF, путь '${relativeFilePath}' указывает на существующую директорию.` };
                }
            } catch (statError) {
                if (statError.code !== 'ENOENT') {
                    throw statError;
                }
                // ENOENT is fine, means file doesn't exist, which is expected for creation.
            }

            return new Promise(async (resolve, reject) => { // eslint-disable-line no-async-promise-executor
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
                        // fontWarning is already Russian.
                        fontWarning = `Неверный 'customFontFileName': Должен быть строкой, заканчивающейся на .ttf или .otf. Используется шрифт по умолчанию '${fontName}'.`;
                        console.warn(t('FS_PDF_CUSTOM_FONT_INVALID_LOG', { componentName: 'FileSystemTool', warningMessage: fontWarning }));
                        doc.font(fontName);
                    } else {
                        const fontPath = path.join(__dirname, '..', 'assets', 'fonts', customFontFileName);
                        try {
                            await fsp.access(fontPath, fs.constants.R_OK);
                            doc.font(fontPath);
                            effectiveFont = customFontFileName;
                            customFontApplied = true;
                            console.log(t('FS_PDF_CUSTOM_FONT_USING_LOG', { componentName: 'FileSystemTool', fontPath: fontPath }));
                        } catch (fontError) {
                            // fontWarning is already Russian.
                            fontWarning = `Кастомный шрифт '${customFontFileName}' не найден или не читается. Использован шрифт по умолчанию '${fontName}'.`;
                            console.warn(t('FS_PDF_CUSTOM_FONT_NOT_FOUND_LOG', { componentName: 'FileSystemTool', customFontFileName: customFontFileName, fontPath: fontPath, fallbackFont: fontName }), fontError);
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
                    // successMessage and fontWarning are already Russian.
                    let successMessage = `PDF файл '${displayPath}' успешно создан. Использованный шрифт: ${customFontApplied ? effectiveFont : fontName}.`;
                    if (fontWarning) {
                        successMessage += ` Предупреждение: ${fontWarning}`;
                    }
                    resolve({ result: successMessage, error: null });
                });
                stream.on('error', (err) => {
                    console.error(t('FS_PDF_STREAM_ERROR_LOG', { componentName: 'FileSystemTool', relativeFilePath: relativeFilePath }), err);
                    fsp.unlink(safeFilePath).catch(unlinkErr => console.error(t('FS_PDF_UNLINK_ERROR_LOG', { componentName: 'FileSystemTool', safeFilePath: safeFilePath }), unlinkErr));
                    // Returned error is already Russian.
                    reject({ result: null, error: `Не удалось записать PDF на диск: ${err.message}` });
                });
            }).catch(error => {
                 return error;
            });

        } catch (error) {
            console.error(t('FS_PDF_CREATE_ERROR_LOG', { componentName: 'FileSystemTool', relativeFilePath: relativeFilePath }), error);
            if (error.message.startsWith("FileSystemTool:")) return { result: null, error: error.message }; // Already Russian
            return { result: null, error: `Ошибка при создании PDF '${relativeFilePath}': ${error.message}` };
        }
    }
}

module.exports = FileSystemTool;
