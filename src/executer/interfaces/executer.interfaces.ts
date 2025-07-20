import { JobStatus, AgentWorkStatus } from '@prisma/client';

// ==================== 队列相关接口 ====================

/**
 * 远程队列任务数据结构
 */
export interface QueueTask {
  jobId: string;
  jobTitle: string;
  category: string;
  priority: string;
  status: string;
  deadline: string;
  createdAt: string;
  budget: number | { min: number; max: number };
  paymentType: string;
  skillLevel: string;
}

/**
 * 队列处理选项
 */
export interface QueueProcessOptions {
  maxTasks?: number;
  timeout?: number;
  retryCount?: number;
}

// ==================== Agent匹配相关接口 ====================

/**
 * Agent匹配条件
 */
export interface MatchCriteria {
  tags: string[];
  category: string;
  skillLevel: string;
  maxBudget?: number;
  autoAcceptJobs: boolean;
  isActive: boolean;
}

/**
 * Agent评分结果
 */
export interface AgentScore {
  agentId: string;
  agentName: string;
  agentAddress: string;
  score: number;
  factors: {
    skillMatch: number; // 技能匹配度 (0-1)
    reputation: number; // 信誉评分 (0-1)
    successRate: number; // 成功率 (0-1)
    availability: number; // 可用性 (0-1)
  };
}

// ==================== 任务执行相关接口 ====================

/**
 * Agent API调用数据
 */
export interface JobExecutionData {
  jobId: string;
  jobTitle: string;
  description: string;
  deliverables: string;
  deadline: string;
  priority: string;
  distributionId: string;
  budget?: number;
  tags?: string[];
}

/**
 * Agent API响应
 */
export interface AgentResponse {
  success: boolean;
  jobId?: string;
  message?: string;
  error?: string;
}

/**
 * Agent执行状态更新数据
 */
export interface ExecutionStatusUpdate {
  distributionId: string;
  agentId: string;
  workStatus: AgentWorkStatus;
  progress?: number;
  executionResult?: string;
  errorMessage?: string;
  executionTimeMs?: number;
}

/**
 * Agent执行结果
 */
export interface AgentExecutionResult {
  agentId: string;
  agentName: string;
  distributionId: string;
  workStatus: AgentWorkStatus;
  executionResult?: string;
  executionTimeMs?: number;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  score?: number; // 结果质量评分
}

// ==================== 分发记录相关接口 ====================

/**
 * 分发记录创建数据
 */
export interface DistributionCreateData {
  jobId: string;
  jobName: string;
  matchCriteria: MatchCriteria;
  agentIds: string[];
}

/**
 * 分发记录详情
 */
export interface DistributionDetail {
  id: string;
  jobId: string;
  jobName: string;
  totalAgents: number;
  assignedCount: number;
  responseCount: number;
  assignedAgentId?: string;
  assignedAgentName?: string;
  createdAt: Date;
  agentExecutions: AgentExecutionResult[];
}

// ==================== API响应接口 ====================

/**
 * 队列处理响应
 */
export interface ProcessQueueResponse {
  message: string;
  processedCount: number;
  successCount: number;
  failedCount: number;
  details?: {
    processed: string[];
    failed: { taskId: string; error: string }[];
  };
}

/**
 * 任务状态查询响应
 */
export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  distributionRecord?: DistributionDetail;
  progress?: {
    totalAgents: number;
    workingAgents: number;
    completedAgents: number;
    failedAgents: number;
  };
}

/**
 * 执行统计响应
 */
export interface ExecutionStatsResponse {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  inProgressJobs: number;
  avgExecutionTime: number;
  successRate: number;
  topPerformingAgents: {
    agentId: string;
    agentName: string;
    completedJobs: number;
    successRate: number;
    avgExecutionTime: number;
  }[];
}

// ==================== Agent回调接口 ====================

/**
 * Agent状态更新请求
 */
export interface AgentStatusUpdateRequest {
  distributionId: string;
  workStatus: AgentWorkStatus;
  progress?: number;
  executionResult?: string;
  errorMessage?: string;
}

/**
 * Agent结果提交请求
 */
export interface AgentResultSubmissionRequest {
  distributionId: string;
  executionResult: string;
  executionTimeMs: number;
  additionalMetadata?: Record<string, any>;
}

// ==================== 错误处理相关接口 ====================

/**
 * 执行错误信息
 */
export interface ExecutionError {
  code: string;
  message: string;
  details?: any;
  timestamp: Date;
  agentId?: string;
  jobId?: string;
}

/**
 * 重试配置
 */
export interface RetryConfig {
  maxRetries: number;
  retryDelay: number; // 毫秒
  backoffMultiplier: number;
  retryCondition?: (error: any) => boolean;
}

// ==================== 配置接口 ====================

/**
 * 执行器配置
 */
export interface ExecuterConfig {
  remoteQueue: {
    url: string;
    token?: string;
    timeout: number;
  };
  agent: {
    defaultTimeout: number;
    maxAgentsPerJob: number;
    healthCheckInterval: number;
  };
  execution: {
    retryCount: number;
    parallelExecutionEnabled: boolean;
    resultSelectionStrategy:
      | 'first_completed'
      | 'best_scored'
      | 'majority_consensus';
  };
}

// ==================== 健康检查相关接口 ====================

/**
 * Agent健康状态
 */
export interface AgentHealthStatus {
  agentId: string;
  agentAddress: string;
  isHealthy: boolean;
  responseTime?: number;
  lastChecked: Date;
  error?: string;
}

/**
 * 系统健康状态
 */
export interface SystemHealthStatus {
  remoteQueue: boolean;
  database: boolean;
  agents: AgentHealthStatus[];
  totalAgents: number;
  healthyAgents: number;
}
