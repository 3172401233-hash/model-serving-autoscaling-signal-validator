import { DEFAULT_THRESHOLDS } from './defaults.js';

const round2 = (value) => Number(value.toFixed(2));
const round4 = (value) => Number(value.toFixed(4));

/**
 * 根据 token 分布估算单副本的有效容量。
 *
 * 模型服务的真实容量同时受算力和显存约束：
 * - 算力侧：用观测到的 P95 延迟近似单请求服务时间，估算可承载 QPS；
 * - 显存侧：扣除权重与运行时占用后，剩余显存由 KV cache 使用，
 *   大请求（高 token）会按比例吃掉可并发槽位，显存打满时容量先于 QPS 触顶。
 *
 * @param {object} replica 单副本观测指标
 * @param {object} thresholds 阈值配置
 * @returns {object} 容量视图
 */
export function estimateCapacity(replica, thresholds = DEFAULT_THRESHOLDS) {
  const tokens = replica.tokenDistribution ?? [];
  const totalWeight = tokens.reduce((sum, point) => sum + (point.weight ?? 1), 0);
  const weightedTokens = totalWeight > 0
    ? tokens.reduce((sum, point) => sum + point.tokens * (point.weight ?? 1), 0) / totalWeight
    : 0;
  const peakTokens = tokens.reduce((max, point) => Math.max(max, point.tokens), 0);

  const gpuMemoryMb = replica.gpuMemoryMb ?? 0;
  const weightsMemoryMb = replica.weightsMemoryMb ?? 0;
  const runtimeMemoryMb = replica.runtimeMemoryMb ?? 0;
  const availableKvMb = Math.max(0, gpuMemoryMb - weightsMemoryMb - runtimeMemoryMb);

  const kvMbPerToken = thresholds.kvMemoryMbPerToken ?? DEFAULT_THRESHOLDS.kvMemoryMbPerToken;
  const peakRequestKvMb = peakTokens * kvMbPerToken;
  const averageRequestKvMb = weightedTokens * kvMbPerToken;
  const memoryConcurrencyLimit = peakRequestKvMb > 0
    ? availableKvMb / peakRequestKvMb
    : Number.POSITIVE_INFINITY;

  const p95LatencySeconds = (replica.p95LatencyMs ?? 0) / 1000;
  const serviceTimeSeconds = p95LatencySeconds > 0 ? p95LatencySeconds : 0;
  const computeQpsLimit = serviceTimeSeconds > 0 ? 1 / serviceTimeSeconds : Number.POSITIVE_INFINITY;
  const memoryQpsLimit = serviceTimeSeconds > 0
    ? memoryConcurrencyLimit / serviceTimeSeconds
    : Number.POSITIVE_INFINITY;

  const effectiveQps = Math.min(computeQpsLimit, memoryQpsLimit);
  const memoryConstrained = Number.isFinite(memoryQpsLimit)
    && memoryQpsLimit <= computeQpsLimit * 1.05;

  const observedQps = replica.qpsPerReplica ?? 0;
  const qpsUtilization = Number.isFinite(effectiveQps) && effectiveQps > 0
    ? observedQps / effectiveQps
    : 0;
  const memoryUsedMb = weightsMemoryMb + runtimeMemoryMb
    + Math.min(availableKvMb, averageRequestKvMb * (observedQps * serviceTimeSeconds));
  const memoryUtilization = gpuMemoryMb > 0 ? memoryUsedMb / gpuMemoryMb : 0;

  const queueLength = replica.queueLength ?? 0;
  const queueRatio = thresholds.queueLengthPerReplica > 0
    ? queueLength / thresholds.queueLengthPerReplica
    : 0;
  const estimatedQueueWaitMs = observedQps > 0
    ? (queueLength / observedQps) * (replica.p95LatencyMs ?? 0)
    : 0;

  return {
    observedQps: round2(observedQps),
    effectiveQps: Number.isFinite(effectiveQps) ? round2(effectiveQps) : null,
    computeQpsLimit: Number.isFinite(computeQpsLimit) ? round2(computeQpsLimit) : null,
    memoryQpsLimit: Number.isFinite(memoryQpsLimit) ? round2(memoryQpsLimit) : null,
    qpsUtilization: round4(qpsUtilization),
    memoryUtilization: round4(memoryUtilization),
    memoryPressure: round4(availableKvMb > 0 ? averageRequestKvMb / availableKvMb : 0),
    memoryConstrained,
    gpuMemoryMb,
    memoryUsedMb: round2(memoryUsedMb),
    availableKvMb: round2(availableKvMb),
    peakTokens,
    weightedTokens: round2(weightedTokens),
    memoryConcurrencyLimit: Number.isFinite(memoryConcurrencyLimit)
      ? round2(memoryConcurrencyLimit)
      : null,
    queueLength,
    queueRatio: round4(queueRatio),
    estimatedQueueWaitMs: round2(estimatedQueueWaitMs),
    p95LatencyMs: replica.p95LatencyMs ?? 0,
    serviceTimeSeconds: round4(serviceTimeSeconds),
  };
}

/**
 * 按容量反算满足某 QPS 需求所需的副本数（向上取整，至少 1）。
 */
export function replicasForQps(qps, capacityView) {
  if (!Number.isFinite(qps) || qps <= 0) return 1;
  if (!capacityView.effectiveQps || capacityView.effectiveQps <= 0) return 1;
  return Math.max(1, Math.ceil(qps / capacityView.effectiveQps));
}

/**
 * 显存瓶颈下按 KV cache 槽位反算所需副本。
 * 单个大请求占用的 KV 显存超过单副本可用 KV 显存的目标比例时，
 * 即使 QPS 很低也需要更多副本来分散并发请求。
 */
export function replicasForMemoryPressure(currentReplicas, capacityView, thresholds) {
  if (!capacityView.peakTokens || capacityView.availableKvMb <= 0) return currentReplicas;
  const peakRequestKvMb = capacityView.peakTokens
    * (thresholds.kvMemoryMbPerToken ?? DEFAULT_THRESHOLDS.kvMemoryMbPerToken);
  const targetKvBudgetMb = capacityView.availableKvMb * thresholds.memoryUtilization;
  if (peakRequestKvMb < targetKvBudgetMb) {
    return currentReplicas;
  }
  const observedConcurrency = capacityView.observedQps * capacityView.serviceTimeSeconds;
  const totalConcurrency = observedConcurrency * currentReplicas;
  const targetConcurrencyPerReplica = Math.max(1, Math.floor(targetKvBudgetMb / peakRequestKvMb));
  const replicasForConcurrency = Math.ceil(totalConcurrency / targetConcurrencyPerReplica);
  const replicasForSingleRequest = Math.ceil(peakRequestKvMb / targetKvBudgetMb);
  return Math.max(currentReplicas, replicasForConcurrency, replicasForSingleRequest);
}
