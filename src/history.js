import { DEFAULT_THRESHOLDS } from './defaults.js';

/**
 * 判断单个采样点是否越过扩容线（任一维度越线即算越线）。
 * 历史点的服务时间随当时的 P95 延迟变化，必须用采样点自身的
 * P95 估算算力容量，不能直接套用当前（可能已经恶化的）容量视图。
 */
function isBreaching(sample, capacityView, thresholds) {
  const sampleServiceTime = typeof sample.p95LatencyMs === 'number'
    ? sample.p95LatencyMs / 1000
    : capacityView.serviceTimeSeconds;
  const sampleComputeLimit = sampleServiceTime > 0 ? 1 / sampleServiceTime : Number.POSITIVE_INFINITY;
  const sampleEffectiveQps = Number.isFinite(capacityView.memoryQpsLimit)
    ? Math.min(sampleComputeLimit, capacityView.memoryQpsLimit)
    : sampleComputeLimit;
  const latencyBreach = sample.p95LatencyMs !== undefined
    && sample.p95LatencyMs > thresholds.latencyP95Ms;
  const queueBreach = sample.queueLength !== undefined
    && sample.queueLength > thresholds.queueLengthPerReplica;
  const qpsBreach = sample.qpsPerReplica !== undefined
    && sample.qpsPerReplica / sampleEffectiveQps > thresholds.qpsUtilization;
  const memoryBreach = sample.gpuUtilization !== undefined
    && sample.gpuUtilization > thresholds.memoryUtilization;
  return {
    breaching: latencyBreach || queueBreach || qpsBreach || memoryBreach,
    reasons: [
      latencyBreach && 'LATENCY_P95',
      queueBreach && 'QUEUE_LENGTH',
      qpsBreach && 'QPS_UTILIZATION',
      memoryBreach && 'GPU_MEMORY',
    ].filter(Boolean),
  };
}

/**
 * 判断单个采样点是否处于低负载（所有维度都低于健康线，健康线取扩容线的 70%）。
 */
function isLowLoad(sample, capacityView, thresholds) {
  const healthyRatio = thresholds.healthyLatencyRatio ?? 0.7;
  const sampleServiceTime = typeof sample.p95LatencyMs === 'number'
    ? sample.p95LatencyMs / 1000
    : capacityView.serviceTimeSeconds;
  const sampleComputeLimit = sampleServiceTime > 0 ? 1 / sampleServiceTime : Number.POSITIVE_INFINITY;
  const sampleEffectiveQps = Number.isFinite(capacityView.memoryQpsLimit)
    ? Math.min(sampleComputeLimit, capacityView.memoryQpsLimit)
    : sampleComputeLimit;
  const latencyOk = sample.p95LatencyMs === undefined
    || sample.p95LatencyMs <= thresholds.latencyP95Ms * healthyRatio;
  const queueOk = sample.queueLength === undefined
    || sample.queueLength <= thresholds.queueLengthPerReplica * healthyRatio;
  const qpsOk = sample.qpsPerReplica === undefined
    || sample.qpsPerReplica / sampleEffectiveQps <= thresholds.qpsUtilization * healthyRatio;
  const memoryOk = sample.gpuUtilization === undefined
    || sample.gpuUtilization <= thresholds.memoryUtilization * healthyRatio;
  return latencyOk && queueOk && qpsOk && memoryOk;
}

function sampleTime(sample, index, intervalSeconds) {
  if (typeof sample.t === 'number') return sample.t;
  return index * intervalSeconds;
}

/**
 * 评估历史时间序列，得到扩容/缩容信号的持续时间与抖动次数。
 *
 * 关键规则：
 * - 扩容必须在 lookback 窗口内“持续”越线，单次尖峰不触发（防突发误判）；
 * - 窗口内越线/恢复来回切换记为抖动，抖动越线信号直接拒绝；
 * - 缩容必须在更长的窗口内持续低负载，且期间没有任何排队。
 *
 * @param {Array<object>} history 历史采样（可含 t 秒级时间戳）
 * @param {object} capacityView estimateCapacity 的返回值
 * @param {object} thresholds 阈值配置
 * @returns {object} 信号评估结果
 */
export function evaluateSignals(history, capacityView, thresholds = DEFAULT_THRESHOLDS) {
  const interval = thresholds.sampleIntervalSeconds ?? 15;
  const samples = (history ?? []).map((sample, index) => {
    const breach = isBreaching(sample, capacityView, thresholds);
    return {
      t: sampleTime(sample, index, interval),
      breaching: breach.breaching,
      breachReasons: breach.reasons,
      lowLoad: isLowLoad(sample, capacityView, thresholds),
      raw: sample,
    };
  });

  if (samples.length === 0) {
    return {
      samples: 0,
      scaleUp: {
        sustained: false,
        sustainedSeconds: 0,
        breachCount: 0,
        flapping: false,
        flappingTransitions: 0,
        breachReasons: [],
      },
      scaleDown: {
        sustained: false,
        lowLoadSeconds: 0,
        queueClear: true,
      },
      cooldown: { active: false, remainingSeconds: 0 },
    };
  }

  const upWindow = thresholds.scaleUpSustainSeconds ?? 60;
  const downWindow = thresholds.scaleDownSustainSeconds ?? 300;
  const latestTime = samples[samples.length - 1].t;
  const windowSamples = samples.filter((sample) => latestTime - sample.t <= upWindow + interval / 2);

  let flappingTransitions = 0;
  let previousState = windowSamples[0].breaching;
  const breachReasons = new Set();
  for (const sample of windowSamples) {
    if (sample.breaching !== previousState) flappingTransitions += 1;
    previousState = sample.breaching;
    if (sample.breaching) sample.breachReasons.forEach((reason) => breachReasons.add(reason));
  }
  const flapping = flappingTransitions >= 2;
  const breachCount = windowSamples.filter((sample) => sample.breaching).length;
  const allBreaching = windowSamples.every((sample) => sample.breaching);
  const sustainedSeconds = allBreaching && windowSamples.length > 1
    ? latestTime - windowSamples[0].t
    : 0;

  const downSamples = samples.filter((sample) => latestTime - sample.t <= downWindow + interval / 2);
  const allLowLoad = downSamples.length > 1 && downSamples.every((sample) => sample.lowLoad);
  const lowLoadSeconds = allLowLoad ? latestTime - downSamples[0].t : 0;
  const queueClear = downSamples.every(
    (sample) => (sample.raw.queueLength ?? 0) <= thresholds.queueLengthPerReplica * 0.2,
  );

  const lastActionAt = samples.findLast((sample) => sample.raw.lastScaleActionAt !== undefined)
    ?.raw.lastScaleActionAt;
  let cooldownActive = false;
  let cooldownRemaining = 0;
  if (typeof lastActionAt === 'number') {
    const elapsed = latestTime - lastActionAt;
    cooldownRemaining = Math.max(0, (thresholds.cooldownSeconds ?? 90) - elapsed);
    cooldownActive = cooldownRemaining > 0;
  }

  return {
    samples: samples.length,
    scaleUp: {
      sustained: allBreaching && !flapping && sustainedSeconds >= upWindow,
      sustainedSeconds,
      requiredSeconds: upWindow,
      breachCount,
      flapping,
      flappingTransitions,
      breachReasons: [...breachReasons],
    },
    scaleDown: {
      sustained: allLowLoad && lowLoadSeconds >= downWindow && queueClear,
      lowLoadSeconds,
      requiredSeconds: downWindow,
      queueClear,
    },
    cooldown: {
      active: cooldownActive,
      remainingSeconds: cooldownRemaining,
    },
  };
}
