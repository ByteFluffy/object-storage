# object-storage

模块边界、调用顺序和事件驱动的副本等待见 [docs/architecture.md](docs/architecture.md)。

三个应用共用的对象存储包。当前版本 `0.0.0`，`private`，还没有发布到 npm，也没有接真实 TOS 桶。

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

`npm run test:integration` 会失败退出。真实桶还没有授权的测试前缀。

本机验证使用 Node 与 npm。Bun 1.3.14 解析 Vitest 依赖时失败，所以安装和测试走 npm。
