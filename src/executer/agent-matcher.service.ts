import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Agent, Job } from '@prisma/client';
import { MatchCriteria, AgentScore } from './interfaces/executer.interfaces';

@Injectable()
export class AgentMatcherService {
  private readonly logger = new Logger(AgentMatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 根据任务条件匹配符合条件的agents
   */
  async matchAgentsForJob(job: Job): Promise<Agent[]> {
    this.logger.log(`Matching agents for job: ${job.id} - ${job.jobTitle}`);

    try {
      // 构建匹配条件
      const criteria: MatchCriteria = {
        tags: job.tags,
        category: job.category,
        skillLevel: job.skillLevel,
        maxBudget: job.maxBudget || undefined,
        autoAcceptJobs: true,
        isActive: true,
      };

      // 查询符合基础条件的agents
      const baseQuery = {
        where: {
          isActive: criteria.isActive,
          autoAcceptJobs: criteria.autoAcceptJobs,
          // 检查tags是否有交集
          ...(criteria.tags.length > 0 && {
            tags: {
              hasSome: criteria.tags,
            },
          }),
          // 预算筛选：如果agent有价格设置，必须在预算范围内
          ...(criteria.maxBudget && {
            OR: [{ isFree: true }, { price: { lte: criteria.maxBudget } }],
          }),
        },
        orderBy: [
          { reputation: 'desc' as const },
          { successRate: 'desc' as const },
          { totalJobsCompleted: 'desc' as const },
        ],
      };

      const agents = await this.prisma.agent.findMany(baseQuery);

      this.logger.log(
        `Found ${agents.length} potential agents for job ${job.id}`,
      );

      // 进一步过滤和验证
      const validAgents = await this.filterValidAgents(agents, criteria);

      this.logger.log(
        `After validation: ${validAgents.length} eligible agents for job ${job.id}`,
      );

      return validAgents;
    } catch (error) {
      this.logger.error(`Failed to match agents for job ${job.id}:`, error);
      throw error;
    }
  }

  /**
   * 为agents打分并排序
   */
  async scoreAndRankAgents(agents: Agent[], job: Job): Promise<Agent[]> {
    this.logger.log(
      `Scoring and ranking ${agents.length} agents for job ${job.id}`,
    );

    try {
      // 为每个agent计算评分
      const agentScores: AgentScore[] = await Promise.all(
        agents.map((agent) => this.calculateAgentScore(agent, job)),
      );

      // 按照评分排序
      agentScores.sort((a, b) => b.score - a.score);

      // 记录评分结果
      this.logger.debug('Agent scores:');
      agentScores.forEach((score) => {
        this.logger.debug(
          `Agent ${score.agentName}: ${score.score.toFixed(2)} ` +
            `(skill: ${score.factors.skillMatch.toFixed(2)}, ` +
            `reputation: ${score.factors.reputation.toFixed(2)}, ` +
            `success: ${score.factors.successRate.toFixed(2)}, ` +
            `availability: ${score.factors.availability.toFixed(2)})`,
        );
      });

      // 返回排序后的agents
      const rankedAgents = agentScores.map(
        (score) => agents.find((agent) => agent.id === score.agentId)!,
      );

      this.logger.log(
        `Ranked agents for job ${job.id}: ` +
          rankedAgents
            .slice(0, 3)
            .map((a) => a.agentName)
            .join(', '),
      );

      return rankedAgents;
    } catch (error) {
      this.logger.error(`Failed to score agents for job ${job.id}:`, error);
      throw error;
    }
  }

  /**
   * 检查agent可用性
   */
  async checkAgentAvailability(agentId: string): Promise<boolean> {
    try {
      // 检查agent是否在处理其他任务
      const activeAssignments = await this.prisma.jobDistributionAgent.count({
        where: {
          agentId,
          workStatus: {
            in: ['ASSIGNED', 'WORKING'],
          },
        },
      });

      // 如果有活跃任务，则不可用
      if (activeAssignments > 0) {
        this.logger.debug(
          `Agent ${agentId} is busy with ${activeAssignments} active tasks`,
        );
        return false;
      }

      // 检查agent是否活跃
      const agent = await this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { isActive: true, autoAcceptJobs: true },
      });

      if (!agent?.isActive || !agent?.autoAcceptJobs) {
        this.logger.debug(
          `Agent ${agentId} is not active or auto-accept is disabled`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to check availability for agent ${agentId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * 过滤有效的agents
   */
  private async filterValidAgents(
    agents: Agent[],
    criteria: MatchCriteria,
  ): Promise<Agent[]> {
    const validAgents: Agent[] = [];

    for (const agent of agents) {
      this.logger.debug(`Validating agent ${agent.agentName} (${agent.id})`);

      // 检查可用性
      const isAvailable = await this.checkAgentAvailability(agent.id);
      if (!isAvailable) {
        this.logger.debug(`Agent ${agent.agentName} failed availability check`);
        continue;
      }
      this.logger.debug(`Agent ${agent.agentName} passed availability check`);

      // 检查技能等级匹配
      const skillMatch = this.isSkillLevelMatch(agent, criteria.skillLevel);
      if (!skillMatch) {
        this.logger.debug(
          `Agent ${agent.agentName} failed skill level check: agent(${agent.agentClassification}) vs job(${criteria.skillLevel})`,
        );
        continue;
      }
      this.logger.debug(`Agent ${agent.agentName} passed skill level check`);

      // 检查分类匹配 (可以根据业务需求调整匹配逻辑)
      const categoryMatch = this.isCategoryMatch(agent, criteria.category);
      if (!categoryMatch) {
        this.logger.debug(`Agent ${agent.agentName} failed category check`);
        continue;
      }
      this.logger.debug(
        `Agent ${agent.agentName} passed all validation checks`,
      );

      validAgents.push(agent);
    }

    return validAgents;
  }

  /**
   * 计算单个agent的评分
   */
  private async calculateAgentScore(
    agent: Agent,
    job: Job,
  ): Promise<AgentScore> {
    // 1. 技能匹配度评分 (0-1)
    const skillMatch = this.calculateSkillMatch(agent, job);

    // 2. 信誉评分 (0-1)
    const reputation = Math.min(agent.reputation / 5.0, 1.0);

    // 3. 成功率评分 (0-1)
    const successRate = agent.successRate;

    // 4. 可用性评分 (0-1) - 基于历史负载
    const availability = await this.calculateAvailabilityScore(agent.id);

    // 计算综合评分 (加权平均)
    const weights = {
      skillMatch: 0.35,
      reputation: 0.25,
      successRate: 0.25,
      availability: 0.15,
    };

    const score =
      skillMatch * weights.skillMatch +
      reputation * weights.reputation +
      successRate * weights.successRate +
      availability * weights.availability;

    return {
      agentId: agent.id,
      agentName: agent.agentName,
      agentAddress: agent.agentAddress,
      score,
      factors: {
        skillMatch,
        reputation,
        successRate,
        availability,
      },
    };
  }

  /**
   * 计算技能匹配度
   */
  private calculateSkillMatch(agent: Agent, job: Job): number {
    const agentTags = new Set(agent.tags);
    const jobTags = new Set(job.tags);

    if (jobTags.size === 0) return 1.0;

    // 计算标签交集
    const intersection = new Set(
      [...jobTags].filter((tag) => agentTags.has(tag)),
    );
    const matchRatio = intersection.size / jobTags.size;

    // 技能等级加权
    let skillLevelBonus = 0;
    const agentClassification = agent.agentClassification?.toLowerCase();
    const jobSkillLevel = job.skillLevel?.toLowerCase();

    if (agentClassification === jobSkillLevel) {
      skillLevelBonus = 0.2;
    } else if (
      (agentClassification === 'expert' && jobSkillLevel === 'intermediate') ||
      (agentClassification === 'intermediate' && jobSkillLevel === 'beginner')
    ) {
      skillLevelBonus = 0.1;
    }

    return Math.min(matchRatio + skillLevelBonus, 1.0);
  }

  /**
   * 计算可用性评分
   */
  private async calculateAvailabilityScore(agentId: string): Promise<number> {
    try {
      // 查看最近的任务负载
      const recentAssignments = await this.prisma.jobDistributionAgent.count({
        where: {
          agentId,
          assignedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 最近7天
          },
        },
      });

      // 基于最近任务数量计算可用性评分
      if (recentAssignments === 0) return 1.0;
      if (recentAssignments <= 3) return 0.8;
      if (recentAssignments <= 6) return 0.6;
      if (recentAssignments <= 10) return 0.4;
      return 0.2;
    } catch (error) {
      this.logger.warn(
        `Failed to calculate availability for agent ${agentId}:`,
        error,
      );
      return 0.5; // 默认中等可用性
    }
  }

  /**
   * 检查技能等级匹配
   */
  private isSkillLevelMatch(agent: Agent, jobSkillLevel: string): boolean {
    const agentLevel = agent.agentClassification?.toLowerCase();
    const jobLevel = jobSkillLevel?.toLowerCase();

    if (!agentLevel || !jobLevel) return true;

    // 定义技能等级层次
    const skillLevels = ['beginner', 'intermediate', 'advanced', 'expert'];
    const agentLevelIndex = skillLevels.indexOf(agentLevel);
    const jobLevelIndex = skillLevels.indexOf(jobLevel);

    // 如果Agent或Job的技能等级不在预定义列表中，则允许匹配
    if (agentLevelIndex === -1 || jobLevelIndex === -1) {
      this.logger.debug(
        `Skill level not in predefined list - allowing match: agent(${agentLevel}) vs job(${jobLevel})`,
      );
      return true;
    }

    // Agent技能等级应该大于等于任务要求
    return agentLevelIndex >= jobLevelIndex;
  }

  /**
   * 检查分类匹配
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private isCategoryMatch(_agent: Agent, _jobCategory: string): boolean {
    // 简单的分类匹配逻辑
    // 可以根据业务需求实现更复杂的分类匹配算法
    return true; // 当前允许所有分类匹配
  }
}
