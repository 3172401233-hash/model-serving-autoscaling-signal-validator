import { ACTION, DEFAULT_THRESHOLDS, REJECTION } from './defaults.js';
import { estimateCapacity, replicasForMemoryPressure, replicasForQps } from './capacity.js';
import { evaluateSignals } from './history.js';

function rejection(code, message) {
  return { code, message };
}

function buildRisks({
  action,
  add,
  coldStartSeconds,
  currentQps,
  targetTotalQps,
  capacityView,
  memoryConstrainedNow,
  nodes,
  nodeCap,
}) {
  const risks = [];
  if (action !== ACTION.SCALE_UP || add <= 0) return risks;

  risks.push({
    code: 'COLD_START_WINDOW',
    severity: 'INFO',
    message: `新副本预热约 ${coldStartSeconds}s 期间不接流量，期间容量仍为 ${targetTotalQps} QPS`,
    windowSeconds: coldStartSeconds,
  });

  if (currentQps > targetTotalQps) {
    risks.push({
      code: 'OVERLOAD_DURING_WARMUP',
      severity: 'HIGH',
      message: `当前需求 ${currentQps} QPS 超过预热期可用容量 ${targetTotalQps} QPS，预计持续排队约 ${coldStartSeconds}s`,
      shortfallQps: Number((currentQps - targetTotalQps).toFixed(2)),
      windowSeconds: coldStartSeconds,
    });
  }

  if (capacityView.estimatedQueueWaitMs > 0) {
    risks.push({
      code: 'QUEUE_BACKLOG',
      severity: capacityView.estimatedQueueWaitMs > capacityView.p95LatencyMs ? 'HIGH' : 'MEDIUM',
      message: `当前排队预计额外等待 ${capacityView.estimatedQueueWaitMs}ms，冷启动期间积压可能继续增长`,
      estimatedWaitMs: capacityView.estimatedQueueWaitMs,
    });
  }

  if (memoryConstrainedNow || capacityView.memoryUtilization >= DEFAULT_THRESHOLDS.memoryUtilization) {
    risks.push({
      code: 'GPU_MEMORY_PRESSURE',
      severity: 'HIGH',
      message: '瓶颈在 GPU 显存而非 QPS：大请求可能继续占满显存，新副本不解决单副本 KV cache 上限',
      memoryUtilization: capacityView.memoryUtilization,
      memoryConstrained: memoryConstrainedNow,
    });
  }

  if (nodes && nodeCap > 0 && add / nodeCap >= 0.5) {
    risks.push({
      code: 'NODE_POOL_NEAR_LIMIT',
      severity: 'MEDIUM',
      message: `本次扩容占用 ${add}/${nodeCap} 个空闲节点，节点池余量不足`,
    });
  }

  return risks;
}

/**
 * 为单一版本（或无版本切换的整个服务）生成扩缩容决策。
 *
 * @param {object} options 决策输入
 * @returns {object} 单版本决策结果
 */
