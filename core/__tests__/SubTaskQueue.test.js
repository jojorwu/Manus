const SubTaskQueue = require('../SubTaskQueue'); // Adjust path as necessary

// Mock the logger at the top level
jest.mock('../logger', () => ({ // Adjust path if logger is in the same directory
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));
const logger = require('../logger'); // Import the mocked logger


describe('SubTaskQueue', () => {
  let subTaskQueue;
  let mockTask;
  let mockCallback;

  beforeEach(() => {
    subTaskQueue = new SubTaskQueue();
    mockTask = {
      sub_task_id: 'sub123',
      parent_task_id: 'parent456',
      assigned_agent_role: 'TestRole',
      tool_name: 'TestTool',
      sub_task_input: { data: 'input' },
      narrative_step: 'Perform test action',
    };
    mockCallback = jest.fn();

    // Clear logger mocks
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  // No afterEach needed to restore console.log as it's not spied on anymore

  describe('enqueueTask Behavior', () => {
    it('should add task to internal tasks array if no subscribers exist for the role', () => {
      subTaskQueue.enqueueTask(mockTask);
      expect(subTaskQueue.tasks.length).toBe(1);
      expect(subTaskQueue.tasks[0]).toEqual(mockTask);
    });

    it('should emit task directly to subscriber and NOT add to internal tasks array if subscriber exists', () => {
      const agentRole = 'TestRole';
      subTaskQueue.subscribe(agentRole, mockCallback); // Subscriber exists

      subTaskQueue.enqueueTask(mockTask);

      expect(subTaskQueue.tasks.length).toBe(0); // Should not be added to tasks array
      expect(mockCallback).toHaveBeenCalledWith(mockTask);
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should emit "newTask" event when a task is enqueued', (done) => {
      subTaskQueue.on('newTask', (taskMessage) => {
        expect(taskMessage).toEqual(mockTask);
        done();
      });
      subTaskQueue.enqueueTask(mockTask);
    });

    it('should handle tasks for different roles independently when enqueuing', () => {
      const taskRole1 = { ...mockTask, assigned_agent_role: 'Role1' };
      const taskRole2 = { ...mockTask, sub_task_id: 'sub456', assigned_agent_role: 'Role2' };

      const callbackRole1 = jest.fn();
      subTaskQueue.subscribe('Role1', callbackRole1);

      // Enqueue for Role1 (should be emitted directly)
      subTaskQueue.enqueueTask(taskRole1);
      expect(callbackRole1).toHaveBeenCalledWith(taskRole1);
      expect(subTaskQueue.tasks.length).toBe(0);

      // Enqueue for Role2 (no subscriber, should be queued)
      subTaskQueue.enqueueTask(taskRole2);
      expect(subTaskQueue.tasks.length).toBe(1);
      expect(subTaskQueue.tasks[0]).toEqual(taskRole2);
      expect(callbackRole1).toHaveBeenCalledTimes(1); // Role1 callback not called again
    });
  });

  // More tests will follow for subscribe behavior etc.
  describe('subscribe Behavior', () => {
    beforeEach(() => {
        jest.useFakeTimers(); // For process.nextTick
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('should add a callback to roleSubscribers for the specified agentRole', () => {
      const agentRole = 'NewRole';
      subTaskQueue.subscribe(agentRole, mockCallback);
      // Internally, EventEmitter stores listeners. We check behavior.
      // To test this, we can enqueue a task for this role and see if the callback is called.
      const taskForNewRole = { ...mockTask, assigned_agent_role: agentRole };
      subTaskQueue.enqueueTask(taskForNewRole);
      expect(mockCallback).toHaveBeenCalledWith(taskForNewRole);
    });

    it('subscribing the same callback multiple times should result in multiple calls if tasks are emitted', () => {
      // EventEmitter's default behavior is to add a new listener each time 'on' (or an alias) is called.
      // So, subscribing the same callback function twice means it will be called twice if an event is emitted twice,
      // or if it's called for two different tasks if it's a persistent subscriber.
      // For a queue, typically a subscriber processes one task and might need to re-signal readiness or re-subscribe.
      // The current SubTaskQueue seems to keep the listener active.
      const agentRole = 'MultiListenRole';
      subTaskQueue.subscribe(agentRole, mockCallback);
      subTaskQueue.subscribe(agentRole, mockCallback); // Subscribed twice

      const task1 = { ...mockTask, sub_task_id: 'task1', assigned_agent_role: agentRole };
      const task2 = { ...mockTask, sub_task_id: 'task2', assigned_agent_role: agentRole };

      subTaskQueue.enqueueTask(task1);
      expect(mockCallback).toHaveBeenCalledWith(task1);
      expect(mockCallback).toHaveBeenCalledTimes(2); // Called twice for the first task

      mockCallback.mockClear(); // Clear previous calls before next enqueue
      subTaskQueue.enqueueTask(task2);
      expect(mockCallback).toHaveBeenCalledWith(task2);
      expect(mockCallback).toHaveBeenCalledTimes(2); // Called twice for the second task
    });

    it('should dispatch one pending task via process.nextTick if tasks exist for the role upon subscription', () => {
      const agentRole = 'PendingTaskRole';
      const pendingTask1 = { ...mockTask, sub_task_id: 'pending1', assigned_agent_role: agentRole };
      const pendingTask2 = { ...mockTask, sub_task_id: 'pending2', assigned_agent_role: agentRole };

      // Enqueue tasks BEFORE subscribing
      subTaskQueue.enqueueTask(pendingTask1);
      subTaskQueue.enqueueTask(pendingTask2);
      expect(subTaskQueue.tasks.length).toBe(2);

      subTaskQueue.subscribe(agentRole, mockCallback);

      // Callback should not have been called yet synchronously
      expect(mockCallback).not.toHaveBeenCalled();
      expect(subTaskQueue.tasks.length).toBe(2); // Still 2, removal happens after processing in nextTick

      jest.runAllTicks(); // Process nextTick queue

      expect(mockCallback).toHaveBeenCalledWith(pendingTask1); // Only the first pending task
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(subTaskQueue.tasks.length).toBe(1); // One task removed
      expect(subTaskQueue.tasks[0]).toEqual(pendingTask2);
    });

    it('should only dispatch one pending task immediately even if multiple subscribers are added for the same role with pending tasks', () => {
        const agentRole = 'MultiSubPending';
        const pendingTask1 = { ...mockTask, sub_task_id: 'msp1', assigned_agent_role: agentRole };
        const pendingTask2 = { ...mockTask, sub_task_id: 'msp2', assigned_agent_role: agentRole };
        subTaskQueue.enqueueTask(pendingTask1);
        subTaskQueue.enqueueTask(pendingTask2);

        const callback1 = jest.fn();
        const callback2 = jest.fn();

        subTaskQueue.subscribe(agentRole, callback1);
        subTaskQueue.subscribe(agentRole, callback2);

        jest.runAllTicks();

        // Both subscribers get the first task.
        expect(callback1).toHaveBeenCalledWith(pendingTask1);
        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledWith(pendingTask1);
        expect(callback2).toHaveBeenCalledTimes(1);
        expect(subTaskQueue.tasks.length).toBe(1); // Only one task processed
    });


    it('should not call callback immediately if no pending tasks exist for the role', () => {
      const agentRole = 'NoPendingRole';
      subTaskQueue.subscribe(agentRole, mockCallback);

      jest.runAllTicks(); // Process nextTick queue (though nothing should be there from subscribe)

      expect(mockCallback).not.toHaveBeenCalled();
      expect(subTaskQueue.tasks.length).toBe(0);
    });
  });

  describe('Event Emission and Multiple Subscribers', () => {
    it('should invoke all subscribed callbacks for a role when a task is enqueued for that role', () => {
        const agentRole = 'MultiCallbackRole';
        const callback1 = jest.fn();
        const callback2 = jest.fn();

        subTaskQueue.subscribe(agentRole, callback1);
        subTaskQueue.subscribe(agentRole, callback2);

        const taskForRole = { ...mockTask, assigned_agent_role: agentRole };
        subTaskQueue.enqueueTask(taskForRole);

        expect(callback1).toHaveBeenCalledWith(taskForRole);
        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledWith(taskForRole);
        expect(callback2).toHaveBeenCalledTimes(1);
        expect(subTaskQueue.tasks.length).toBe(0); // Task should be directly emitted, not queued
    });
  });
});
