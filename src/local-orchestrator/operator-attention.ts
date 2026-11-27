import type { InboxItem } from "./inbox.ts";

export function pendingDecisions<T extends InboxItem>(items: readonly T[]) {
  return items.filter(
    ({ weight, state, kind }) =>
      weight === "action" &&
      state !== "resolved" &&
      kind !== "task-failed" &&
      kind !== "execution-over-budget",
  );
}

export function groupProblems<T extends { taskId: string | null }>(
  problems: readonly T[],
) {
  const groups = new Map<string, T[]>();
  for (const [index, problem] of problems.entries()) {
    const key = problem.taskId ? `task:${problem.taskId}` : `problem:${index}`;
    const group = groups.get(key);
    if (group) group.push(problem);
    else groups.set(key, [problem]);
  }
  return [...groups.values()];
}

const failureLabels = new Map([
  ["actor-failed", "エージェントの実行エラー"],
  ["auth-required", "認証が必要"],
  ["budget-exceeded", "予算超過"],
  ["candidate-mismatch", "変更候補の不一致"],
  ["config-invalid", "設定エラー"],
  ["credential-leak", "機密情報の検出"],
  ["env-update-disabled", "依存の更新が無効"],
  ["env-missing", "環境が未構築"],
  ["goal-base-mismatch", "Goal のベースの不一致"],
  ["host-error", "ホストエラー"],
  ["integration-rejected", "統合の却下"],
  ["mount-busy", "マウントが使用中"],
  ["path-violation", "パス違反"],
  ["prompt-too-large", "入力サイズ超過"],
  ["rate-limited", "利用頻度の上限"],
  ["review-concern", "レビューで指摘あり"],
  ["revision-limit", "修正回数の上限"],
  ["secret-test-required", "シークレットの動作確認が必要"],
  ["session-ended", "セッションの終了"],
  ["shell-disabled", "シェルの実行が無効"],
  ["timed-out", "時間切れ"],
  ["unsafe-input-symlink", "入力のシンボリックリンクが不正"],
  ["verification-failed", "検証の失敗"],
  ["volume-detached", "ボリュームの切断"],
]);

export function failureLabel(code: string | null) {
  return failureLabels.get(code ?? "");
}

export function failureReason(code: string | null) {
  return (
    failureLabel(code) ?? (code ? `失敗（コード: ${code}）` : "実行エラー")
  );
}

export function environmentMissingReason(verification: boolean): string {
  return verification
    ? "変更候補のキーの環境がありません。environment build はローカルの main にコミットされた内容だけをビルドします。変更候補が依存関係の宣言を変更して新しい環境が必要な場合は、environment.autoBuild を有効にしてください。"
    : "このキーの環境がありません。agent-bootstrap environment build --target <dir> --allow-network を実行するか、environment.autoBuild を有効にしてください。";
}

export const environmentUpdateDisabledReason =
  "依存を更新するには、非公開の設定で environment.enabled と environment.autoBuild を有効にしてから Task を再試行してください。";
