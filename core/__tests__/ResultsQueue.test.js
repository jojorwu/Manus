const ResultsQueue = require('../ResultsQueue'); // Adjust path as necessary

// Mock the logger at the top level
jest.mock('../logger', () => ({ // Adjust path if logger is in the same directory
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));
const logger = require('../logger'); // Import the mocked logger

describe('ResultsQueue', () => {
  let resultsQueue;

  beforeEach(() => {
    resultsQueue = new ResultsQueue();
    jest.useFakeTimers(); // Use fake timers for all tests in this suite

    // Clear logger mocks
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers(); // Clear any pending timers
    jest.useRealTimers(); // Restore real timers
  });

  // Goal 1: Basic functionality - enqueue and immediate retrieval
  test('should store and retrieve a result if subscription happens after enqueue', (done) => {
    const parentTaskId = 'parent1';
    const subTaskId = 'sub1';
    const mockResult = {
      sub_task_id: subTaskId,
      parent_task_id: parentTaskId,
      worker_role: 'TestRole',
      status: 'COMPLETED',
      result_data: { data: 'test_data' },
      error_details: null,
    };

    resultsQueue.enqueueResult(parentTaskId, mockResult);

    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeNull();
      expect(resultMsg).toEqual(mockResult);
      // Check if the result is removed from the queue after delivery
      expect(resultsQueue.pendingResults.get(parentTaskId)?.[subTaskId]).toBeUndefined();
      done();
    }, subTaskId); // Specify subTaskId for the subscription
  });

  test('should store and retrieve multiple results for the same parent if subscription happens after enqueue', (done) => {
    const parentTaskId = 'parentMulti';
    const subTaskId1 = 'subMulti1';
    const subTaskId2 = 'subMulti2';
    const mockResult1 = { sub_task_id: subTaskId1, parent_task_id: parentTaskId, result_data: 'data1' };
    const mockResult2 = { sub_task_id: subTaskId2, parent_task_id: parentTaskId, result_data: 'data2' };

    resultsQueue.enqueueResult(parentTaskId, mockResult1);
    resultsQueue.enqueueResult(parentTaskId, mockResult2);

    let callback1Called = false;
    let callback2Called = false;

    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeNull();
      expect(resultMsg).toEqual(mockResult1);
      callback1Called = true;
      if (callback1Called && callback2Called) done();
    }, subTaskId1);

    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeNull();
      expect(resultMsg).toEqual(mockResult2);
      callback2Called = true;
      if (callback1Called && callback2Called) done();
    }, subTaskId2);
  });


  // Goal 6: Correct deletion of result after immediate delivery
   test('should remove result from queue after immediate delivery to a waiting subscriber', (done) => {
    const parentTaskId = 'parent_immediate_delivery';
    const subTaskId = 'sub_immediate_delivery';
    const mockResult = { sub_task_id: subTaskId, result_data: 'immediate data' };

    // Enqueue first
    resultsQueue.enqueueResult(parentTaskId, mockResult);
    expect(resultsQueue.pendingResults.get(parentTaskId)?.[subTaskId]).toEqual(mockResult);

    // Then subscribe
    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeNull();
      expect(resultMsg).toEqual(mockResult);
      // Verify it's removed
      expect(resultsQueue.pendingResults.get(parentTaskId)?.[subTaskId]).toBeUndefined();
      done();
    }, subTaskId);
  });

  // More tests will follow

  // Goal 2: Timeout mechanism
  test('subscribeOnce should call callback with timeout error if result not received', (done) => {
    const parentTaskId = 'parent2_timeout';
    const subTaskId = 'sub2_timeout';
    const timeoutDuration = resultsQueue.DEFAULT_TIMEOUT_MS; // Use the queue's default

    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(`Timeout waiting for result for sub_task_id ${subTaskId} (parent: ${parentTaskId})`);
      expect(resultMsg).toBeNull();
      // Goal 5: Check subscriber is removed after timeout
      expect(resultsQueue.subscribers.has(parentTaskId)).toBe(false); // or check specific sub_task_id if structure changes
      done();
    }, subTaskId);

    // Advance timers past the timeout
    jest.advanceTimersByTime(timeoutDuration + 100);
  });

  // Goal 3: Successful result delivery and timer clearing
  test('subscribeOnce should call callback with result and clear timer if result received before timeout', (done) => {
    const parentTaskId = 'parent3_success';
    const subTaskId = 'sub3_success';
    const mockResult = {
      sub_task_id: subTaskId,
      parent_task_id: parentTaskId,
      result_data: 'success_data',
    };
    const timeoutDuration = resultsQueue.DEFAULT_TIMEOUT_MS;

    const timeoutCallback = jest.fn(); // To ensure timeout is not called

    // Subscribe first
    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      expect(error).toBeNull();
      expect(resultMsg).toEqual(mockResult);
      // Check that the timeout function associated with this subscription was cleared
      // We can't directly check clearTimeout, but we can verify the timeoutCallback wasn't called after advancing time.
      jest.advanceTimersByTime(timeoutDuration + 100);
      expect(timeoutCallback).not.toHaveBeenCalled();
       // Goal 5: Check subscriber is removed after successful callback
      expect(resultsQueue.subscribers.has(parentTaskId)).toBe(false);
      done();
    }, subTaskId);

    // Store the original setTimeout to spy on clearTimeout if possible, or use a more indirect check.
    // For this test, we'll rely on the fact that if the success callback is hit, the timeout should have been cleared.
    // And we advance timers afterwards to check timeoutCallback.

    // Enqueue result shortly after, well before timeout
    setTimeout(() => {
      resultsQueue.enqueueResult(parentTaskId, mockResult);
    }, 100);

    jest.advanceTimersByTime(100); // Advance to when result is enqueued
    // Further advance time to check timeout was indeed cleared and not just pending
    // This is handled by the advanceTimersByTime inside the callback.
  });

  // Goal 4: Key test for multiple parallel subscriptions for the same parentTaskId but different sub_task_ids
  test('should handle multiple parallel subscriptions for the same parentTaskId correctly', (done) => {
    const parentTaskId = 'parent_parallel_subs';
    const subTaskId1 = 'sub_parallel_1';
    const subTaskId2 = 'sub_parallel_2';
    const subTaskId3 = 'sub_parallel_3';

    const mockResult1 = { sub_task_id: subTaskId1, parent_task_id: parentTaskId, data: 'result for sub1' };
    const mockResult2 = { sub_task_id: subTaskId2, parent_task_id: parentTaskId, data: 'result for sub2' };
    const mockResult3 = { sub_task_id: subTaskId3, parent_task_id: parentTaskId, data: 'result for sub3' };

    let callback1Called = false;
    let callback2Called = false;
    let callback3Called = false;
    let errorCount = 0;

    const checkDone = () => {
      if (callback1Called && callback2Called && callback3Called) {
        expect(errorCount).toBe(0); // Ensure no unexpected errors
        done();
      }
    };

    // Subscribe for subTaskId1
    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      if (error) { errorCount++; console.error("Error for sub1:", error); return; }
      expect(resultMsg).toEqual(mockResult1);
      callback1Called = true;
      checkDone();
    }, subTaskId1);

    // Subscribe for subTaskId2
    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      if (error) { errorCount++; console.error("Error for sub2:", error); return; }
      expect(resultMsg).toEqual(mockResult2);
      callback2Called = true;
      checkDone();
    }, subTaskId2);

    // Subscribe for subTaskId3
    resultsQueue.subscribeOnce(parentTaskId, (error, resultMsg) => {
      if (error) { errorCount++; console.error("Error for sub3:", error); return; }
      expect(resultMsg).toEqual(mockResult3);
      callback3Called = true;
      checkDone();
    }, subTaskId3);

    // Enqueue results in a different order or with slight delays
    // to test robustness
    setTimeout(() => resultsQueue.enqueueResult(parentTaskId, mockResult2), 50);  // Result for sub2 arrives first
    setTimeout(() => resultsQueue.enqueueResult(parentTaskId, mockResult1), 100); // Result for sub1 arrives second
    setTimeout(() => resultsQueue.enqueueResult(parentTaskId, mockResult3), 150); // Result for sub3 arrives third

    jest.advanceTimersByTime(200); // Advance time enough for all results to be processed
  });
});
