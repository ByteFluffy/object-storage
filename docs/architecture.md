# 架构

这个包把上传、处理、探测和交付判断分成独立结果。处理成功不表示已经上传，上传成功不表示链接已验证，判断够用也不表示已经处理。根入口只导出存储内核。图片、音视频、探测、清理、交付判断、TOS 和 S3 都是旁边的模块，调用方按需导入。

## 模块

```mermaid
flowchart TB
  host[宿主应用]
  host --> storage[Storage 内核]
  host --> browser[browser 直传执行]
  host --> image[image 插件]
  host --> media[media 插件]
  host --> probe[probe 插件]
  host --> cleanup[cleanup 插件]
  host --> delivery[delivery 判断]
  host --> server[server 签名与分片]

  storage --> driver[StorageDriver]
  driver --> memory[memory]
  driver --> tos[tos]
  driver --> s3[s3]
  server --> driver

  image --> sharp[Sharp 动态加载]
  media --> ffmpeg[调用方传入的 FFmpeg]
  probe --> driver
  cleanup --> driver
  browser --> putPlan[PUT 计划]
  server --> putPlan
  server --> getPlan[GET 计划]
```

内核文件在 `src/core`、`src/io`。`src/index.ts` 不导入 Sharp、FFmpeg 或云 SDK。浏览器入口只执行已经签好的 PUT 计划，不保存云凭证。`createSingleGetPlan` 只生成 GET，过期秒数由调用方传入。

## 一次调用只做一件事

宿主自己串联。包里没有流水线。

```mermaid
sequenceDiagram
  participant Host as 宿主
  participant Image as image
  participant Storage as Storage
  participant Probe as probe

  Host->>Image: convertImage
  Image-->>Host: ProcessingResult
  Note over Host: 产物仍可读，用完再 release
  Host->>Storage: upload
  Storage-->>Host: UploadResult
  Note over Host: delivery 固定为 not_requested
  Host->>Probe: checkObject 或 checkUrl
  Probe-->>Host: ProbeResult
```

服务端封存走 `Storage.finalize`：先核对临时对象的 SHA-256，再用 `ifNoneMatch: '*'` 复制到最终 Key。内容不一致不会覆盖已有对象。临时对象不会被这次调用删除。

## 交付判断不处理文件

`assessDelivery` 只比较已经拿到的事实和调用方约束。事实来自探测或图片、音视频元信息。约束包括允许的媒体类型、最大字节、最大边和最大时长。它不读取文件，也不填处理参数。

```mermaid
flowchart TD
  input[事实与约束]
  input --> missing{约束所需事实齐全}
  missing -->|否| evidence[insufficient_evidence]
  missing -->|是| fit{约束都满足}
  fit -->|是| usable[usable]
  fit -->|否| kind{媒体种类}
  kind -->|图片| imageOp[convertImage 或 resizeImage 或 compressImage]
  kind -->|视频| videoOp[transcodeVideo 或 trimMedia 或 compressVideo]
  kind -->|音频| audioOp[transcodeAudio 或 trimMedia]
  kind -->|其他| unsupported[unsupported]
```

多种约束同时不满足时，只返回第一个该处理的函数，并列出其余失败项。宿主处理完再判断一次。图片没有边长或时长这类事实时，不会把缺数据当成失败。

地区差异留在宿主传入的约束里。包不知道北京或柔佛该用哪种格式。

```mermaid
sequenceDiagram
  participant Host as 宿主
  participant Fit as assessDelivery
  participant Work as image 或 media
  participant Server as server

  Host->>Fit: 已有事实与该地区约束
  alt 可以直接用
    Fit-->>Host: usable
  else 需要处理
    Fit-->>Host: 一个现有函数名
    Host->>Work: 调用方传入参数
    Work-->>Host: ProcessingResult
  end
  Host->>Server: createSingleGetPlan
  Server-->>Host: GET 计划
```

## 副本等待是事件，不是长轮询

`followReplica` 不睡眠，也不保住一条轮询。宿主从自己的队列或桶通知发出 `check` 或 `timeout`。`decideReplica` 只根据这一次结果作决定。

```mermaid
sequenceDiagram
  participant Host as 宿主
  participant Follow as followReplica
  participant Decide as decideReplica
  participant Check as checkObject

  Host->>Follow: event check
  Follow->>Check: 一次检查
  Check-->>Follow: ProbeResult
  Follow->>Decide: 这次结果与截止时间
  alt 通过
    Decide-->>Host: settled
  else 403、内容不符或重定向
    Decide-->>Host: stopped
  else 仍可能出现
    Decide-->>Host: pending 与 nextCheckAt
    Note over Host: 进程可以退出，下次由宿主再发事件
  end
```

通过就结束。权限失败、内容不符和重定向不再排下一次检查。只有对象还可能出现时，才把 `nextCheckAt` 交回宿主。

## 驱动

TOS 和 S3 都实现同一个 `StorageDriver`。厂商类型停在驱动文件里。条件写在 TOS 上使用已核对的 `forbidOverwrite`，在 S3 3.1007.0 上使用 `IfNoneMatch`。CRC64 保持字符串。ETag 不写入 checksum。PUT 和 GET 是两份计划。TOS SDK 的预签名没有 HEAD，所以要 HEAD 时直接拒绝。
