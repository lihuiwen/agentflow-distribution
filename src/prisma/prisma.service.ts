import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// 全局Prisma客户端缓存，用于Lambda冷启动优化
let cachedPrisma: PrismaClient | null = null;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // 如果已有缓存实例，复用连接配置
    if (cachedPrisma) {
      super({
        log:
          process.env.NODE_ENV === 'development'
            ? ['query', 'info', 'warn', 'error']
            : ['error'],
      });
    } else {
      super({
        // 开发环境可以启用日志
        log:
          process.env.NODE_ENV === 'development'
            ? ['query', 'info', 'warn', 'error']
            : ['error'],
      });
    }
  }

  async onModuleInit() {
    try {
      // 连接数据库，添加重试机制
      await this.connectWithRetry();
    } catch (error) {
      console.error('Failed to connect to database:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      // 在Lambda环境中，通常不需要主动断开连接
      // Lambda容器销毁时会自动处理连接
      if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
        console.log(
          'Lambda environment detected, skipping explicit disconnect',
        );
        return;
      }

      // 非Lambda环境下正常断开连接
      await this.$disconnect();
      cachedPrisma = null;
    } catch (error) {
      console.error('Error during database disconnect:', error);
    }
  }

  private async connectWithRetry(maxRetries = 3, delay = 1000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        console.log(`Database connected successfully on attempt ${attempt}`);
        return;
      } catch (error) {
        console.error(`Database connection attempt ${attempt} failed:`, error);

        if (attempt === maxRetries) {
          throw error;
        }

        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, delay * attempt));
      }
    }
  }

  // Lambda环境下的健康检查方法
  async healthCheck(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }

  // Lambda环境下的连接预热
  async warmUp(): Promise<void> {
    try {
      await this.healthCheck();
      console.log('Database connection warmed up');
    } catch (error) {
      console.error('Database warm-up failed:', error);
    }
  }
}
