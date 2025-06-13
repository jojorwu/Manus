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
        const normalizedUserPath = path.normalize(userPath);
        if (normalizedUserPath.split(path.sep).includes('..')) {
            // This is a returned error, already Russian.
            throw new Error("FileSystemTool: Относительные компоненты пути '..' не разрешены.");
        }
        const resolvedPath = path.join(this.taskWorkspaceDir, normalizedUserPath);
        if (!resolvedPath.startsWith(this.taskWorkspaceDir) && resolvedPath !== this.taskWorkspaceDir) {
            console.error(t('FS_PATH_TRAVERSAL_ATTEMPT_LOG', { componentName: 'FileSystemTool', workspaceDir: this.taskWorkspaceDir, userPath: userPath, resolvedPath: resolvedPath }));
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

    async list_files(params = {}) {
        const directory = params.directory || '';
        try {
            const safeDirPath = await this._getSafePath(directory);
            const stats = await fsp.stat(safeDirPath).catch(e => {
                if (e.code === 'ENOENT') return null; // Will be handled by !stats check below
                throw e; // Other stat errors
            });
            if (!stats) {
                 const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                 console.warn(t('FS_LIST_FILES_DIR_NOT_FOUND_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }));
                 // Returned error is already Russian.
                 return { result: null, error: `Директория не найдена: '${displayPath}'.` };
            }
            if (!stats.isDirectory()) {
                const displayPath = path.relative(this.taskWorkspaceDir, safeDirPath);
                // Returned error is already Russian.
                return { result: null, error: `'${displayPath}' не является директорией.` };
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
                 console.warn(t('FS_LIST_FILES_DIR_NOT_FOUND_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }));
                 // Returned error is already Russian.
                return { result: null, error: `Директория не найдена: '${displayPath}'.` };
            }
            console.error(t('FS_LIST_FILES_ERROR_LOG', { componentName: 'FileSystemTool', displayPath: displayPath }), error);
            if (error.message.startsWith("FileSystemTool:")) return { result: null, error: error.message }; // Already Russian
            // Generic error message for other cases, keeping original error.message for details
            return { result: null, error: `Ошибка при обработке директории '${displayPath}': ${error.message}` };
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
