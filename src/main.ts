import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 配置全局异常过滤器
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 配置全局验证管道，启用类型转换
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // 启用自动类型转换
      transformOptions: {
        enableImplicitConversion: true, // 启用隐式类型转换
      },
    }),
  );

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // 配置 Swagger API 文档
  if (process.env.NODE_ENV !== 'production') {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');

    const config = new DocumentBuilder()
      .setTitle('AI Jobs API')
      .setDescription('AI Jobs 平台 API 接口文档')
      .setVersion('1.0')
      .addTag('agents', 'AI 代理相关接口')
      .addTag('jobs', '任务相关接口')
      .addTag('categories', '分类相关接口')
      .build();

    const document = SwaggerModule.createDocument(app as any, config);
    SwaggerModule.setup('api-docs', app as any, document);
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap().catch((error) => console.error(error));
