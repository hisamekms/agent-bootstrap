import type { OrchestratorStore } from "./store.ts";

export const taskStages = [
  "registered",
  "running",
  "review",
  "awaiting-integration",
  "done",
] as const;

type TrackStage = (typeof taskStages)[number];
type EstimateStage = Exclude<TrackStage, "done">;
type TimelineEvent = ReturnType<
  OrchestratorStore["operatorTaskTimeline"]
>[number];
type TaskStatus = NonNullable<TimelineEvent["status"]>;
type TaskStage = TrackStage | "failed" | "cancelled";

export function taskStage(
  status: TaskStatus,
  execution?: Pick<TimelineEvent, "actor" | "mode">,
  code?: string | null,
): TaskStage {
  if (status === "succeeded") return "done";
  // The store keeps an integrating Task "running" with an integration code.
  if (
    status === "running" &&
    (code === "integration-in-progress" || code === "integration-uncertain")
  )
    return "awaiting-integration";
  if (status === "running" && isReview(execution)) return "review";
  return status;
}

function isReview(execution?: Pick<TimelineEvent, "actor" | "mode">) {
  return (
    execution?.actor === "Reviewer" &&
    (execution.mode === "review" || execution.mode === "verification")
  );
}

export interface Estimate {
  remainingMs: number | null;
  basis: "current-plan";
}

function estimate(remainingMs: number | null): Estimate {
  return { remainingMs, basis: "current-plan" };
}

function mean(samples: readonly number[]): number | null {
  if (!samples.length) return null;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function meanTaskWallTime(
  samples: readonly { startedAt: string; finishedAt: string }[],
) {
  const durations = samples.map(
    ({ startedAt, finishedAt }) =>
      Date.parse(finishedAt) - Date.parse(startedAt),
  );
  return mean(
    durations.filter((value) => Number.isFinite(value) && value >= 0),
  );
}

export function goalEstimate(
  remaining: number,
  average: number | null,
): Estimate {
  return estimate(average === null ? null : Math.round(remaining * average));
}

const timedStages = taskStages.slice(0, -1) as EstimateStage[];
type StageTimes = Partial<Record<TrackStage, number>>;
type StageMeans = Record<EstimateStage, number | null>;

export function taskStageMeans(completed: readonly StageTimes[]): StageMeans {
  const samples = (start: TrackStage, end: TrackStage) =>
    completed.flatMap((times) => {
      const from = times[start];
      const to = times[end];
      return from !== undefined && to !== undefined && to >= from
        ? [to - from]
        : [];
    });
  return {
    registered: mean(samples("registered", "running")),
    running: mean(samples("running", "review")),
    review: mean(samples("review", "awaiting-integration")),
    "awaiting-integration": mean(samples("awaiting-integration", "done")),
  };
}

export function taskEstimate(
  stage: ReturnType<typeof taskStage>,
  elapsedInStage: number,
  means: StageMeans,
): Estimate {
  if (stage === "done") return estimate(0);
  if (stage === "failed" || stage === "cancelled") return estimate(null);
  const remaining = timedStages
    .slice(timedStages.indexOf(stage))
    .map((key) => means[key]);
  const [current, ...later] = remaining;
  if (current == null || later.some((duration) => duration === null))
    return estimate(null);
  return estimate(
    Math.round(
      Math.max(0, current - elapsedInStage) +
        later.reduce<number>((sum, duration) => sum + (duration ?? 0), 0),
    ),
  );
}

interface TaskTiming {
  times: StageTimes;
  lastStage: TrackStage;
  endedAt?: number;
  activeExecution?: TimelineEvent;
  failureCode?: string;
  missingEnvironmentRole?: TimelineEvent["missingEnvironmentRole"];
}

export function taskTimings(events: readonly TimelineEvent[]) {
  const tasks = new Map<string, TaskTiming>();
  for (const event of events) {
    const { taskId, status } = event;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    let task = tasks.get(taskId);
    if (!task || status === "registered") {
      task = { times: {}, lastStage: "registered" };
      tasks.set(taskId, task);
    }
    if (event.executionStatus === "running") task.activeExecution = event;
    if (status === "failed" || status === "cancelled") {
      task.endedAt = at;
      if (status === "failed" && event.code) {
        task.failureCode = event.code;
        task.missingEnvironmentRole = event.missingEnvironmentRole ?? null;
      }
      continue;
    }
    // Integration can update the stored status to running without a new claim.
    if (status === "running" && event.code !== null) continue;
    const stage = status
      ? taskStage(status)
      : isReview(event)
        ? "review"
        : event.mode === "task" && event.actor === "Executor"
          ? "running"
          : undefined;
    if (!stage || stage === "failed" || stage === "cancelled") continue;
    task.lastStage = stage;
    task.times[stage] ??= at;
    if (stage === "done") task.endedAt = at;
  }
  return tasks;
}
