/**
 * 默认阈值与时间参数。所有时间单位均为秒，显存单位为 MB，token 单位为个。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  qpsUtilization: 0.75,
  memoryUtilization: 0.85,
  latencyP95Ms: 800,
  healthyLatencyRatio: 0.7,
  queueLengthPerReplica: 8,
  scaleUpSustainSeconds: 60,
  scaleDownSustainSeconds: 300,
  cooldownSeconds: 90,
  drainSeconds: 30,
  warmupReserveRatio: 0.25,
  sampleIntervalSeconds: 15,
  kvMemoryMbPerToken: 0.12,
});

/**
 * 决策动作枚举。
 */
export const ACTION = Object.freeze({
  SCALE_UP: 'SCALE_UP',
  SCALE_DOWN: 'SCALE_DOWN',
  HOLD: 'HOLD',
  REJECTED: 'REJECTED',
});

/**
 * 信号拒绝原因编码（稳定字符串，便于上层系统匹配）。
 */
export const REJECTION = Object.freeze({
  SUSTAIN_NOT_MET: 'SUSTAIN_NOT_MET',
  JITTER_BREACH: 'JITTER_BREACH',
  SCALE_DOWN_NOT_SUSTAINED: 'SCALE_DOWN_NOT_SUSTAINED',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  WARMUP_RESERVE: 'WARMUP_RESERVE',
  MIN_REPLICAS: 'MIN_REPLICAS',
  NODE_CAPACITY_INSUFFICIENT: 'NODE_CAPACITY_INSUFFICIENT',
  VERSION_SIGNAL_MIXED: 'VERSION_SIGNAL_MIXED',
  INVALID_INPUT: 'INVALID_INPUT',
});
