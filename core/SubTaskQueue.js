const EventEmitter = require('events');
const logger = require('./logger'); // Assuming logger.js is in the same core directory

class SubTaskQueue extends EventEmitter {
  constructor() {
    super();
    this.tasks = []; // Array to store task messages
    this.roleSubscribers = {}; // role: [callback, callback, ...]
  }

  enqueueTask(taskMessage) {
    logger.info(`SubTaskQueue: Enqueuing task for role ${taskMessage.assigned_agent_role}, ID: ${taskMessage.sub_task_id}`, {
      agentRole: taskMessage.assigned_agent_role,
      subTaskId: taskMessage.sub_task_id,
      parentTaskId: taskMessage.parent_task_id
    });
    logger.debug("SubTaskQueue: Full enqueued task message:", { taskMessage });

    const role = taskMessage.assigned_agent_role;
    if (this.roleSubscribers[role] && this.roleSubscribers[role].length > 0) {
      logger.info(`SubTaskQueue: Emitting task ID ${taskMessage.sub_task_id} directly to subscribed role ${role}`, {
        subTaskId: taskMessage.sub_task_id,
        agentRole: role
      });
      this.emit(role, taskMessage);
    } else {
      logger.info(`SubTaskQueue: No subscribers for role ${role}, adding task ID ${taskMessage.sub_task_id} to pending queue.`, {
        agentRole: role,
        subTaskId: taskMessage.sub_task_id
      });
      this.tasks.push(taskMessage);
    }
    this.emit('newTask', role, taskMessage);
  }

  subscribe(agentRole, callback) {
    logger.info(`SubTaskQueue: Agent of role '${agentRole}' attempting to subscribe.`, { agentRole });
    if (!this.roleSubscribers[agentRole]) {
      this.roleSubscribers[agentRole] = [];
    }

    if (this.roleSubscribers[agentRole].includes(callback)) {
      logger.warn(`SubTaskQueue: Agent with this callback already subscribed to role '${agentRole}'. Subscription attempt ignored.`, { agentRole });
      return;
    }

    this.roleSubscribers[agentRole].push(callback);
    logger.info(`SubTaskQueue: Agent subscribed to role '${agentRole}'. Total subscribers for role: ${this.roleSubscribers[agentRole].length}`, {
      agentRole,
      subscriberCount: this.roleSubscribers[agentRole].length
    });

    const eventListener = (taskMessage) => {
      logger.debug(`SubTaskQueue: Notifying subscriber for role ${agentRole} about task ID ${taskMessage.sub_task_id}`, {
        agentRole,
        subTaskId: taskMessage.sub_task_id
      });
      callback(taskMessage);
    };
    this.on(agentRole, eventListener);

    if (!this.subscriberListeners) this.subscriberListeners = new Map();
    if (!this.subscriberListeners.has(callback)) this.subscriberListeners.set(callback, []);
    this.subscriberListeners.get(callback).push({ role: agentRole, listener: eventListener });

    const pendingTaskIndex = this.tasks.findIndex(task => task.assigned_agent_role === agentRole);
    if (pendingTaskIndex !== -1) {
      const pendingTask = this.tasks.splice(pendingTaskIndex, 1)[0];
      logger.info(`SubTaskQueue: Immediately dispatching pending task ID ${pendingTask.sub_task_id} to newly subscribed role ${agentRole}`, {
        subTaskId: pendingTask.sub_task_id,
        agentRole
      });
      process.nextTick(() => {
        callback(pendingTask);
      });
    }
  }
}

module.exports = SubTaskQueue;
