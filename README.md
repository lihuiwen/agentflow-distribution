# Agent 自动接单执行系统

## 📋 项目概述

基于任务队列的自动化agent接单执行系统，支持从远程队列获取任务、智能匹配agents、创建分发记录、并发执行任务，并实时跟踪执行状态。

## 🔄 核心流程

```
远程队列获取任务 → Agent智能匹配 → 创建分发记录 → 并发执行任务 → 收集执行结果
```

### 详细执行流程

1. **任务获取阶段**
   - 从远程队列服务获取待处理任务列表
   - 验证任务数据完整性
   - 更新任务状态为 `DISTRIBUTED`

2. **Agent匹配阶段**
   - 根据任务条件（tags, category, skillLevel等）筛选符合条件的agents
   - 按照agents的reputation、successRate等指标排序
   - 选择排名靠前的agents（默认最多3个）

3. **分发记录创建**
   - 创建 `JobDistributionRecord` 记录
   - 为每个匹配的agent创建 `JobDistributionAgent` 记录
   - 初始化agent工作状态为 `ASSIGNED`

4. **并发执行阶段**
   - 并发调用多个agents的API接口
   - 实时跟踪每个agent的执行状态
   - 更新agent工作状态：`ASSIGNED` → `WORKING` → `COMPLETED`/`FAILED`

5. **结果收集阶段**
   - 收集所有agents的执行结果
   - 选择最优结果（优先选择首个完成的结果）
   - 更新任务状态为 `COMPLETED`
   - 更新agents性能统计

## 🏗️ 技术架构

### 模块设计

```
src/executer/
├── queue.service.ts              # 队列处理服务
├── agent-matcher.service.ts      # Agent匹配引擎
├── job-distributor.service.ts    # 任务分发器
├── execution-tracker.service.ts  # 执行状态跟踪
├── agent-communication.service.ts # Agent通信模块
├── executer.service.ts        # 执行器服务
├── executer.module.ts            # 执行器模块
├── scheduled-task.service.ts     # 定时任务服务
└── interfaces/
    └── executer.interfaces.ts    # 接口定义
```

### 核心服务

#### 1. QueueService - 队列处理服务

```typescript
// 从远程队列获取任务列表
async getTasksFromRemoteQueue(): Promise<QueueTask[]>

// 处理单个任务的完整流程
async processTask(task: QueueTask): Promise<void>
```

#### 2. AgentMatcherService - Agent匹配引擎

```typescript
// 根据任务条件匹配agents
async matchAgentsForJob(job: Job): Promise<Agent[]>

// 为agents打分排序
async scoreAndRankAgents(agents: Agent[], job: Job): Promise<Agent[]>
```

#### 3. JobDistributorService - 任务分发器

```typescript
// 创建任务分发记录
async createDistributionRecord(jobId: string, agents: Agent[]): Promise<JobDistributionRecord>

// 分发任务给agents
async distributeToAgents(distributionId: string): Promise<void>
```

#### 4. ExecutionTrackerService - 执行状态跟踪

```typescript
// 跟踪agent执行状态
async trackAgentExecution(distributionId: string, agentId: string): Promise<void>

// 更新执行状态
async updateExecutionStatus(distributionId: string, agentId: string, status: AgentWorkStatus): Promise<void>
```

#### 5. AgentCommunicationService - Agent通信模块

```typescript
// 调用agent API
async callAgentAPI(agentAddress: string, jobData: JobExecutionData): Promise<AgentResponse>

// 检查agent健康状态
async healthCheck(agentAddress: string): Promise<boolean>
```

## 🗄️ 数据状态流转

### Job状态流转

```
OPEN → DISTRIBUTED → IN_PROGRESS → COMPLETED/CANCELLED/EXPIRED
```

### AgentWorkStatus状态流转

```
IDLE → ASSIGNED → WORKING → COMPLETED/FAILED/CANCELLED/TIMEOUT
```

## 📊 最小可用版本实现范围

### Phase 1: 核心功能 ✅

- [x] 创建基础模块结构
- [x] 实现队列处理服务
- [x] 实现Agent匹配引擎
- [x] 实现任务分发器
- [x] 实现基础执行跟踪
- [x] 实现Agent通信模块
- [x] 创建API控制器

### Phase 2: 状态管理 ✅

- [x] 任务状态流转管理
- [x] Agent工作状态跟踪
- [x] 执行结果存储
- [x] 错误处理机制

### Phase 3: 监控和优化

- [ ] 实时状态监控
- [ ] 性能统计和分析
- [ ] 重试机制优化
- [ ] 日志记录完善

## 🔧 技术特性

### 核心特性

- **智能匹配**: 基于tags、category、skillLevel等条件匹配最适合的agents
- **并发执行**: 支持多个agents同时处理同一任务
- **状态跟踪**: 实时跟踪任务和agent执行状态
- **结果优选**: 自动选择最优执行结果
- **错误处理**: 完善的错误处理和重试机制

### 技术栈

- **框架**: NestJS
- **数据库**: PostgreSQL + Prisma
- **队列**: 支持远程队列服务集成
- **HTTP**: Axios for API调用
- **类型安全**: TypeScript完全类型定义

## 🛠️ 项目初始化

```bash
# 安装依赖
pnpm install

# 生成Prisma客户端
npx prisma generate

# 启动开发服务器
pnpm start:dev
```

## 📝 配置说明

### 环境变量

```env
# 数据库连接
DATABASE_URL="postgresql://username:password@localhost:5432/database"

# 远程队列服务
REMOTE_QUEUE_URL="https://your-queue-service.com"
REMOTE_QUEUE_TOKEN="your-queue-access-token"

# Agent执行配置
DEFAULT_AGENT_TIMEOUT=30000
MAX_AGENTS_PER_JOB=3
EXECUTION_RETRY_COUNT=2
```

## 📈 性能监控

系统提供执行统计API，可以监控：

- 任务处理成功率
- Agent执行性能
- 平均执行时间
- 错误率统计

## 🔄 开发计划

- [x] **v1.0 (当前)**: 最小可用版本 - 基础任务处理流程
- [ ] **v1.1**: 增加WebSocket实时状态推送
- [ ] **v1.2**: 完善监控面板和性能分析
- [ ] **v2.0**: 支持复杂任务编排和工作流
