# model-serving-autoscaling-signal-validator

模型服务扩缩容信号校验器。针对“只按 QPS 扩容”的误区，综合每副本 QPS、队列长度、
请求 token 分布、GPU 显存、P95 延迟、冷启动时间、最小副本数与预测流量，
输出推荐副本数、生效时间、容量视图、冷启动风险和信号拒绝原因。

## 边界声明

本工具是**纯计算库，零运行时依赖**：

- 不调用 Kubernetes API、HPA、KEDA、Istio 或任何编排系统；
- 不连接模型运行时（vLLM、Triton、TensorRT-LLM 等），不读取真实监控；
- 不创建、删除或重启任何 Pod / 副本，只对调用方给出的指标做校验和建议；
- 输出中的动作（`SCALE_UP` / `SCALE_DOWN` / `HOLD` / `REJECTED`）需要由外部系统自行落地。

运行环境：Node.js `>= 24.16.0`，使用原生 ESM 与内置 `node:test`。

## 快速开始

```bash
npm test            # 执行 node --test
npm run example     # 运行 examples/run-demo.mjs 查看完整输出
```

```js
import { validateScalingSignal } from './src/index.js';

const result = validateScalingSignal({
  predictedTrafficQps: 20,
  current: {
    replicas: 2,
    minReplicas: 1,
    qpsPerReplica: 4,
    queueLength: 12,
    gpuMemoryMb: 24576,
    weightsMemoryMb: 14336,
    runtimeMemoryMb: 2048,
    p95LatencyMs: 950,
    coldStartSeconds: 45,
    tokenDistribution: [
      { tokens: 512, weight: 7 },
      { tokens: 2048, weight: 3 },
    ],
    history: [
      { t: 0, qpsPerReplica: 4, queueLength: 12, p95LatencyMs: 950, gpuUtilization: 0.7 },
      // ... 至少覆盖 scaleUpSustainSeconds 的持续采样
    ],
  },
  nodePool: { maxReplicas: 6, currentReplicas: 2 },
});
```

## 输入字段

### 单版本模式

| 字段 | 含义 |
| --- | --- |
| `current.replicas` / `minReplicas` | 当前副本数与最小副本下限 |
| `current.qpsPerReplica` | 每副本当前 QPS |
| `current.queueLength` | 每副本排队请求数 |
| `current.tokenDistribution` | 请求 token 分布，`{ tokens, weight }` 数组 |
| `current.gpuMemoryMb` / `weightsMemoryMb` / `runtimeMemoryMb` | GPU 总显存、权重与运行时占用 |
| `current.p95LatencyMs` | 当前 P95 延迟，同时用于估算单请求服务时间 |
| `current.coldStartSeconds` | 新副本预热到可接流量的时间 |
| `current.history` | 历史采样，可含 `t`（秒）、QPS、队列、P95、`gpuUtilization`、`lastScaleActionAt` |
| `predictedTrafficQps` | 预测总流量，用于预防性扩容 |
| `nodePool.maxReplicas` / `currentReplicas` | 节点池可调度副本上限与已用数量 |
| `thresholds` | 覆盖默认阈值，见下表 |

### 版本切换模式

传入 `versionSwitch: true` 与 `versions: [{ version, current, predictedTrafficQps, nodePool }]`。
每个版本独立计算容量与信号，输出按版本分组的步骤；此时提供聚合 `current` 会被直接拒绝
（`VERSION_SIGNAL_MIXED`），因为新旧版本的指标不能直接相加。

### 阈值默认值（`src/defaults.js`）

| 阈值 | 默认值 | 作用 |
| --- | --- | --- |
| `qpsUtilization` | `0.75` | 每副本 QPS / 有效容量的扩容线 |
| `memoryUtilization` | `0.85` | 显存扩容线与 KV cache 目标预算 |
| `latencyP95Ms` | `800` | P95 延迟扩容线 |
| `queueLengthPerReplica` | `8` | 每副本队列长度扩容线 |
| `scaleUpSustainSeconds` | `60` | 扩容信号必须持续越线的时长 |
| `scaleDownSustainSeconds` | `300` | 缩容必须持续低负载且队列清空的时长 |
| `cooldownSeconds` | `90` | 两次扩缩容之间的冷却期 |
| `drainSeconds` | `30` | 缩容时连接排空耗时 |
| `warmupReserveRatio` | `0.25` | 缩容保留的预热带宽余量 |
| `kvMemoryMbPerToken` | `0.12` | 单 token KV cache 显存估算系数 |

