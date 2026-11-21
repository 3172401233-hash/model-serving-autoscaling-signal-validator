import { ACTION, DEFAULT_THRESHOLDS, REJECTION } from './defaults.js';
import { planGroup } from './planner.js';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateCommon(current, label = 'current') {
  if (!current || typeof current !== 'object') {
    fail(REJECTION.INVALID_INPUT, `${label} 必须是对象`);
  }
  if (!Number.isInteger(current.replicas) || current.replicas < 1) {
    fail(REJECTION.INVALID_INPUT, `${label}.replicas 必须是 >= 1 的整数`);
  }
  if (!Number.isFinite(current.coldStartSeconds) || current.coldStartSeconds < 0) {
    fail(REJECTION.INVALID_INPUT, `${label}.coldStartSeconds 必须是非负数字`);
  }
  if (!Array.isArray(current.tokenDistribution) || current.tokenDistribution.length === 0) {
    fail(REJECTION.INVALID_INPUT, `${label}.tokenDistribution 必须是非空数组`);
  }
  for (const point of current.tokenDistribution) {
    if (!Number.isFinite(point.tokens) || point.tokens <= 0) {
      fail(REJECTION.INVALID_INPUT, `${label}.tokenDistribution[].tokens 必须是正数`);
    }
  }
  if (!Number.isFinite(current.gpuMemoryMb) || current.gpuMemoryMb <= 0) {
    fail(REJECTION.INVALID_INPUT, `${label}.gpuMemoryMb 必须是正数`);
  }
  if (!Number.isFinite(current.p95LatencyMs) || current.p95LatencyMs <= 0) {
    fail(REJECTION.INVALID_INPUT, `${label}.p95LatencyMs 必须是正数`);
  }
}

function toStep(result) {
  const step = {
    groupId: result.groupId,
    action: result.action,
    trigger: result.trigger,
    currentReplicas: result.currentReplicas,
    targetReplicas: result.targetReplicas,
    delta: result.delta,
    effectiveAfterSeconds: result.effectiveAfterSeconds,
  };
  if (result.rejections.length > 0) step.rejections = result.rejections;
  if (result.risks.length > 0) step.risks = result.risks;
  return step;
}

/**
 * 扩缩容信号校验器入口。
 *
 * 两种输入形态：
 * 1. 单版本：{ current, nodePool, predictedTrafficQps, thresholds }
 * 2. 版本切换：{ versionSwitch: true, versions: [{ version, current, ... }] }
 *    新版本与旧版本分别独立计算，信号绝不跨版本相加。
 *
 * @param {object} input 校验输入
 * @returns {object} 推荐副本数、生效时间、容量视图、风险与拒绝原因
 */
export function validateScalingSignal(input = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };

  if (input.versionSwitch) {
    if (!Array.isArray(input.versions) || input.versions.length < 2) {
      fail(REJECTION.INVALID_INPUT, '版本切换模式下 versions 必须包含至少 2 个版本');
    }
    if (input.current) {
      fail(REJECTION.VERSION_SIGNAL_MIXED, '版本切换期间禁止提供聚合 current，新旧版本信号不能直接相加');
    }

    const versionIds = new Set();
    const results = input.versions.map((entry) => {
      if (!entry || typeof entry !== 'object' || !entry.version) {
        fail(REJECTION.INVALID_INPUT, 'versions[].version 必须提供版本标识');
      }
      if (versionIds.has(entry.version)) {
        fail(REJECTION.INVALID_INPUT, `版本 ${entry.version} 重复`);
      }
      versionIds.add(entry.version);
      validateCommon(entry.current, `versions[${entry.version}].current`);
      return planGroup({
        groupId: entry.version,
        current: entry.current,
        nodePool: entry.nodePool,
        predictedTrafficQps: entry.predictedTrafficQps ?? 0,
        thresholds: { ...thresholds, ...(entry.thresholds ?? {}) },
      });
    });

    const steps = results.map(toStep);
    const rejections = results.flatMap((result) => result.rejections);
    const risks = results.flatMap((result) => result.risks);
    const overallAction = results.some((result) => result.action === ACTION.SCALE_UP)
      ? ACTION.SCALE_UP
      : results.some((result) => result.action === ACTION.SCALE_DOWN)
        ? ACTION.SCALE_DOWN
        : results.some((result) => result.action === ACTION.REJECTED)
          ? ACTION.REJECTED
          : ACTION.HOLD;

    return {
      mode: 'VERSION_SWITCH',
      overallAction,
      recommendedReplicas: results.reduce((sum, result) => sum + result.targetReplicas, 0),
      currentReplicas: results.reduce((sum, result) => sum + result.currentReplicas, 0),
      effectiveAfterSeconds: Math.max(...results.map((result) => result.effectiveAfterSeconds)),
      coldStartSeconds: Math.max(...results.map((result) => result.coldStartSeconds)),
      steps,
      capacity: {
        currentTotalQps: results.reduce((sum, result) => sum + result.capacity.currentTotalQps, 0),
        targetTotalQps: results.reduce((sum, result) => sum + result.capacity.targetTotalQps, 0),
        observedTotalQps: results.reduce((sum, result) => sum + result.capacity.observedTotalQps, 0),
        predictedTrafficQps: results.reduce((sum, result) => sum + result.capacity.predictedTrafficQps, 0),
        perVersion: results.map((result) => ({
          version: result.groupId,
          currentReplicas: result.currentReplicas,
          targetReplicas: result.targetReplicas,
          currentTotalQps: result.capacity.currentTotalQps,
          targetTotalQps: result.capacity.targetTotalQps,
          perReplica: result.capacity.perReplica,
        })),
      },
      rejections,
      risks,
    };
  }

  validateCommon(input.current, 'current');
  const result = planGroup({
    groupId: 'default',
    current: input.current,
    nodePool: input.nodePool,
    predictedTrafficQps: input.predictedTrafficQps ?? 0,
    thresholds,
  });

  return {
    mode: 'SINGLE_VERSION',
    overallAction: result.action,
    recommendedReplicas: result.targetReplicas,
    currentReplicas: result.currentReplicas,
    effectiveAfterSeconds: result.effectiveAfterSeconds,
    coldStartSeconds: result.coldStartSeconds,
    steps: [toStep(result)],
    capacity: result.capacity,
    signals: result.signals,
    nodePool: result.nodePool,
    rejections: result.rejections,
    risks: result.risks,
  };
}
