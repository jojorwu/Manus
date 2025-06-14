// core/MemoryManager.test.js
const MemoryManager = require('./MemoryManager');
const fsp = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

jest.mock('fs/promises');
jest.mock('crypto');

const TASK_DIR_PATH = '/test/task_dir'; // Example task directory path
const MEMORY_CATEGORY_FILE_NAME = 'test_memory.md';
const ORIGINAL_FILE_PATH = path.join(TASK_DIR_PATH, 'memory_bank', MEMORY_CATEGORY_FILE_NAME);
const SUMMARY_FILE_PATH = path.join(TASK_DIR_PATH, 'memory_bank', 'test_memory_summary.md');
const META_FILE_PATH = path.join(TASK_DIR_PATH, 'memory_bank', 'test_memory_summary.md.meta.json');

describe('MemoryManager', () => {
    let memoryManager;
    let mockAiService;
    let mockCreateHash;
    let mockHashUpdate;
    let mockHashDigest;

    beforeEach(() => {
        memoryManager = new MemoryManager();
        mockAiService = {
            generateText: jest.fn(),
            baseConfig: { summarizationModel: 'default-summary-model' } // Mock baseConfig
        };

        // Setup crypto mock
        mockHashUpdate = jest.fn().mockReturnThis();
        mockHashDigest = jest.fn();
        mockCreateHash = jest.fn(() => ({
            update: mockHashUpdate,
            digest: mockHashDigest,
        }));
        crypto.createHash.mockImplementation(mockCreateHash);

        // Reset fsp mocks
        fsp.readFile.mockReset();
        fsp.writeFile.mockReset();
        fsp.mkdir.mockResolvedValue(undefined); // Default to successful directory creation
    });

    describe('_calculateHash', () => {
        test('should calculate SHA256 hash for string content', () => {
            mockHashDigest.mockReturnValueOnce('hashed_content');
            const hash = memoryManager._calculateHash('some content');
            expect(mockCreateHash).toHaveBeenCalledWith('sha256');
            expect(mockHashUpdate).toHaveBeenCalledWith('some content');
            expect(mockHashDigest).toHaveBeenCalledWith('hex');
            expect(hash).toBe('hashed_content');
        });

        test('should return null if content is not a string', () => {
            // const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(memoryManager._calculateHash(123)).toBeNull();
            // expect(consoleWarnSpy).toHaveBeenCalled();
            // consoleWarnSpy.mockRestore();
        });
    });

    describe('_getSummaryMetaFilePath', () => {
        test('should return correct meta file path', () => {
            expect(memoryManager._getSummaryMetaFilePath('/path/to/summary.txt'))
                .toBe('/path/to/summary.txt.meta.json');
        });
    });


    describe('getSummarizedMemory', () => {
        const shortContent = "This is short content.";
        const longContent = "This is very long content".repeat(200); // > 3000 chars
        const originalHashShort = 'hash_short_content';
        const originalHashLong = 'hash_long_content';
        const summaryContent = "Summary of long content.";

        const summarizationOptions = {
            maxOriginalLength: 100, // Easier to test with smaller length
            promptTemplate: "Summarize: {text_to_summarize}",
            llmParams: { model: 'test-llm-model' },
            cacheSummary: true,
            forceSummarize: false,
            defaultValue: "default_val"
        };

        test('1. Content shorter than maxOriginalLength, returns original content', async () => {
            fsp.readFile.mockResolvedValue(shortContent); // Mock reading original file

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(result).toBe(shortContent);
            expect(mockAiService.generateText).not.toHaveBeenCalled();
            expect(fsp.writeFile).not.toHaveBeenCalled(); // No summary or meta should be written
        });

        test('2. Content long, no cache: AI called, summary and meta saved', async () => {
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                throw { code: 'ENOENT' }; // For summary and meta files
            });
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(mockAiService.generateText).toHaveBeenCalledWith(
                summarizationOptions.promptTemplate.replace('{text_to_summarize}', longContent),
                expect.objectContaining({ model: 'test-llm-model' })
            );
            expect(result).toBe(summaryContent);
            // Check if summary and meta are written
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, summaryContent, 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH,
                JSON.stringify({ originalContentHash: originalHashLong, summaryGeneratedTimestamp: expect.any(String) }, null, 2),
                'utf8'
            );
        });

        test('3. Content long, valid cache exists: cached summary returned, AI not called', async () => {
            mockHashDigest.mockReturnValue(originalHashLong); // Hash of current original content
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                if (filePath === META_FILE_PATH) return JSON.stringify({ originalContentHash: originalHashLong }); // Matching hash
                if (filePath === SUMMARY_FILE_PATH) return "cached summary";
                throw { code: 'ENOENT' };
            });

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(result).toBe("cached summary");
            expect(mockAiService.generateText).not.toHaveBeenCalled();
        });

        test('4. Content long, cache exists but meta hash mismatches: AI called, new summary and meta saved', async () => {
            mockHashDigest.mockReturnValue(originalHashLong); // Hash of current original content
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                if (filePath === META_FILE_PATH) return JSON.stringify({ originalContentHash: "different_hash" }); // Mismatching hash
                // Summary file might exist or not, doesn't matter as meta check fails first
                throw { code: 'ENOENT' };
            });
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe(summaryContent);
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, summaryContent, 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH,
                JSON.stringify({ originalContentHash: originalHashLong, summaryGeneratedTimestamp: expect.any(String) }, null, 2),
                'utf8'
            );
        });

        test('5. Content long, meta file exists but summary file is missing: AI called, new summary and meta saved', async () => {
            mockHashDigest.mockReturnValue(originalHashLong);
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                if (filePath === META_FILE_PATH) return JSON.stringify({ originalContentHash: originalHashLong }); // Meta matches
                if (filePath === SUMMARY_FILE_PATH) throw { code: 'ENOENT' }; // Summary missing
                throw { code: 'ENOENT' };
            });
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe(summaryContent);
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, summaryContent, 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH, JSON.stringify({ originalContentHash: originalHashLong, summaryGeneratedTimestamp: expect.any(String) }, null, 2), 'utf8');
        });

        test('6. Content long, meta file corrupted (not JSON): AI called, new summary and meta saved', async () => {
            mockHashDigest.mockReturnValue(originalHashLong);
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                if (filePath === META_FILE_PATH) return "this is not json"; // Corrupted meta
                throw { code: 'ENOENT' };
            });
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe(summaryContent);
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, summaryContent, 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH, JSON.stringify({ originalContentHash: originalHashLong, summaryGeneratedTimestamp: expect.any(String) }, null, 2), 'utf8');
        });

        test('7. forceSummarize true for short content: AI called, summary and meta saved', async () => {
            fsp.readFile.mockResolvedValue(shortContent); // Original is short
            mockHashDigest.mockReturnValue(originalHashShort);
            mockAiService.generateText.mockResolvedValue("Summary of short content");

            const opts = { ...summarizationOptions, forceSummarize: true };
            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, opts);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe("Summary of short content");
            expect(fsp.writeFile).toHaveBeenCalledWith(expect.stringContaining('_summary.md'), "Summary of short content", 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(expect.stringContaining('.meta.json'),
                JSON.stringify({ originalContentHash: originalHashShort, summaryGeneratedTimestamp: expect.any(String) }, null, 2),
                'utf8'
            );
        });

        test('8. forceSummarize true for long content with valid cache: AI called, summary and meta updated', async () => {
            mockHashDigest.mockReturnValue(originalHashLong);
            fsp.readFile.mockImplementation(async (filePath) => {
                if (filePath === ORIGINAL_FILE_PATH) return longContent;
                if (filePath === META_FILE_PATH) return JSON.stringify({ originalContentHash: originalHashLong });
                if (filePath === SUMMARY_FILE_PATH) return "old cached summary";
                throw { code: 'ENOENT' };
            });
            mockAiService.generateText.mockResolvedValue("new forced summary");

            const opts = { ...summarizationOptions, forceSummarize: true };
            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, opts);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe("new forced summary");
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, "new forced summary", 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH,
                JSON.stringify({ originalContentHash: originalHashLong, summaryGeneratedTimestamp: expect.any(String) }, null, 2),
                'utf8'
            );
        });

        test('9. cacheSummary false: AI called (if needed), but summary/meta not saved', async () => {
            fsp.readFile.mockResolvedValue(longContent); // Original is long, needs summarization
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const opts = { ...summarizationOptions, cacheSummary: false };
            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, opts);

            expect(mockAiService.generateText).toHaveBeenCalledTimes(1);
            expect(result).toBe(summaryContent);
            expect(fsp.writeFile).not.toHaveBeenCalled(); // No summary or meta should be written
        });

        test('10. Original file not found: returns defaultValue', async () => {
            fsp.readFile.mockRejectedValue({ code: 'ENOENT' }); // Mock original file not found

            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(result).toBe(summarizationOptions.defaultValue);
            expect(mockAiService.generateText).not.toHaveBeenCalled();
        });

        test('11. aiService.generateText throws an error: getSummarizedMemory re-throws', async () => {
            fsp.readFile.mockResolvedValue(longContent);
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockRejectedValue(new Error("LLM API Error"));

            await expect(memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions))
                .rejects.toThrow(`Failed to summarize '${MEMORY_CATEGORY_FILE_NAME}': LLM API Error`);
        });

        test('12. Error during writeFile for summary or meta: summary still returned (if generated)', async () => {
            fsp.readFile.mockResolvedValue(longContent);
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockResolvedValue(summaryContent);
            fsp.writeFile.mockRejectedValueOnce(new Error("Failed to write summary file")); // First writeFile (summary) fails

            // const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const result = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);

            expect(result).toBe(summaryContent); // Summary still returned
            expect(fsp.writeFile).toHaveBeenCalledTimes(1); // Attempted to write summary
            // expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to cache summary or meta"), expect.any(Error));
            // consoleErrorSpy.mockRestore();

            // Test meta write failure
            fsp.writeFile.mockReset();
            fsp.writeFile
                .mockResolvedValueOnce(undefined) // Summary write succeeds
                .mockRejectedValueOnce(new Error("Failed to write meta file")); // Meta write fails

            // consoleErrorSpy.mockClear();
            const result2 = await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions);
            expect(result2).toBe(summaryContent);
            expect(fsp.writeFile).toHaveBeenCalledWith(SUMMARY_FILE_PATH, summaryContent, 'utf8');
            expect(fsp.writeFile).toHaveBeenCalledWith(META_FILE_PATH, expect.any(String), 'utf8');
            // expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to cache summary or meta"), expect.any(Error));
            // consoleErrorSpy.mockRestore();
        });

        test('13. _calculateHash returns null: throws error', async () => {
            fsp.readFile.mockResolvedValue(longContent);
            // @ts-ignore
            memoryManager._calculateHash = jest.fn(() => null); // Force hash to be null

            await expect(memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, summarizationOptions))
                .rejects.toThrow("MemoryManager: Could not calculate hash for original content.");
        });

        test('Uses default summarization model from aiService.baseConfig if llmParams.model not provided', async () => {
            fsp.readFile.mockResolvedValue(longContent);
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const opts = { ...summarizationOptions, llmParams: { temperature: 0.5 } }; // No model in llmParams
            await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiService, opts);

            expect(mockAiService.generateText).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'default-summary-model', temperature: 0.5 })
            );
        });

        test('Uses fallback summarization model if not in llmParams or aiService.baseConfig', async () => {
            fsp.readFile.mockResolvedValue(longContent);
            mockHashDigest.mockReturnValue(originalHashLong);
            mockAiService.generateText.mockResolvedValue(summaryContent);

            const mockAiServiceWithoutBaseConfigModel = { ...mockAiService, baseConfig: {} };
            const opts = { ...summarizationOptions, llmParams: {} }; // No model anywhere
            await memoryManager.getSummarizedMemory(TASK_DIR_PATH, MEMORY_CATEGORY_FILE_NAME, mockAiServiceWithoutBaseConfigModel, opts);

            expect(mockAiService.generateText).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-3.5-turbo' }) // Default fallback
            );
        });
    });
});