export function planGroup(options) {
  const {
    groupId = 'default',
    current,
    nodePool,
    predictedTrafficQps = 0,
    thresholds: rawThresholds = {},
  } = options;

  const thresholds = { ...DEFAULT_THRESHOLDS, ...rawThresholds };
  const { replicas: currentReplicas, coldStartSeconds, history } = current;
  const minReplicas = Math.max(1, current.minReplicas ?? 1);
  const capacityView = estimateCapacity(current, thresholds);
  const signals = evaluateSignals(history, capacityView, thresholds);

  const perReplicaQps = capacityView.observedQps;
  const observedTotalQps = perReplicaQps * currentReplicas;
  const demandQps = Math.max(observedTotalQps, predictedTrafficQps);
  const desiredByQps = replicasForQps(demandQps, capacityView);
  const desiredByMemory = replicasForMemoryPressure(currentReplicas, capacityView, thresholds);
  const memoryConstrainedNow = capacityView.memoryConstrained
    || capacityView.memoryUtilization >= thresholds.memoryUtilization;
  const desiredByDemand = Math.max(desiredByQps, desiredByMemory);
  const memoryBreaching = memoryConstrainedNow
    || (capacityView.queueLength > thresholds.queueLengthPerReplica
      && capacityView.memoryUtilization >= thresholds.memoryUtilization);

  const nodeCap = nodePool?.maxReplicas ?? Number.POSITIVE_INFINITY;
  const nodeLimit = Number.isFinite(nodeCap)
    ? Math.max(0, nodeCap - (nodePool.currentReplicas ?? currentReplicas))
    : Number.POSITIVE_INFINITY;

  const currentTotalQps = Number((capacityView.effectiveQps ?? 0) * currentReplicas);
  const rejections = [];
  const extraRisks = [];
  let action = ACTION.HOLD;
  let targetReplicas = currentReplicas;
  let effectiveAfterSeconds = 0;
  let trigger = 'NONE';

  if (signals.cooldown.active) {
    action = ACTION.REJECTED;
    trigger = 'COOLDOWN';
    rejections.push(rejection(
      REJECTION.COOLDOWN_ACTIVE,
      `距上次扩缩容 ${(thresholds.cooldownSeconds ?? 90) - signals.cooldown.remainingSeconds}s，冷却期还剩 ${signals.cooldown.remainingSeconds}s`,
    ));
  } else if (desiredByDemand > currentReplicas) {
    trigger = predictedTrafficQps > observedTotalQps ? 'PREDICTED_TRAFFIC' : 'OBSERVED_LOAD';
    const reactiveGate = trigger === 'OBSERVED_LOAD';

    if (reactiveGate && !signals.scaleUp.sustained) {
      const windowSize = signals.samples;
      const isJitter = signals.scaleUp.flapping
        && signals.scaleUp.breachCount >= Math.ceil(windowSize / 2);
      if (isJitter) {
        action = ACTION.REJECTED;
        rejections.push(rejection(
          REJECTION.JITTER_BREACH,
          `扩容信号在窗口内抖动 ${signals.scaleUp.flappingTransitions} 次，拒绝在阈值附近反复增减`,
        ));
      } else {
        action = ACTION.REJECTED;
        rejections.push(rejection(
          REJECTION.SUSTAIN_NOT_MET,
          `扩容需持续越线 ${signals.scaleUp.requiredSeconds}s，当前仅 ${signals.scaleUp.sustainedSeconds}s（越线采样 ${signals.scaleUp.breachCount} 次）`,
        ));
      }
    } else {
      const wanted = desiredByDemand - currentReplicas;
      const allowed = Number.isFinite(nodeLimit) ? Math.min(wanted, nodeLimit) : wanted;
      if (allowed <= 0) {
        action = ACTION.REJECTED;
        rejections.push(rejection(
          REJECTION.NODE_CAPACITY_INSUFFICIENT,
          `节点池上限 ${nodePool.maxReplicas} 副本，当前已用 ${nodePool.currentReplicas ?? currentReplicas}，无法再扩容`,
        ));
      } else {
        action = ACTION.SCALE_UP;
        targetReplicas = currentReplicas + allowed;
        effectiveAfterSeconds = coldStartSeconds;
        if (allowed < wanted) {
          extraRisks.push({
            code: 'NODE_CAPACITY_CAPPED',
            severity: 'MEDIUM',
            message: `节点池只允许再扩 ${allowed} 副本，需求为 ${wanted} 副本，扩容已被节点上限截断`,
            wantedReplicas: wanted,
            allowedReplicas: allowed,
          });
        }
      }
    }
  } else if (desiredByDemand < currentReplicas
    || signals.scaleDown.lowLoadSeconds > 0
    || (
    desiredByDemand === currentReplicas
    && signals.scaleDown.sustained
    && !memoryBreaching
  )) {
    trigger = 'LOW_LOAD';
    if (currentReplicas <= minReplicas) {
      action = ACTION.REJECTED;
      rejections.push(rejection(
        REJECTION.MIN_REPLICAS,
        `当前 ${currentReplicas} 副本已达到最小副本数 ${minReplicas}，禁止继续缩容`,
      ));
    } else if (!signals.scaleDown.sustained) {
      action = ACTION.REJECTED;
      rejections.push(rejection(
        REJECTION.SCALE_DOWN_NOT_SUSTAINED,
        `缩容需持续低负载 ${signals.scaleDown.requiredSeconds}s 且队列清空，当前低负载 ${signals.scaleDown.lowLoadSeconds}s，队列清空=${signals.scaleDown.queueClear}`,
      ));
    } else {
      const reserve = Math.ceil(
        replicasForQps(demandQps, capacityView) * (1 + thresholds.warmupReserveRatio),
      );
      const floor = Math.max(minReplicas, reserve);
      const removable = Math.max(0, currentReplicas - floor);
      if (removable <= 0) {
        action = ACTION.REJECTED;
        rejections.push(rejection(
          REJECTION.WARMUP_RESERVE,
          `预热带宽要求保留 ${floor} 副本（含 ${Math.round(thresholds.warmupReserveRatio * 100)}% 余量），当前无可缩容量`,
        ));
      } else {
        action = ACTION.SCALE_DOWN;
        targetReplicas = currentReplicas - 1;
        effectiveAfterSeconds = thresholds.drainSeconds ?? 30;
      }
    }
  }

  const targetTotalQps = Number(((capacityView.effectiveQps ?? 0) * targetReplicas).toFixed(2));
  const risks = [...buildRisks({
    action,
    add: targetReplicas - currentReplicas,
    coldStartSeconds,
    currentQps: observedTotalQps,
    targetTotalQps: currentTotalQps,
    capacityView,
    memoryConstrainedNow,
    nodes: nodePool,
    nodeCap: Number.isFinite(nodeLimit) ? nodeLimit : 0,
  }), ...extraRisks];

  return {
    groupId,
    action,
    trigger,
    currentReplicas,
    targetReplicas,
    delta: targetReplicas - currentReplicas,
    minReplicas,
    effectiveAfterSeconds,
    coldStartSeconds,
    capacity: {
      perReplica: capacityView,
      currentTotalQps,
      targetTotalQps,
      observedTotalQps: Number(observedTotalQps.toFixed(2)),
      predictedTrafficQps,
      demandQps: Number(demandQps.toFixed(2)),
      desiredByDemand,
    },
    signals,
    nodePool: nodePool
      ? {
          maxReplicas: nodePool.maxReplicas,
          currentReplicas: nodePool.currentReplicas ?? currentReplicas,
          headroomReplicas: Number.isFinite(nodeLimit) ? nodeLimit : null,
        }
      : null,
    rejections,
    risks,
  };
}
