# JARTIC Traffic Proxy for Vercel

JARTIC公開交通情報APIをブラウザから利用するための、Vercel Functions用プロキシです。

## デプロイ手順

1. この `vercel-jartic-proxy` フォルダだけをGitHubリポジトリに入れる。
2. Vercelで `Add New...` -> `Project` を選ぶ。
3. GitHubリポジトリをImportする。
4. Root Directoryを `vercel-jartic-proxy` にする。
5. Framework Presetは `Other` のままでよい。
6. Deployする。

## 動作確認

デプロイ後、次のURLへアクセスします。

```text
https://YOUR-PROJECT.vercel.app/api/jartic
```

GETアクセスなので、正常なら次のように返ります。

```json
{"error":"POST only"}
```

## ハザードマップでの指定方法

ハザードマップURLに `jarticProxy` を付けます。

```text
hazard.html?jarticProxy=https://YOUR-PROJECT.vercel.app/api/jartic
```

一度指定すると、同じブラウザではlocalStorageに保存されます。

## セキュリティ制限

- POSTのみ許可
- 中継先はJARTIC APIに固定
- typeNamesは交通量4種類のみ許可
- WFS固定パラメータのみ許可
- 道路種別は1/3のみ許可
- BBOXは日本周辺、かつ最大4平方度まで
- リクエスト本文は16KBまで
