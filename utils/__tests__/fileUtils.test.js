const path = require('path');
const { getTaskStateFilePath } = require('../fileUtils'); // Adjust path as necessary

describe('fileUtils', () => {
  describe('getTaskStateFilePath', () => {
    const mockRootDir = '/app'; // Example root directory
    const taskId = 'testTask123';

    beforeEach(() => {
      // Mock Date to return a consistent date for path generation
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2023-10-26T10:00:00.000Z')); // UTC date
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should generate the correct file path structure', () => {
      const expectedMonth = '10'; // October (getMonth() is 0-indexed, so 9 + 1)
      const expectedDay = '26';
      const expectedYear = '2023';
      const formattedDate = `${expectedMonth}${expectedDay}${expectedYear}`;

      const expectedDateDir = `tasks_${formattedDate}`;
      const expectedSaveDir = path.join(mockRootDir, 'saved_tasks', expectedDateDir);
      const expectedFilePath = path.join(expectedSaveDir, `task_state_${taskId}.json`);

      const filePath = getTaskStateFilePath(taskId, mockRootDir);
      expect(filePath).toBe(expectedFilePath);
    });

    it('should correctly format single-digit months and days with leading zeros', () => {
      jest.setSystemTime(new Date('2024-03-05T10:00:00.000Z')); // March 5th
      const expectedMonth = '03';
      const expectedDay = '05';
      const expectedYear = '2024';
      const formattedDate = `${expectedMonth}${expectedDay}${expectedYear}`;

      const expectedDateDir = `tasks_${formattedDate}`;
      const expectedSaveDir = path.join(mockRootDir, 'saved_tasks', expectedDateDir);
      const expectedFilePath = path.join(expectedSaveDir, `task_state_${taskId}.json`);

      const filePath = getTaskStateFilePath(taskId, mockRootDir);
      expect(filePath).toBe(expectedFilePath);
    });

    it('should use the provided rootDir in the path', () => {
      const customRootDir = '/test/root';
      const filePath = getTaskStateFilePath(taskId, customRootDir);
      expect(filePath.startsWith(path.join(customRootDir, 'saved_tasks'))).toBe(true);
    });
  });
});
