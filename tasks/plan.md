# 插件与驱动实施计划

范围：把已有存储内核补成计划中的四个插件和两个真实驱动。npm 发布仍是 T11，这次不执行。真实桶没有授权，云端集成不能算通过。

共享契约已冻结，子任务不得修改：

- `src/core/errors.ts` 新增 `constraint_unsatisfied`、`stale_receipt`
- `src/core/plugin.ts` 的 `ProcessingResult`、`ProbeResult`
- `src/core/contracts.ts` 上可选的预签名和分片方法
- `package.json`、`src/index.ts`、`src/io/**`、`src/browser/**`、`src/drivers/memory.ts`

已安装并核对过的版本：Sharp 0.34.5、`@volcengine/tos-sdk` 2.9.1、`@aws-sdk/client-s3` 3.1007.0、`@aws-sdk/s3-request-presigner` 3.1007.0。本机 FFmpeg 9.0.1 在 `/opt/homebrew/bin/ffmpeg`，ffprobe 同目录，编码器有 libx264、aac、libmp3lame、png。

## 分工

| 子任务 | 目录 | 依赖 |
| --- | --- | --- |
| 图片 | `src/plugins/image` | 只依赖 io 与 Sharp |
| 音视频 | `src/plugins/media` | 只依赖 io 与调用方传入的 FFmpeg |
| 探测与清理 | `src/plugins/probe`、`src/plugins/cleanup` | 驱动接口与注入的 fetch |
| TOS/S3 与直传计划 | `src/drivers/tos.ts`、`src/drivers/s3.ts`、`src/server` | 已安装 SDK 的真实类型 |

验收由主任务统一跑 `npm test`、`typecheck`、`build`、插件单测和本地 FFmpeg 集成。根入口仍不得导入 Sharp、FFmpeg 或云 SDK。

## 等待用事件，不用长轮询

副本是否就绪由 `followReplica` 消费宿主发出的 `check` 或 `timeout` 事件。包内不 `sleep`，也不保住一条挂起的轮询。一次检查的结论由纯函数 `decideReplica` 给出：通过即结束，403、内容不符、重定向立即停止，只有还可能出现的状态才带 `nextCheckAt` 交回宿主。宿主用自己的队列或桶通知产生下一个事件，进程可以在一次决策后退出。
