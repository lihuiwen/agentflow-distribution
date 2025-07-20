import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { AgentMatcherService } from './agent-matcher.service';
import { JobDistributorService } from './job-distributor.service';
import { ExecutionTrackerService } from './execution-tracker.service';
import { AgentCommunicationService } from './agent-communication.service';
import { ExecuterController } from './executer.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [
    QueueService,
    AgentMatcherService,
    JobDistributorService,
    ExecutionTrackerService,
    AgentCommunicationService,
  ],
  controllers: [ExecuterController],
  exports: [
    QueueService,
    AgentMatcherService,
    JobDistributorService,
    ExecutionTrackerService,
    AgentCommunicationService,
  ],
})
export class ExecuterModule {}
