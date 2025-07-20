import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExecuterService } from './executer.service';
import { ProcessQueueResponse } from './interfaces/executer.interfaces';

@Injectable()
export class ScheduledTaskService {
  private readonly logger = new Logger(ScheduledTaskService.name);

  constructor(private readonly executerService: ExecuterService) {}

  /**
   * 定时处理队列任务
   * 开发环境：每30秒执行一次
   * 生产环境：每1分钟执行一次
   */
  @Cron(
    process.env.NODE_ENV === 'production'
      ? CronExpression.EVERY_MINUTE
      : CronExpression.EVERY_30_SECONDS,
  )
  async handleQueueProcessing() {
    const environment = process.env.NODE_ENV || 'development';
    this.logger.log(`[${environment}] Starting scheduled queue processing...`);

    try {
      const startTime = Date.now();

      const result: ProcessQueueResponse =
        await this.executerService.executeQueueProcessing({
          maxTasks: 1,
          timeout: 30000,
          retryCount: 3,
        });

      const duration = Date.now() - startTime;

      this.logger.log(
        `[${environment}] Scheduled processing completed in ${duration}ms - Queue: ${result.successCount} succeeded, ${result.failedCount} failed`,
      );
    } catch (error) {
      this.logger.error(
        `[${environment}] Scheduled queue processing failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * 服务启动时的初始化日志
   */
  onModuleInit() {
    const environment = process.env.NODE_ENV || 'development';
    const interval = environment === 'production' ? '1 minute' : '30 seconds';

    this.logger.log(`✅ Scheduled queue processing initialized`);
    this.logger.log(
      `🕐 Running interval: ${interval} (${environment} environment)`,
    );
  }
}
