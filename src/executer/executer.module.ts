import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { QueueService } from './queue.service';
import { AgentMatcherService } from './agent-matcher.service';
import { JobDistributorService } from './job-distributor.service';
import { ExecutionTrackerService } from './execution-tracker.service';
import { AgentCommunicationService } from './agent-communication.service';
import { ScheduledTaskService } from './scheduled-task.service';
import { ExecuterService } from './executer.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  providers: [
    QueueService,
    AgentMatcherService,
    JobDistributorService,
    ExecutionTrackerService,
    AgentCommunicationService,
    ScheduledTaskService,
    ExecuterService,
  ],
  exports: [
    QueueService,
    AgentMatcherService,
    JobDistributorService,
    ExecutionTrackerService,
    AgentCommunicationService,
    ScheduledTaskService,
  ],
})
export class ExecuterModule {}
