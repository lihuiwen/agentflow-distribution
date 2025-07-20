import {
  Injectable,
  Body,
  Logger,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { QueueService } from './queue.service';
import { AgentMatcherService } from './agent-matcher.service';
import { JobDistributorService } from './job-distributor.service';
import { ExecutionTrackerService } from './execution-tracker.service';
import { AgentCommunicationService } from './agent-communication.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProcessQueueResponse,
  QueueProcessOptions,
} from './interfaces/executer.interfaces';

@Injectable()
export class ExecuterService {
  private readonly logger = new Logger(ExecuterService.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly agentMatcher: AgentMatcherService,
    private readonly jobDistributor: JobDistributorService,
    private readonly executionTracker: ExecutionTrackerService,
    private readonly agentCommunication: AgentCommunicationService,
    private readonly prisma: PrismaService,
  ) {}

  async processQueue(
    @Body() options?: QueueProcessOptions,
  ): Promise<ProcessQueueResponse> {
    return this.executeQueueProcessing(options, 'Manual');
  }

  /**
   * 公共方法：执行完整的队列处理逻辑
   * 包括队列处理和任务分发
   */
  async executeQueueProcessing(
    options?: QueueProcessOptions,
    triggerSource: string = 'Unknown',
  ): Promise<ProcessQueueResponse> {
    try {
      this.logger.log(`${triggerSource} queue processing triggered`);

      const result = await this.queueService.processQueue(options);

      // 对成功创建的任务进行分发
      if (result.successCount > 0) {
        // 异步处理分发，不阻塞响应
        this.processTaskDistribution().catch((error) => {
          this.logger.error('Task distribution failed:', error);
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Queue processing failed:', error);
      throw new HttpException(
        `Queue processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 私有方法：处理任务分发
   */
  private async processTaskDistribution(): Promise<void> {
    try {
      // 获取状态为DISTRIBUTED但还没有分发记录的jobs
      const jobs = await this.prisma.job.findMany({
        where: {
          status: 'DISTRIBUTED',
          distributionRecord: null,
        },
        take: 10, // 限制批量处理数量
      });

      if (jobs.length === 0) {
        return;
      }

      this.logger.log(`Processing distribution for ${jobs.length} jobs`);

      // 并发处理每个任务的分发
      const distributionPromises = jobs.map(async (job) => {
        try {
          // 匹配agents
          const agents = await this.agentMatcher.matchAgentsForJob(job);
          const rankedAgents = await this.agentMatcher.scoreAndRankAgents(
            agents,
            job,
          );
          const maxAgents = parseInt(process.env.MAX_AGENTS_PER_JOB || '3');
          const selectedAgents = rankedAgents.slice(0, maxAgents);

          if (selectedAgents.length === 0) {
            this.logger.warn(`No suitable agents found for job ${job.id}`);
            // 更新job状态为CANCELLED
            await this.prisma.job.update({
              where: { id: job.id },
              data: { status: 'CANCELLED' },
            });
            return;
          }

          // 创建分发记录
          const distributionRecord =
            await this.jobDistributor.createDistributionRecord(
              job.id,
              selectedAgents,
            );

          // 分发给agents
          await this.distributeToAgents(distributionRecord.id, selectedAgents);

          this.logger.log(
            `Successfully distributed job ${job.id} to ${selectedAgents.length} agents`,
          );
        } catch (error) {
          this.logger.error(`Failed to distribute job ${job.id}:`, error);
          // 更新job状态为失败
          await this.prisma.job.update({
            where: { id: job.id },
            data: { status: 'CANCELLED' },
          });
        }
      });

      await Promise.allSettled(distributionPromises);
    } catch (error) {
      this.logger.error('Task distribution processing failed:', error);
    }
  }

  /**
   * 私有方法：分发任务给agents
   */
  private async distributeToAgents(
    distributionId: string,
    agents: { id: string; agentName: string; agentAddress: string }[],
  ): Promise<void> {
    try {
      // 获取分发详情
      const distributionDetail =
        await this.jobDistributor.getDistributionDetail(distributionId);

      if (!distributionDetail) {
        throw new Error(`Distribution ${distributionId} not found`);
      }

      // 获取job详情
      const job = await this.prisma.job.findUnique({
        where: { id: distributionDetail.jobId },
      });

      if (!job) {
        throw new Error(`Job ${distributionDetail.jobId} not found`);
      }

      // 并发调用agents
      const callPromises = agents.map(async (agent) => {
        try {
          // 开始跟踪执行
          await this.executionTracker.trackAgentExecution(
            distributionId,
            agent.id,
          );

          // 构建调用数据
          const jobData = this.agentCommunication.buildJobExecutionData(
            job.id,
            job.jobTitle,
            job.description,
            job.deliverables,
            job.deadline.toISOString(),
            job.priority,
            distributionId,
            job.maxBudget || undefined,
            job.tags,
          );

          // 调用agent API
          const response = await this.agentCommunication.callAgentAPI(
            agent.agentAddress,
            jobData,
          );

          if (response.success) {
            this.logger.log(`Agent ${agent.agentName} accepted job ${job.id}`);

            await this.executionTracker.handleExecutionCompleted(
              distributionId,
              agent.id,
              response.message || '',
            );
          } else {
            this.logger.warn(
              `Agent ${agent.agentName} rejected job ${job.id}: ${response.error}`,
            );
            await this.executionTracker.handleExecutionFailed(
              distributionId,
              agent.id,
              response.error || 'Agent rejected the job',
            );
          }
        } catch (error) {
          this.logger.error(`Failed to call agent ${agent.agentName}:`, error);
          await this.executionTracker.handleExecutionFailed(
            distributionId,
            agent.id,
            error instanceof Error ? error.message : 'Agent call failed',
          );
        }
      });

      await Promise.allSettled(callPromises);

      // 更新job状态为IN_PROGRESS
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'IN_PROGRESS' },
      });

      this.logger.log(`Distribution ${distributionId} completed`);
    } catch (error) {
      this.logger.error(`Failed to distribute to agents:`, error);
      throw error;
    }
  }
}
