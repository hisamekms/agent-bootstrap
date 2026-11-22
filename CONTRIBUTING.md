# 開発への参加

人間と AI の開発者の両方がこのルールに従う。作業上の制約は
[AGENTS.md](AGENTS.md) を参照する。

## ブランチ

- `main` は保護ブランチ。直接コミットしない。
- 作業ブランチの名前は `<type>/<英語の短い説明>` とする（例：`feat/model-coordinator`、
  `fix/audit-timeout`）。`type` はコミットと同じものを使い、説明は英小文字の
  kebab-case にする。

## コミット

[Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) に従う。
`type` と `scope` は英語、要約と本文は日本語で書く。

```text
feat(coordinator): モデルの提案をルーターに渡すアダプターを追加

変更の理由と、検証の結果（bun verify の件数や実機スモークなど）を書く。
```

- `type`：`feat`、`fix`、`docs`、`test`、`refactor`、`chore`
- `scope`：任意。`coordinator`、`sandbox`、`audit` など変更した領域
- AI が作ったコミットには `Co-Authored-By` トレーラーを付ける。
- 秘密情報、`.local/` の内容、ホストの認証ファイルはコミットしない。

## マージ

- `main` への変更は PR だけで入る。マージ方式は squash merge のみ。PR の
  タイトルを上のコミット形式で書き、そのまま `main` のコミットメッセージにする。
- CI の `verify` ジョブ（`bun verify`）が通ったら、自動マージで取り込まれる。
  承認は必須にしない。マージ後に作業ブランチは自動で削除される。
- 作業ブランチのプッシュ、PR の作成、自動マージの有効化は、人間が頼んだ
  場合に AI も行える。リリース、リポジトリ設定と保護ルールの変更は人間が行う。

## マージ前の確認

- コミット前に `bun verify` を通す。マージ前は CI が同じ確認を行う。
- 信頼境界に関わる変更は、自動マージを有効にする前に独立したセキュリティ
  レビューを受ける。
  対象は監査、信頼されたホスト、サンドボックス、認証、Coordinator、
  モデルアダプター。
- 実機スモークはローカルの VM が必要なので必須にしない。アダプターや実行環境を
  変えたときに実行し、結果を [docs/milestones.md](docs/milestones.md) に記録する。
