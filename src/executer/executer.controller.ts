import {
  Controller,
  Post,
  Get,
  Put,
  Param,
  Body,
  Query,
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
  JobStatusResponse,
  ExecutionStatsResponse,
  AgentStatusUpdateRequest,
  AgentResultSubmissionRequest,
  QueueProcessOptions,
} from './interfaces/executer.interfaces';

@Controller('executer')
export class ExecuterController {
  private readonly logger = new Logger(ExecuterController.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly agentMatcher: AgentMatcherService,
    private readonly jobDistributor: JobDistributorService,
    private readonly executionTracker: ExecutionTrackerService,
    private readonly agentCommunication: AgentCommunicationService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 手动触发队列处理
   * POST /api/executer/process-queue
   */
  @Post('process-queue')
  async processQueue(
    @Body() options?: QueueProcessOptions,
  ): Promise<ProcessQueueResponse> {
    try {
      this.logger.log('Manual queue processing triggered');

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
   * 获取任务执行状态
   * GET /api/executer/status/:jobId
   */
  @Get('status/:jobId')
  async getJobStatus(
    @Param('jobId') jobId: string,
  ): Promise<JobStatusResponse> {
    try {
      // 获取job信息
      const job = await this.prisma.job.findUnique({
        where: { id: jobId },
        include: {
          distributionRecord: {
            include: {
              assignedAgents: {
                include: { agent: true },
              },
            },
          },
        },
      });

      if (!job) {
        throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
      }

      // 构建响应数据
      let distributionDetail: JobStatusResponse['distributionRecord'] =
        undefined;
      let progress: JobStatusResponse['progress'] = undefined;

      if (job.distributionRecord) {
        const agentExecutions = job.distributionRecord.assignedAgents.map(
          (assignment) => ({
            agentId: assignment.agentId,
            agentName: assignment.agent.agentName,
            distributionId: assignment.jobDistributionId,
            workStatus: assignment.workStatus,
            executionResult: assignment.executionResult || undefined,
            executionTimeMs: assignment.executionTimeMs || undefined,
            startedAt: assignment.startedAt || undefined,
            completedAt: assignment.completedAt || undefined,
            errorMessage: assignment.errorMessage || undefined,
          }),
        );

        distributionDetail = {
          id: job.distributionRecord.id,
          jobId: job.distributionRecord.jobId,
          jobName: job.distributionRecord.jobName,
          totalAgents: job.distributionRecord.totalAgents,
          assignedCount: job.distributionRecord.assignedCount,
          responseCount: job.distributionRecord.responseCount,
          assignedAgentId: job.distributionRecord.assignedAgentId || undefined,
          assignedAgentName:
            job.distributionRecord.assignedAgentName || undefined,
          createdAt: job.distributionRecord.createdAt,
          agentExecutions,
        };

        // 计算进度统计
        const stats = await this.executionTracker.getDistributionStats(
          job.distributionRecord.id,
        );
        progress = {
          totalAgents: stats.totalAgents,
          workingAgents: stats.workingAgents,
          completedAgents: stats.completedAgents,
          failedAgents: stats.failedAgents,
        };
      }

      return {
        jobId: job.id,
        status: job.status,
        distributionRecord: distributionDetail,
        progress,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Failed to get status for job ${jobId}:`, error);
      throw new HttpException(
        'Failed to get job status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取执行统计
   * GET /api/executer/stats
   */
  @Get('stats')
  async getExecutionStats(): Promise<ExecutionStatsResponse> {
    try {
      // 获取基本统计
      const totalJobs = await this.prisma.job.count();
      const completedJobs = await this.prisma.job.count({
        where: { status: 'COMPLETED' },
      });
      const failedJobs = await this.prisma.job.count({
        where: { status: { in: ['CANCELLED', 'EXPIRED'] } },
      });
      const inProgressJobs = await this.prisma.job.count({
        where: { status: { in: ['DISTRIBUTED', 'IN_PROGRESS'] } },
      });

      // 获取平均执行时间
      const avgTimeResult = await this.prisma.jobDistributionAgent.aggregate({
        where: {
          workStatus: 'COMPLETED',
          executionTimeMs: { not: null },
        },
        _avg: { executionTimeMs: true },
      });

      const avgExecutionTime = avgTimeResult._avg.executionTimeMs || 0;
      const successRate = totalJobs > 0 ? completedJobs / totalJobs : 0;

      // 获取表现最好的agents
      const topPerformingAgents = await this.prisma.agentPerformance.findMany({
        where: {
          completedJobs: { gte: 3 }, // 至少完成3个任务
        },
        orderBy: [{ successRate: 'desc' }, { completedJobs: 'desc' }],
        take: 5,
      });

      // 获取对应的agent信息
      const agentNames = await this.prisma.agent.findMany({
        where: {
          id: { in: topPerformingAgents.map((perf) => perf.agentId) },
        },
        select: { id: true, agentName: true },
      });

      const agentNameMap = new Map(
        agentNames.map((agent) => [agent.id, agent.agentName]),
      );

      return {
        totalJobs,
        completedJobs,
        failedJobs,
        inProgressJobs,
        avgExecutionTime,
        successRate,
        topPerformingAgents: topPerformingAgents.map((perf) => ({
          agentId: perf.agentId,
          agentName: agentNameMap.get(perf.agentId) || 'Unknown',
          completedJobs: perf.completedJobs,
          successRate: perf.successRate,
          avgExecutionTime: perf.avgExecutionTime,
        })),
      };
    } catch (error) {
      this.logger.error('Failed to get execution stats:', error);
      throw new HttpException(
        'Failed to get execution statistics',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Agent更新执行状态
   * PUT /api/executer/agents/:agentId/status
   */
  @Put('agents/:agentId/status')
  async updateAgentExecutionStatus(
    @Param('agentId') agentId: string,
    @Body() request: AgentStatusUpdateRequest,
  ): Promise<{ message: string; success: boolean }> {
    try {
      await this.executionTracker.updateExecutionStatus(
        request.distributionId,
        agentId,
        {
          distributionId: request.distributionId,
          agentId,
          workStatus: request.workStatus,
          progress: request.progress,
          executionResult: request.executionResult,
          errorMessage: request.errorMessage,
        },
      );

      // 更新分发记录的响应计数
      await this.jobDistributor.updateResponseCount(request.distributionId);

      return {
        message: 'Agent execution status updated successfully',
        success: true,
      };
    } catch (error) {
      this.logger.error(`Failed to update status for agent ${agentId}:`, error);
      throw new HttpException(
        'Failed to update agent status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Agent提交执行结果
   * POST /api/executer/agents/:agentId/result
   */
  @Post('agents/:agentId/result')
  async submitExecutionResult(
    @Param('agentId') agentId: string,
    @Body() request: AgentResultSubmissionRequest,
  ): Promise<{ message: string; success: boolean }> {
    try {
      // 处理执行完成
      await this.executionTracker.handleExecutionCompleted(
        request.distributionId,
        agentId,
        request.executionResult,
        request.executionTimeMs,
      );

      // 检查是否是第一个完成的，如果是则选择为最优结果
      const isCompleted = await this.executionTracker.isDistributionCompleted(
        request.distributionId,
      );

      if (isCompleted) {
        // 异步处理最优结果选择
        this.jobDistributor
          .selectBestAgentAndComplete(request.distributionId, 'first_completed')
          .catch((error) => {
            this.logger.error('Failed to select best agent:', error);
          });
      }

      return {
        message: 'Execution result submitted successfully',
        success: true,
      };
    } catch (error) {
      this.logger.error(`Failed to submit result for agent ${agentId}:`, error);
      throw new HttpException(
        'Failed to submit execution result',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取活跃分发记录
   * GET /api/executer/distributions
   */
  @Get('distributions')
  async getActiveDistributions() {
    try {
      return await this.jobDistributor.getActiveDistributions();
    } catch (error) {
      this.logger.error('Failed to get active distributions:', error);
      throw new HttpException(
        'Failed to get active distributions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 手动触发特定任务的分发
   * POST /api/executer/jobs/:jobId/distribute
   */
  @Post('jobs/:jobId/distribute')
  async distributeJob(
    @Param('jobId') jobId: string,
    @Query('maxAgents') maxAgents = 3,
  ): Promise<{ message: string; distributionId: string }> {
    try {
      const job = await this.prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
      }

      if (job.status !== 'DISTRIBUTED') {
        throw new HttpException(
          'Job must be in DISTRIBUTED status',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 匹配和分发agents
      const agents = await this.agentMatcher.matchAgentsForJob(job);
      const rankedAgents = await this.agentMatcher.scoreAndRankAgents(
        agents,
        job,
      );
      const selectedAgents = rankedAgents.slice(0, maxAgents);

      if (selectedAgents.length === 0) {
        throw new HttpException(
          'No suitable agents found for this job',
          HttpStatus.NOT_FOUND,
        );
      }

      // 创建分发记录
      const distributionRecord =
        await this.jobDistributor.createDistributionRecord(
          jobId,
          selectedAgents,
        );

      // 异步分发给agents
      this.distributeToAgents(distributionRecord.id, selectedAgents).catch(
        (error) => {
          this.logger.error('Agent distribution failed:', error);
        },
      );

      return {
        message: `Job distributed to ${selectedAgents.length} agents`,
        distributionId: distributionRecord.id,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Failed to distribute job ${jobId}:`, error);
      throw new HttpException(
        'Failed to distribute job',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取agent健康状态
   * GET /api/executer/agents/health
   */
  @Get('agents/health')
  async getAgentsHealth() {
    try {
      // 获取所有活跃的agents
      const agents = await this.prisma.agent.findMany({
        where: { isActive: true },
        select: { id: true, agentName: true, agentAddress: true },
      });

      const healthStatuses = await this.agentCommunication.batchHealthCheck(
        agents.map((agent) => agent.agentAddress),
      );

      // 合并agent信息和健康状态
      const results = healthStatuses.map((status, index) => ({
        ...status,
        agentId: agents[index].id,
        agentName: agents[index].agentName,
      }));

      return {
        totalAgents: agents.length,
        healthyAgents: results.filter((r) => r.isHealthy).length,
        agents: results,
      };
    } catch (error) {
      this.logger.error('Failed to get agents health:', error);
      throw new HttpException(
        'Failed to get agents health status',
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
