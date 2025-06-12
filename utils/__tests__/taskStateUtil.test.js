const fs = require('fs').promises; // Use fs.promises for async file operations
const path = require('path');
const { saveTaskState, loadTaskState } = require('../taskStateUtil'); // Adjust path as necessary

// Mock fs.promises module
jest.mock('fs', () => ({
    ...jest.requireActual('fs'), // Import and retain default behavior
    promises: {
      mkdir: jest.fn(),
      writeFile: jest.fn(),
      readFile: jest.fn(),
      access: jest.fn(), // Often used by loadTaskState to check existence
    },
  }));


describe('taskStateUtil', () => {
  beforeEach(() => {
    // Reset mocks before each test
    fs.mkdir.mockReset();
    fs.writeFile.mockReset();
    fs.readFile.mockReset();
    fs.access.mockReset();
  });

  describe('saveTaskState', () => {
    const taskStateData = { taskId: 'test1', data: 'some data' };
    const testFilePath = '/test/dir/tasks_10262023/task_state_test1.json';
    const testDir = path.dirname(testFilePath);

    it('should create directory and write file successfully', async () => {
      fs.mkdir.mockResolvedValue(undefined); // Simulate directory creation success
      fs.writeFile.mockResolvedValue(undefined); // Simulate file write success

      const result = await saveTaskState(taskStateData, testFilePath);

      expect(fs.mkdir).toHaveBeenCalledWith(testDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(testFilePath, JSON.stringify(taskStateData, null, 2), 'utf8');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Task state saved successfully.');
    });

    it('should return error if directory creation fails', async () => {
      const mkdirError = new Error('Failed to create directory');
      fs.mkdir.mockRejectedValue(mkdirError);

      const result = await saveTaskState(taskStateData, testFilePath);

      expect(fs.mkdir).toHaveBeenCalledWith(testDir, { recursive: true });
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.message).toBe(`Error saving task state: ${mkdirError.message}`);
    });

    it('should return error if file writing fails', async () => {
      const writeFileError = new Error('Failed to write file');
      fs.mkdir.mockResolvedValue(undefined); // Directory creation is fine
      fs.writeFile.mockRejectedValue(writeFileError);

      const result = await saveTaskState(taskStateData, testFilePath);

      expect(fs.mkdir).toHaveBeenCalledWith(testDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(testFilePath, JSON.stringify(taskStateData, null, 2), 'utf8');
      expect(result.success).toBe(false);
      expect(result.message).toBe(`Error saving task state: ${writeFileError.message}`);
    });
  });

  describe('loadTaskState', () => {
    const testFilePath = '/test/dir/tasks_10262023/task_state_loadTest1.json';
    const taskStateData = { taskId: 'loadTest1', data: 'loaded data' };

    it('should load and parse task state successfully', async () => {
      fs.access.mockResolvedValue(undefined); // File exists
      fs.readFile.mockResolvedValue(JSON.stringify(taskStateData));

      const result = await loadTaskState(testFilePath);

      expect(fs.access).toHaveBeenCalledWith(testFilePath);
      expect(fs.readFile).toHaveBeenCalledWith(testFilePath, 'utf8');
      expect(result.success).toBe(true);
      expect(result.taskState).toEqual(taskStateData);
    });

    it('should return error if file does not exist (access fails)', async () => {
      const accessError = new Error('File not found');
      fs.access.mockRejectedValue(accessError);

      const result = await loadTaskState(testFilePath);

      expect(fs.access).toHaveBeenCalledWith(testFilePath);
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.message).toBe(`Error loading task state from ${testFilePath}: ${accessError.message}`);
    });

    it('should return error if file reading fails', async () => {
      const readFileError = new Error('Failed to read file');
      fs.access.mockResolvedValue(undefined); // File exists
      fs.readFile.mockRejectedValue(readFileError);

      const result = await loadTaskState(testFilePath);

      expect(fs.access).toHaveBeenCalledWith(testFilePath);
      expect(fs.readFile).toHaveBeenCalledWith(testFilePath, 'utf8');
      expect(result.success).toBe(false);
      expect(result.message).toBe(`Error loading task state from ${testFilePath}: ${readFileError.message}`);
    });

    it('should return error if JSON parsing fails', async () => {
      fs.access.mockResolvedValue(undefined); // File exists
      fs.readFile.mockResolvedValue('{"invalidJson":,'); // Malformed JSON

      const result = await loadTaskState(testFilePath);

      expect(fs.access).toHaveBeenCalledWith(testFilePath);
      expect(fs.readFile).toHaveBeenCalledWith(testFilePath, 'utf8');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Error parsing task state JSON');
    });
  });
});
