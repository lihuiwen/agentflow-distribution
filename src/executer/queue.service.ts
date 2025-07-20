import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import {
  QueueTask,
  QueueProcessOptions,
  ProcessQueueResponse,
} from './interfaces/executer.interfaces';

export interface SQSMessage {
  MessageId: string;
  Body: string;
  ReceiptHandle: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, any>;
  MD5OfBody?: string;
  SentTimestamp?: number;
  ApproximateReceiveCount?: number;
}

export interface QueueResponse {
  Messages: SQSMessage[];
  message: string;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 从远程队列获取原始消息 (保留原有功能)
   */
  async getMessages(maxMessages: number = 3): Promise<QueueResponse> {
    try {
      const response = await axios.post<QueueResponse>(
        `${process.env.QUEUE_BASE_URL}/receive`,
        {
          MaxNumberOfMessages: maxMessages,
        },
      );
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get messages from remote queue:', error);
      throw error;
    }
  }

  /**
   * 从远程队列获取任务列表
   */
  async getTasksFromRemoteQueue(
    options: QueueProcessOptions = {},
  ): Promise<QueueTask[]> {
    const { maxTasks = 1, timeout = 30000 } = options;

    try {
      this.logger.log(`Fetching up to ${maxTasks} tasks from remote queue`);

      // 使用现有的 /receive 接口获取消息
      const response = await axios.post<QueueResponse>(
        `${process.env.QUEUE_BASE_URL}/receive`,
        {
          MaxNumberOfMessages: Math.min(maxTasks, 10), // SQS 限制单次最多10条
        },
        {
          timeout,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const messages = response.data?.Messages || [];
      this.logger.log(
        `Successfully fetched ${messages.length} messages from remote queue`,
      );

      // 将SQS消息转换为QueueTask格式
      const tasks: QueueTask[] = [];
      for (const message of messages) {
        try {
          const taskData = this.parseMessageToTask(message);
          if (taskData && this.validateTaskData(taskData)) {
            tasks.push(taskData);
          }
        } catch (error) {
          this.logger.warn(
            `Failed to parse message ${message.MessageId}:`,
            error,
          );
        }
      }

      this.logger.log(`Converted ${tasks.length} valid tasks from messages`);

      // 验证任务数据
      const validTasks = tasks;

      if (validTasks.length !== tasks.length) {
        this.logger.warn(
          `Filtered out ${tasks.length - validTasks.length} invalid tasks`,
        );
      }

      return validTasks;
    } catch (error) {
      this.logger.error('Failed to fetch tasks from remote queue:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Remote queue fetch failed: ${errorMessage}`);
    }
  }

  /**
   * 处理单个任务的完整流程
   */
  async processTask(task: QueueTask): Promise<void> {
    const jobId = task.jobId;
    this.logger.log(`Processing task: ${jobId} - ${task.jobTitle}`);

    try {
      // 1. 检查任务是否已经被分发过（查job_distribution_records表）
      const existingDistribution =
        await this.prisma.jobDistributionRecord.findFirst({
          where: { jobId },
        });

      if (existingDistribution) {
        this.logger.warn(`Task ${jobId} already distributed, skipping`);
        return;
      }

      // 2. 验证对应的Job是否存在
      const job = await this.prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        this.logger.error(`Job ${jobId} not found in database, skipping`);
        return;
      }

      // 3. 更新任务状态为DISTRIBUTED
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'DISTRIBUTED' },
      });

      this.logger.log(`Successfully processed task: ${jobId}`);
    } catch (error) {
      this.logger.error(`Failed to process task ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * 批量处理队列中的任务
   */
  async processQueue(
    options: QueueProcessOptions = {},
  ): Promise<ProcessQueueResponse> {
    const startTime = Date.now();
    this.logger.log('Starting queue processing...');

    try {
      // 获取任务列表
      const tasks = await this.getTasksFromRemoteQueue(options);

      if (tasks.length === 0) {
        this.logger.log('No tasks found in remote queue');
        return {
          message: 'No tasks to process',
          processedCount: 0,
          successCount: 0,
          failedCount: 0,
        };
      }

      // 并发处理任务
      const results = await Promise.allSettled(
        tasks.map((task) => this.processTask(task)),
      );

      // 统计处理结果
      const successCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failedCount = results.filter((r) => r.status === 'rejected').length;

      const failed = results
        .map((result, index) => ({ result, task: tasks[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, task }) => {
          const reason = (result as PromiseRejectedResult).reason as unknown;
          const errorMessage =
            reason instanceof Error ? reason.message : 'Unknown error';
          return {
            taskId: task.jobId,
            error: errorMessage,
          };
        });

      const processed = tasks
        .filter((_, index) => results[index].status === 'fulfilled')
        .map((task) => task.jobId);

      const processingTime = Date.now() - startTime;
      this.logger.log(
        `Queue processing completed in ${processingTime}ms: ` +
          `${successCount} succeeded, ${failedCount} failed`,
      );

      return {
        message: 'Queue processing completed',
        processedCount: tasks.length,
        successCount,
        failedCount,
        details: {
          processed,
          failed,
        },
      };
    } catch (error) {
      this.logger.error('Queue processing failed:', error);
      throw error;
    }
  }

  /**
   * 验证任务数据完整性
   */
  private validateTaskData(task: QueueTask): boolean {
    const requiredFields = [
      'jobId',
      'jobTitle',
      'category',
      'priority',
      'status',
      'deadline',
      'budget',
      'paymentType',
      'skillLevel',
    ];

    for (const field of requiredFields) {
      if (!task[field as keyof QueueTask]) {
        this.logger.warn(`Task ${task.jobId} missing required field: ${field}`);
        return false;
      }
    }

    // 验证日期格式 (现在是字符串)
    if (typeof task.deadline !== 'string' || isNaN(Date.parse(task.deadline))) {
      this.logger.warn(`Task ${task.jobId} has invalid deadline format`);
      return false;
    }

    // 验证预算格式
    if (
      typeof task.budget !== 'number' &&
      !(
        typeof task.budget === 'object' &&
        typeof task.budget === 'object' &&
        'min' in task.budget &&
        'max' in task.budget
      )
    ) {
      this.logger.warn(`Task ${task.jobId} has invalid budget format`);
      return false;
    }

    return true;
  }

  /**
   * 将SQS消息解析为QueueTask格式
   */
  private parseMessageToTask(message: SQSMessage): QueueTask | null {
    try {
      // 解析消息体，假设消息体是JSON格式
      const messageBody = JSON.parse(message.Body) as Record<string, unknown>;

      // 安全的属性访问辅助函数
      const getString = (key: string, defaultValue = ''): string =>
        typeof messageBody[key] === 'string' ? messageBody[key] : defaultValue;

      const getNumber = (key: string, defaultValue = 0): number =>
        typeof messageBody[key] === 'number' ? messageBody[key] : defaultValue;

      // 如果消息体包含任务数据，直接使用
      if (getString('jobId') && getString('jobTitle')) {
        return {
          jobId: getString('jobId'),
          jobTitle: getString('jobTitle'),
          category: getString('category', 'general'),
          priority: getString('priority', 'medium'),
          status: getString('status', 'pending'),
          deadline:
            getString('deadline') ||
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          createdAt: getString('createdAt') || new Date().toISOString(),
          budget: getNumber('budget', 100),
          paymentType: getString('paymentType', 'fixed'),
          skillLevel: getString('skillLevel', 'intermediate'),
        };
      }

      // 如果消息体是简单格式，尝试构建任务数据
      return {
        jobId: message.MessageId || `job_${Date.now()}`,
        jobTitle:
          getString('title') || getString('jobTitle') || 'Untitled Task',
        category: getString('category', 'general'),
        priority: getString('priority', 'medium'),
        status: getString('status', 'pending'),
        deadline:
          getString('deadline') ||
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: getString('createdAt') || new Date().toISOString(),
        budget: getNumber('budget', 100),
        paymentType: getString('paymentType', 'fixed'),
        skillLevel: getString('skillLevel', 'intermediate'),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to parse message body: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }
}
