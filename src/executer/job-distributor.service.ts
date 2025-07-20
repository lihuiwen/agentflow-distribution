import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Agent, JobDistributionRecord } from '@prisma/client';
import {
  DistributionDetail,
  MatchCriteria,
  AgentExecutionResult,
} from './interfaces/executer.interfaces';

@Injectable()
export class JobDistributorService {
  private readonly logger = new Logger(JobDistributorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建任务分发记录
   */
  async createDistributionRecord(
    jobId: string,
    agents: Agent[],
  ): Promise<JobDistributionRecord> {
    this.logger.log(
      `Creating distribution record for job ${jobId} with ${agents.length} agents`,
    );

    try {
      // 获取任务信息
      const job = await this.prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // 构建匹配条件
      const matchCriteria: MatchCriteria = {
        tags: job.tags,
        category: job.category,
        skillLevel: job.skillLevel,
        maxBudget: job.maxBudget || undefined,
        autoAcceptJobs: true,
        isActive: true,
      };

      // 在事务中创建分发记录和agent分配
      const distributionRecord = await this.prisma.$transaction(async (tx) => {
        // 1. 创建分发记录
        const record = await tx.jobDistributionRecord.create({
          data: {
            jobId,
            jobName: job.jobTitle,
            matchCriteria: JSON.stringify(matchCriteria), // Prisma Json field
            totalAgents: agents.length,
            assignedCount: agents.length,
            responseCount: 0,
          },
        });

        // 2. 创建agent分配记录
        await tx.jobDistributionAgent.createMany({
          data: agents.map((agent) => ({
            jobDistributionId: record.id,
            agentId: agent.id,
            workStatus: 'ASSIGNED' as const,
            assignedAt: new Date(),
          })),
        });

        // 3. 更新job状态为DISTRIBUTED
        await tx.job.update({
          where: { id: jobId },
          data: { status: 'DISTRIBUTED' },
        });

        this.logger.log(
          `Created distribution record ${record.id} for job ${jobId}`,
        );
        return record;
      });

      return distributionRecord;
    } catch (error) {
      this.logger.error(
        `Failed to create distribution record for job ${jobId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 获取分发记录详情
   */
  async getDistributionDetail(
    distributionId: string,
  ): Promise<DistributionDetail | null> {
    try {
      const record = await this.prisma.jobDistributionRecord.findUnique({
        where: { id: distributionId },
        include: {
          assignedAgents: {
            include: {
              agent: true,
            },
          },
        },
      });

      if (!record) {
        return null;
      }

      // 转换为DistributionDetail格式
      const agentExecutions: AgentExecutionResult[] = record.assignedAgents.map(
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

      const detail: DistributionDetail = {
        id: record.id,
        jobId: record.jobId,
        jobName: record.jobName,
        totalAgents: record.totalAgents,
        assignedCount: record.assignedCount,
        responseCount: record.responseCount,
        assignedAgentId: record.assignedAgentId || undefined,
        assignedAgentName: record.assignedAgentName || undefined,
        createdAt: record.createdAt,
        agentExecutions,
      };

      return detail;
    } catch (error) {
      this.logger.error(
        `Failed to get distribution detail for ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 更新分发记录的响应计数
   */
  async updateResponseCount(distributionId: string): Promise<void> {
    try {
      // 计算已响应的agents数量
      const responseCount = await this.prisma.jobDistributionAgent.count({
        where: {
          jobDistributionId: distributionId,
          workStatus: {
            in: ['WORKING', 'COMPLETED', 'FAILED'],
          },
        },
      });

      // 更新响应计数
      await this.prisma.jobDistributionRecord.update({
        where: { id: distributionId },
        data: { responseCount },
      });

      this.logger.debug(
        `Updated response count for distribution ${distributionId}: ${responseCount}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update response count for distribution ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 选择最优agent并完成分发
   */
  async selectBestAgentAndComplete(
    distributionId: string,
    strategy: 'first_completed' | 'best_scored' = 'first_completed',
  ): Promise<void> {
    this.logger.log(
      `Selecting best agent for distribution ${distributionId} using ${strategy} strategy`,
    );

    try {
      const record = await this.getDistributionDetail(distributionId);
      if (!record) {
        throw new Error(`Distribution record ${distributionId} not found`);
      }

      // 获取已完成的agents
      const completedAgents = record.agentExecutions.filter(
        (execution) => execution.workStatus === 'COMPLETED',
      );

      if (completedAgents.length === 0) {
        this.logger.warn(
          `No completed agents found for distribution ${distributionId}`,
        );
        return;
      }

      // 根据策略选择最优agent
      let selectedAgent: AgentExecutionResult;

      switch (strategy) {
        case 'first_completed':
          selectedAgent = completedAgents.sort(
            (a, b) =>
              (a.completedAt?.getTime() || 0) - (b.completedAt?.getTime() || 0),
          )[0];
          break;

        case 'best_scored':
          // 可以基于执行时间、结果质量等因素评分
          selectedAgent = completedAgents.sort((a, b) => {
            const scoreA = this.calculateResultScore(a);
            const scoreB = this.calculateResultScore(b);
            return scoreB - scoreA;
          })[0];
          break;

        default:
          selectedAgent = completedAgents[0];
      }

      // 更新分发记录
      await this.prisma.$transaction(async (tx) => {
        // 1. 更新分发记录的选中agent
        await tx.jobDistributionRecord.update({
          where: { id: distributionId },
          data: {
            assignedAgentId: selectedAgent.agentId,
            assignedAgentName: selectedAgent.agentName,
          },
        });

        // 2. 更新job状态为COMPLETED
        await tx.job.update({
          where: { id: record.jobId },
          data: { status: 'COMPLETED' },
        });

        // 3. 取消其他agents的任务
        await tx.jobDistributionAgent.updateMany({
          where: {
            jobDistributionId: distributionId,
            agentId: { not: selectedAgent.agentId },
            workStatus: { in: ['ASSIGNED', 'WORKING'] },
          },
          data: {
            workStatus: 'CANCELLED',
            completedAt: new Date(),
            errorMessage: 'Task completed by another agent',
          },
        });
      });

      this.logger.log(
        `Selected agent ${selectedAgent.agentName} for distribution ${distributionId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to select best agent for distribution ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 处理分发超时
   */
  async handleDistributionTimeout(distributionId: string): Promise<void> {
    this.logger.log(`Handling timeout for distribution ${distributionId}`);

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. 获取分发记录
        const record = await tx.jobDistributionRecord.findUnique({
          where: { id: distributionId },
        });

        if (!record) {
          throw new Error(`Distribution record ${distributionId} not found`);
        }

        // 2. 更新未完成的agents状态为TIMEOUT
        await tx.jobDistributionAgent.updateMany({
          where: {
            jobDistributionId: distributionId,
            workStatus: { in: ['ASSIGNED', 'WORKING'] },
          },
          data: {
            workStatus: 'TIMEOUT',
            completedAt: new Date(),
            errorMessage: 'Task execution timeout',
          },
        });

        // 3. 更新job状态
        const hasCompleted = await tx.jobDistributionAgent.findFirst({
          where: {
            jobDistributionId: distributionId,
            workStatus: 'COMPLETED',
          },
        });

        if (hasCompleted) {
          // 如果有已完成的，选择最优结果
          await this.selectBestAgentAndComplete(distributionId);
        } else {
          // 如果没有完成的，标记为失败
          await tx.job.update({
            where: { id: record.jobId },
            data: { status: 'EXPIRED' },
          });
        }
      });

      this.logger.log(`Handled timeout for distribution ${distributionId}`);
    } catch (error) {
      this.logger.error(
        `Failed to handle timeout for distribution ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 获取活跃的分发记录
   */
  async getActiveDistributions(): Promise<DistributionDetail[]> {
    try {
      const records = await this.prisma.jobDistributionRecord.findMany({
        where: {
          job: {
            status: { in: ['DISTRIBUTED', 'IN_PROGRESS'] },
          },
        },
        include: {
          assignedAgents: {
            include: {
              agent: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const details: DistributionDetail[] = records.map((record) => {
        const agentExecutions: AgentExecutionResult[] =
          record.assignedAgents.map((assignment) => ({
            agentId: assignment.agentId,
            agentName: assignment.agent.agentName,
            distributionId: assignment.jobDistributionId,
            workStatus: assignment.workStatus,
            executionResult: assignment.executionResult || undefined,
            executionTimeMs: assignment.executionTimeMs || undefined,
            startedAt: assignment.startedAt || undefined,
            completedAt: assignment.completedAt || undefined,
            errorMessage: assignment.errorMessage || undefined,
          }));

        return {
          id: record.id,
          jobId: record.jobId,
          jobName: record.jobName,
          totalAgents: record.totalAgents,
          assignedCount: record.assignedCount,
          responseCount: record.responseCount,
          assignedAgentId: record.assignedAgentId || undefined,
          assignedAgentName: record.assignedAgentName || undefined,
          createdAt: record.createdAt,
          agentExecutions,
        };
      });

      return details;
    } catch (error) {
      this.logger.error('Failed to get active distributions:', error);
      throw error;
    }
  }

  /**
   * 计算执行结果评分
   */
  private calculateResultScore(execution: AgentExecutionResult): number {
    let score = 0;

    // 基础完成分数
    if (execution.workStatus === 'COMPLETED') {
      score += 100;
    }

    // 执行时间加分 (越快越好)
    if (execution.executionTimeMs) {
      const timeScore = Math.max(0, 50 - execution.executionTimeMs / 1000 / 60); // 分钟
      score += timeScore;
    }

    // 结果长度加分 (有内容的结果)
    if (execution.executionResult && execution.executionResult.length > 0) {
      const contentScore = Math.min(20, execution.executionResult.length / 100);
      score += contentScore;
    }

    return score;
  }
}