## 核心规则

### 容量模型（不只看 QPS）

- 算力容量：`1 / 服务时间`，服务时间用 P95 延迟近似；
- 显存容量：扣除权重与运行时占用后，剩余显存按峰值 token 请求的 KV 占用换算可并发槽位；
- 有效容量取两者较小值，`memoryConstrained: true` 表示瓶颈在显存；
- 大请求（高 token）会压低显存容量，即使 QPS 很低也可能要求更多副本。

### 扩容信号

- 反应式扩容必须在 `scaleUpSustainSeconds` 窗口内**持续**越过延迟、队列、QPS 利用率或显存任一线；
- 窗口内越线/恢复来回切换判定为抖动，返回 `JITTER_BREACH`，避免在阈值附近反复增减；
- 单次尖峰不满足持续时间，返回 `SUSTAIN_NOT_MET`；
- 预测流量超过当前容量时允许预防性扩容（`PREDICTED_TRAFFIC`），不受持续越线门限限制；
- 冷却期内所有信号返回 `COOLDOWN_ACTIVE`；
- 节点池无余量返回 `NODE_CAPACITY_INSUFFICIENT`；余量不足时扩容被截断并给出 `NODE_CAPACITY_CAPPED` 风险。

### 缩容信号

- 必须在 `scaleDownSustainSeconds` 内持续低负载（各维度低于扩容线的 70%）且队列清空；
- 触及最小副本返回 `MIN_REPLICAS`；
- 缩容下限按预测需求副本数乘 `1 + warmupReserveRatio` 计算，保证冷启动期间有足够带宽，
   不满足时返回 `WARMUP_RESERVE`；
- 每次最多缩一个副本，生效时间含 `drainSeconds` 连接排空。

### 版本切换

- 新版本与旧版本分别独立评估，输出 `steps[]` 与 `capacity.perVersion[]`；
- 总推荐副本为各版本目标副本之和，整体生效时间取各版本冷启动/排空时间的最大值；
- 聚合信号直接相加的输入会被拒绝。

## 输出结构

```text
{
  mode, overallAction,
  currentReplicas, recommendedReplicas,
  effectiveAfterSeconds, coldStartSeconds,
  steps: [{ groupId, action, trigger, currentReplicas, targetReplicas,
            delta, effectiveAfterSeconds, rejections, risks }],
  capacity: { perReplica, currentTotalQps, targetTotalQps,
              observedTotalQps, predictedTrafficQps, demandQps, desiredByDemand },
  signals, nodePool, rejections, risks
}
```

### 冷启动风险编码

| 编码 | 含义 |
| --- | --- |
| `COLD_START_WINDOW` | 新副本预热期间不接流量（INFO） |
| `OVERLOAD_DURING_WARMUP` | 当前需求超过预热期可用容量，排队将持续 |
| `QUEUE_BACKLOG` | 已有队列积压，预热期间可能继续增长 |
| `GPU_MEMORY_PRESSURE` | 瓶颈在显存，加副本不解决单副本 KV 上限 |
| `NODE_POOL_NEAR_LIMIT` / `NODE_CAPACITY_CAPPED` | 节点池余量不足或扩容被截断 |

### 拒绝原因编码

`SUSTAIN_NOT_MET`、`JITTER_BREACH`、`SCALE_DOWN_NOT_SUSTAINED`、`COOLDOWN_ACTIVE`、
`WARMUP_RESERVE`、`MIN_REPLICAS`、`NODE_CAPACITY_INSUFFICIENT`、
`VERSION_SIGNAL_MIXED`、`INVALID_INPUT`。

## 目录结构

```text
src/
  defaults.js   阈值、动作与拒绝原因枚举
  capacity.js   token/显存/算力容量模型
  history.js    持续越线、抖动与长时间低负载评估
  planner.js    单版本扩缩容决策与风险分析
  validator.js  输入校验、版本切换隔离与输出汇总
  index.js      公共导出
test/
  validator.test.js  突发流量、显存瓶颈、抖动、版本切换、节点不足等 14 个用例
examples/
  run-demo.mjs
```
