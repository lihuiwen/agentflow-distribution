import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse, AxiosError } from 'axios';
import {
  JobExecutionData,
  AgentResponse,
  AgentHealthStatus,
  RetryConfig,
} from './interfaces/executer.interfaces';

@Injectable()
export class AgentCommunicationService {
  private readonly logger = new Logger(AgentCommunicationService.name);

  // 默认配置
  private readonly defaultConfig = {
    timeout: parseInt(process.env.DEFAULT_AGENT_TIMEOUT || '30000'),
    maxRetries: parseInt(process.env.EXECUTION_RETRY_COUNT || '2'),
    retryDelay: 1000,
    healthCheckTimeout: 5000,
  };

  /**
   * 调用agent API接受任务
   */
  async callAgentAPI(
    agentAddress: string,
    jobData: JobExecutionData,
    retryConfig?: Partial<RetryConfig>,
  ): Promise<AgentResponse> {
    const config: RetryConfig = {
      maxRetries: retryConfig?.maxRetries ?? this.defaultConfig.maxRetries,
      retryDelay: retryConfig?.retryDelay ?? this.defaultConfig.retryDelay,
      backoffMultiplier: retryConfig?.backoffMultiplier ?? 2,
      retryCondition:
        retryConfig?.retryCondition ??
        ((error) => this.defaultRetryCondition(error)),
    };

    return await this.executeWithRetry(
      () => this.makeAgentApiCall(agentAddress, jobData),
      config,
      `Agent API call to ${agentAddress}`,
    );
  }

  /**
   * 检查agent健康状态
   */
  async healthCheck(agentAddress: string): Promise<AgentHealthStatus> {
    const startTime = Date.now();

    try {
      this.logger.debug(`Checking health for agent: ${agentAddress}`);

      const response = await axios.get<{ status: string; version?: string }>(
        `${agentAddress}/health`,
        {
          timeout: this.defaultConfig.healthCheckTimeout,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const responseTime = Date.now() - startTime;
      const isHealthy =
        response.status === 200 && response.data?.status === 'ok';

      return {
        agentId: '', // 需要从外部传入
        agentAddress,
        isHealthy,
        responseTime,
        lastChecked: new Date(),
        error: isHealthy
          ? undefined
          : `Unexpected status: ${response.data?.status}`,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.logger.warn(`Health check failed for ${agentAddress}:`, error);

      return {
        agentId: '',
        agentAddress,
        isHealthy: false,
        responseTime,
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  }

  /**
   * 批量健康检查
   */
  async batchHealthCheck(
    agentAddresses: string[],
  ): Promise<AgentHealthStatus[]> {
    this.logger.log(
      `Performing batch health check for ${agentAddresses.length} agents`,
    );

    // 并发执行健康检查
    const healthChecks = agentAddresses.map((address) =>
      this.healthCheck(address).catch((error) => {
        this.logger.warn(`Health check failed for ${address}:`, error);
        return {
          agentId: '',
          agentAddress: address,
          isHealthy: false,
          lastChecked: new Date(),
          error: error instanceof Error ? error.message : 'Health check failed',
        };
      }),
    );

    const results = await Promise.all(healthChecks);
    const healthyCount = results.filter((r) => r.isHealthy).length;

    this.logger.log(
      `Batch health check completed: ${healthyCount}/${agentAddresses.length} agents healthy`,
    );

    return results;
  }

  /**
   * 取消agent任务
   */
  async cancelAgentTask(
    agentAddress: string,
    taskId: string,
  ): Promise<boolean> {
    try {
      this.logger.log(`Canceling task ${taskId} on agent ${agentAddress}`);

      const response = await axios.post<{ success: boolean; message?: string }>(
        `${agentAddress}/api/cancel-task`,
        { taskId },
        {
          timeout: this.defaultConfig.timeout,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const success = response.data?.success === true;

      if (success) {
        this.logger.log(
          `Successfully canceled task ${taskId} on agent ${agentAddress}`,
        );
      } else {
        this.logger.warn(
          `Failed to cancel task ${taskId} on agent ${agentAddress}: ${response.data?.message}`,
        );
      }

      return success;
    } catch (error) {
      this.logger.error(
        `Error canceling task ${taskId} on agent ${agentAddress}:`,
        error,
      );
      return false;
    }
  }

  /**
   * 获取agent状态
   */
  async getAgentStatus(agentAddress: string): Promise<{
    isOnline: boolean;
    currentTasks: number;
    maxTasks: number;
    isAvailable: boolean;
  }> {
    try {
      const response = await axios.get<{
        currentTasks: number;
        maxTasks: number;
        isAvailable: boolean;
        status: string;
      }>(`${agentAddress}/api/status`, {
        timeout: this.defaultConfig.healthCheckTimeout,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return {
        isOnline: true,
        currentTasks: response.data?.currentTasks || 0,
        maxTasks: response.data?.maxTasks || 1,
        isAvailable: response.data?.isAvailable === true,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get status for agent ${agentAddress}:`,
        error,
      );
      return {
        isOnline: false,
        currentTasks: 0,
        maxTasks: 1,
        isAvailable: false,
      };
    }
  }

  /**
   * 实际执行agent API调用
   */
  private async makeAgentApiCall(
    agentAddress: string,
    jobData: JobExecutionData,
  ): Promise<AgentResponse> {
    this.logger.log(
      `Calling agent API: ${agentAddress} for job ${jobData.jobId}`,
    );

    const message = jobData.jobTitle + '\n' + jobData.description;

    try {
      const response: AxiosResponse<{ text: string }> = await axios.post(
        `${agentAddress}`,
        JSON.stringify({
          messages: [
            {
              content: message,
              role: 'user',
            },
          ],
        }),
        {
          timeout: this.defaultConfig.timeout,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AgentFlow-Executor/1.0',
          },
        },
      );

      this.logger.log(
        `Agent ${agentAddress} responded to job ${jobData.jobId}: ${response.data?.text ? 'success' : 'failed'}`,
      );

      return {
        message: response.data?.text || '',
        success: true,
        jobId: jobData.jobId,
        error: '',
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const errorMsg = `Agent API call failed - Status: ${axiosError.response?.status}, Message: ${axiosError.message}`;
        this.logger.error(errorMsg);

        return {
          success: false,
          error: errorMsg,
        };
      }

      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Agent API call failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * 带重试机制的执行器
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig,
    operationName: string,
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = config.retryDelay;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 检查是否应该重试
        if (attempt === config.maxRetries || !config.retryCondition?.(error)) {
          break;
        }

        this.logger.warn(
          `${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`,
        );

        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= config.backoffMultiplier;
      }
    }

    throw (
      lastError ||
      new Error(
        `${operationName} failed after ${config.maxRetries + 1} attempts`,
      )
    );
  }

  /**
   * 默认重试条件
   */
  private defaultRetryCondition(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      // 对于网络错误、超时、5xx服务器错误进行重试
      return (
        error.code === 'ECONNREFUSED' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        (error.response?.status !== undefined && error.response.status >= 500)
      );
    }

    // 对于其他类型的错误，不重试
    return false;
  }

  /**
   * 构建agent执行数据
   */
  buildJobExecutionData(
    jobId: string,
    jobTitle: string,
    description: string,
    deliverables: string,
    deadline: string,
    priority: string,
    distributionId: string,
    budget?: number,
    tags?: string[],
  ): JobExecutionData {
    return {
      jobId,
      jobTitle,
      description,
      deliverables,
      deadline,
      priority,
      distributionId,
      budget,
      tags,
    };
  }
}
