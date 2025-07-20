import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ExecuterModule } from './executer/executer.module';

@Module({
  imports: [PrismaModule, ExecuterModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
