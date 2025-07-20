import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentWorkStatus } from '@prisma/client';
import {
  ExecutionStatusUpdate,
  AgentExecutionResult,
} from './interfaces/executer.interfaces';

@Injectable()
export class ExecutionTrackerService {
  private readonly logger = new Logger(ExecutionTrackerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 跟踪agent执行状态
   */
  async trackAgentExecution(
    distributionId: string,
    agentId: string,
  ): Promise<void> {
    this.logger.log(
      `Starting to track execution for agent ${agentId} in distribution ${distributionId}`,
    );

    try {
      // 更新agent状态为WORKING
      await this.updateExecutionStatus(distributionId, agentId, {
        distributionId,
        agentId,
        workStatus: 'WORKING',
      });

      // 记录执行开始时间
      await this.prisma.jobDistributionAgent.update({
        where: {
          jobDistributionId_agentId: {
            jobDistributionId: distributionId,
            agentId,
          },
        },
        data: {
          startedAt: new Date(),
          workStatus: 'WORKING',
        },
      });

      this.logger.log(
        `Started tracking execution for agent ${agentId} in distribution ${distributionId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start tracking for agent ${agentId} in distribution ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 更新执行状态
   */
  async updateExecutionStatus(
    distributionId: string,
    agentId: string,
    status: ExecutionStatusUpdate,
  ): Promise<void> {
    this.logger.log(
      `Updating execution status for agent ${agentId}: ${status.workStatus}`,
    );

    try {
      // 构建更新数据
      const updateData = {
        workStatus: status.workStatus,
        ...(status.progress !== undefined && { progress: status.progress }),
        ...(status.executionResult !== undefined && {
          executionResult: status.executionResult,
        }),
        ...(status.errorMessage !== undefined && {
          errorMessage: status.errorMessage,
        }),
        ...(status.executionTimeMs !== undefined && {
          executionTimeMs: status.executionTimeMs,
        }),
        // 如果状态是完成或失败，设置完成时间
        ...(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(
          status.workStatus,
        ) && {
          completedAt: new Date(),
        }),
      };

      // 更新数据库记录
      await this.prisma.jobDistributionAgent.update({
        where: {
          jobDistributionId_agentId: {
            jobDistributionId: distributionId,
            agentId,
          },
        },
        data: updateData,
      });

      // 记录执行日志
      await this.logExecutionEvent(distributionId, agentId, status.workStatus, {
        progress: status.progress,
        errorMessage: status.errorMessage,
        executionTimeMs: status.executionTimeMs,
      });

      this.logger.log(
        `Updated execution status for agent ${agentId}: ${status.workStatus}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update execution status for agent ${agentId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 处理agent执行完成
   */
  async handleExecutionCompleted(
    distributionId: string,
    agentId: string,
    executionResult: string,
    executionTimeMs?: number,
  ): Promise<void> {
    this.logger.log(
      `Handling execution completion for agent ${agentId} in distribution ${distributionId}`,
    );

    try {
      await this.updateExecutionStatus(distributionId, agentId, {
        distributionId,
        agentId,
        workStatus: 'COMPLETED',
        executionResult,
        executionTimeMs,
      });

      // 更新agent性能统计
      await this.updateAgentPerformance(agentId, true, executionTimeMs);

      this.logger.log(
        `Successfully handled execution completion for agent ${agentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle execution completion for agent ${agentId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 处理agent执行失败
   */
  async handleExecutionFailed(
    distributionId: string,
    agentId: string,
    errorMessage: string,
    executionTimeMs?: number,
  ): Promise<void> {
    this.logger.log(
      `Handling execution failure for agent ${agentId} in distribution ${distributionId}`,
    );

    try {
      await this.updateExecutionStatus(distributionId, agentId, {
        distributionId,
        agentId,
        workStatus: 'FAILED',
        errorMessage,
        executionTimeMs,
      });

      // 更新agent性能统计
      await this.updateAgentPerformance(agentId, false, executionTimeMs);

      this.logger.log(
        `Successfully handled execution failure for agent ${agentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle execution failure for agent ${agentId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 获取执行进度
   */
  async getExecutionProgress(
    distributionId: string,
  ): Promise<AgentExecutionResult[]> {
    try {
      const assignments = await this.prisma.jobDistributionAgent.findMany({
        where: { jobDistributionId: distributionId },
        include: { agent: true },
        orderBy: { assignedAt: 'asc' },
      });

      const results: AgentExecutionResult[] = assignments.map((assignment) => ({
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

      return results;
    } catch (error) {
      this.logger.error(
        `Failed to get execution progress for distribution ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 处理超时任务
   */
  async handleTimeout(distributionId: string, agentId: string): Promise<void> {
    this.logger.log(
      `Handling timeout for agent ${agentId} in distribution ${distributionId}`,
    );

    try {
      await this.updateExecutionStatus(distributionId, agentId, {
        distributionId,
        agentId,
        workStatus: 'TIMEOUT',
        errorMessage: 'Task execution timeout',
      });

      // 更新agent性能统计 (超时视为失败)
      await this.updateAgentPerformance(agentId, false);

      this.logger.log(`Successfully handled timeout for agent ${agentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to handle timeout for agent ${agentId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 获取agent当前工作状态
   */
  async getAgentWorkStatus(agentId: string): Promise<AgentWorkStatus[]> {
    try {
      const assignments = await this.prisma.jobDistributionAgent.findMany({
        where: {
          agentId,
          workStatus: { in: ['ASSIGNED', 'WORKING'] },
        },
        select: { workStatus: true },
      });

      return assignments.map((assignment) => assignment.workStatus);
    } catch (error) {
      this.logger.error(
        `Failed to get work status for agent ${agentId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 检查分发是否已完成
   */
  async isDistributionCompleted(distributionId: string): Promise<boolean> {
    try {
      // 检查是否有任何agent完成了任务
      const completedCount = await this.prisma.jobDistributionAgent.count({
        where: {
          jobDistributionId: distributionId,
          workStatus: 'COMPLETED',
        },
      });

      return completedCount > 0;
    } catch (error) {
      this.logger.error(
        `Failed to check completion status for distribution ${distributionId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * 获取分发统计信息
   */
  async getDistributionStats(distributionId: string) {
    try {
      const stats = await this.prisma.jobDistributionAgent.groupBy({
        by: ['workStatus'],
        where: { jobDistributionId: distributionId },
        _count: true,
      });

      const result = {
        totalAgents: 0,
        assignedAgents: 0,
        workingAgents: 0,
        completedAgents: 0,
        failedAgents: 0,
        timeoutAgents: 0,
        cancelledAgents: 0,
      };

      stats.forEach((stat) => {
        result.totalAgents += stat._count;
        switch (stat.workStatus) {
          case 'ASSIGNED':
            result.assignedAgents = stat._count;
            break;
          case 'WORKING':
            result.workingAgents = stat._count;
            break;
          case 'COMPLETED':
            result.completedAgents = stat._count;
            break;
          case 'FAILED':
            result.failedAgents = stat._count;
            break;
          case 'TIMEOUT':
            result.timeoutAgents = stat._count;
            break;
          case 'CANCELLED':
            result.cancelledAgents = stat._count;
            break;
        }
      });

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to get distribution stats for ${distributionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 记录执行事件日志
   */
  private async logExecutionEvent(
    distributionId: string,
    agentId: string,
    eventType: string,
    eventData?: Record<string, any>,
  ): Promise<void> {
    try {
      // 获取jobId
      const distribution = await this.prisma.jobDistributionRecord.findUnique({
        where: { id: distributionId },
        select: { jobId: true },
      });

      if (!distribution) {
        this.logger.warn(
          `Distribution ${distributionId} not found for logging`,
        );
        return;
      }

      await this.prisma.executionLog.create({
        data: {
          jobId: distribution.jobId,
          agentId,
          eventType,
          eventData: eventData || {},
        },
      });
    } catch (error) {
      // 日志记录失败不应该影响主要流程
      this.logger.warn(
        `Failed to log execution event for agent ${agentId}:`,
        error,
      );
    }
  }

  /**
   * 更新agent性能统计
   */
  private async updateAgentPerformance(
    agentId: string,
    isSuccess: boolean,
    executionTimeMs?: number,
  ): Promise<void> {
    try {
      // 使用upsert来更新或创建性能记录
      const currentPerformance = await this.prisma.agentPerformance.findUnique({
        where: { agentId },
      });

      if (currentPerformance) {
        // 更新现有记录
        const totalJobs = currentPerformance.totalJobs + 1;
        const completedJobs = isSuccess
          ? currentPerformance.completedJobs + 1
          : currentPerformance.completedJobs;
        const failedJobs = !isSuccess
          ? currentPerformance.failedJobs + 1
          : currentPerformance.failedJobs;

        // 计算新的平均执行时间
        let avgExecutionTime = currentPerformance.avgExecutionTime;
        if (executionTimeMs && isSuccess) {
          avgExecutionTime =
            (avgExecutionTime * currentPerformance.completedJobs +
              executionTimeMs) /
            completedJobs;
        }

        // 计算成功率
        const successRate = completedJobs / totalJobs;

        await this.prisma.agentPerformance.update({
          where: { agentId },
          data: {
            totalJobs,
            completedJobs,
            failedJobs,
            avgExecutionTime,
            successRate,
            lastUpdated: new Date(),
          },
        });

        // 同时更新agent表的统计字段
        await this.prisma.agent.update({
          where: { id: agentId },
          data: {
            totalJobsCompleted: completedJobs,
            successRate,
          },
        });
      } else {
        // 创建新记录
        const totalJobs = 1;
        const completedJobs = isSuccess ? 1 : 0;
        const failedJobs = isSuccess ? 0 : 1;
        const avgExecutionTime =
          executionTimeMs && isSuccess ? executionTimeMs : 0;
        const successRate = isSuccess ? 1 : 0;

        await this.prisma.agentPerformance.create({
          data: {
            agentId,
            totalJobs,
            completedJobs,
            failedJobs,
            avgExecutionTime,
            successRate,
          },
        });

        // 同时更新agent表的统计字段
        await this.prisma.agent.update({
          where: { id: agentId },
          data: {
            totalJobsCompleted: completedJobs,
            successRate,
          },
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to update performance statistics for agent ${agentId}:`,
        error,
      );
    }
  }
}
