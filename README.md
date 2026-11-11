# object-storage

模块边界、调用顺序和事件驱动的副本等待见 [docs/architecture.md](docs/architecture.md)。

三个应用共用的对象存储包。当前版本 `0.0.0`，`private`，还没有发布到 npm。真实桶密钥只从运行环境读取，不放进仓库。

服务端从 `object-storage` 导入。浏览器只从 `object-storage/browser` 导入。可选子入口是 `object-storage/drivers/tos`、`object-storage/drivers/s3`、`object-storage/server`、`object-storage/delivery`、`object-storage/plugins/probe`、`object-storage/plugins/cleanup`、`object-storage/plugins/image`、`object-storage/plugins/media`。`server` 可以签发 PUT 和 GET。`delivery` 只判断现有处理函数够不够用，不填处理参数。内存驱动在 `object-storage/drivers/memory`，用来验证契约，不代表云端已经验收。

上传结果里的 `delivery.status` 固定是 `not_requested`。处理成功、上传成功、链接已验证是三件不同的事。ETag 和 checksum 分开返回，不能把 ETag 当成 MD5。

```ts
import { createStorage } from 'object-storage';
import { createMemoryDriver } from 'object-storage/drivers/memory';

const storage = createStorage({
  drivers: [createMemoryDriver({ storageId: 'local' })],
});

const uploaded = await storage.upload({
  storageId: 'local',
  key: 'temp/note.txt',
  source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
});
```

## 功能

- 服务端上传、条件封存、读取。上传结果不表示链接已验证。
- 浏览器执行已签名的 PUT。
- TOS 与 S3 驱动，PUT 和 GET 预签名，分片计划。
- 探测桶、对象和 URL。副本等待由宿主事件推进。
- 只删除登记对象，并只终止登记的分片。
- 图片转换、缩放、目标体积。音视频转码、压缩、提取、裁剪、拼接。
- `assessDelivery` 根据调用方约束指出该用哪个现有函数，不填参数。

调用示例在 `examples/server-archive.ts` 和 `examples/calls.ts`。前者走内存驱动完成上传和封存。后者演示交付判断和 GET 计划的调用形状。

`npm run test:integration` 在没有 `OBJECT_STORAGE_LIVE_TEST=1` 时失败退出。配置了环境变量时，它只对 `object-storage-smoke/` 前缀做一次上传、签名、检查和删除。

本机验证使用 Node 与 npm。Bun 1.3.14 解析 Vitest 依赖时失败，所以安装和测试走 npm。
