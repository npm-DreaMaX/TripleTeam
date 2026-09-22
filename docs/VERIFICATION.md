# 验证、证据强度与只读执行

TripleTeam 的完成声明表示：冻结的检查在指定 Git tree 上通过，并满足该 run 的其他验收条件。检查覆盖不足时，系统无法据此证明未被检查的产品语义。实际正确率仍需独立 benchmark 或用户验收。

## 默认行为

- Check 的名字和命令中的 `test`、`integration` 等字样不再决定证据强度。
- 未声明 `evidenceClass` 的检查是 `STRUCTURAL`；默认 `git diff --check` 也是 `STRUCTURAL`。
- 自动发现的 `npm run check`、`npm test` 是 `BUILD`。本地测试仍会执行，失败仍会阻止验收，但仅凭可写进程中的测试不能宣布 `VERIFIED_DELIVERY`。
- `BEHAVIORAL` / `EXTERNAL` 必须同时声明受保护的 oracle 和使用不可变镜像的 Docker 只读执行；缺少任一项则降为 `BUILD`。
- 全部普通门控通过、证据仅为结构或构建级时，终态是 `STRUCTURAL_HANDOFF`。系统不会为了得到更好的完成数字自动提高证据等级。

## 配置受保护的验收检查

在 run 开始前，由操作者确定验收代码和执行环境。将真正用于验收的测试、测试配置、辅助脚本纳入 `oracle.protectedPaths`。路径是相对于仓库根的字面文件或目录名，不支持 glob，也不能指向仓库外。

```json
{
  "runChecks": [
    {
      "name": "acceptance",
      "argv": ["python3", "acceptance/check.py"],
      "timeoutMs": 300000,
      "lane": "HEAVY_CHECK",
      "evidenceClass": "BEHAVIORAL",
      "oracle": {
        "protectedPaths": ["acceptance"]
      },
      "isolation": {
        "kind": "DOCKER",
        "image": "sha256:REPLACE_WITH_64_HEX_DIGITS",
        "memoryMb": 2048,
        "cpus": 2
      }
    }
  ]
}
```

示例中的 image 必须替换为已安装镜像的完整 ID，或 `repository@sha256:...`。可用 `docker image inspect --format '{{.Id}}' your-verifier-image` 获取完整 ID。运行检查时固定 `--pull=never`，不会偷偷下载或更新镜像。镜像必须预先包含解释器、测试依赖和检查需要的工具；缺少环境时返回基础设施错误，不回退到可写的本地测试。

`integrationChecks`、`candidateChecks` 支持同样字段。通常 candidate 阶段可用轻量结构检查，集成与最终 run 阶段执行完整验收。

### Oracle 如何冻结

受保护路径的 Git 文件模式、对象 ID、路径清单与不可变的 run input 比较。删除、修改或在受保护目录中新增文件都会使检查失败；缺失的基线 oracle 也会失败。所有原有 `package.json` 的 `scripts` 字段另外被固定，防止将 `npm test` 改为 `true` 而保持相同的 argv。

`checkVersion` 固定命令、超时、lane、有效证据强度、oracle 路径和隔离配置；每次结果另存具体的 `oracleVersion`、源 tree 和环境指纹。字段顺序不会改变 check identity。

要允许 Agent 为新实现添加测试，可将冻结验收目录与可修改的开发测试目录分开。若任务要求修改原有验收标准，应先由有权限的操作者明确新标准并启动新的 run；Agent 不能自行削弱当前合同。对测试配置或依赖脚本的保护必须覆盖真正的验收入口及其辅助代码，不能仅放一个与检查无关的占位文件。

## 检查的源代码身份

每项 final check 使用新的工作树。检查之前与之后都会核对：

1. `HEAD`、index 和指定的不可变 commit/tree。
2. 每个 tracked 文件的实际字节和可执行模式、symlink 内容。
3. inode、ctime、mtime 与文件系统变更事件，用于发现“修改后又恢复原内容”的行为。
4. 未跟踪文件，以及被替换为 symlink 的目录。

本地模式允许被 Git 忽略的构建输出，但禁止将非忽略的新文件当作验收源代码。Docker 模式要求初始源目录没有未跟踪文件，包含被忽略的文件；依赖和临时输出应位于镜像或 `/tmp`，不得偷偷依赖 writer 工作区的缓存。

检查日志写在源工作区之外，按内容 hash 命名，结果引用指定的 tree。检查更改源代码后即使退出码为 0，记录也会失败。

## Docker 检查环境

源代码以只读 bind mount 放在 `/workspace`；检查需要的 Git 元数据也是只读。容器使用只读根文件系统、关闭网络、无附加 capabilities、no-new-privileges、进程数量上限，以及配置的 CPU／内存限制。`/tmp` 可写，`HOME` 与临时目录指向 `/tmp`。主机环境变量和 API key 不会作为容器环境传入。

会修改测试快照、自动修复源码、在源树生成编译结果的命令不能直接作为只读验收命令。关闭这些行为，或让工具把输出写到 `/tmp`。通过复制源码到可写目录再修改并测试该副本，会改变验收对象，不应配置为可信验收入口。

普通结束、超时或取消会清理容器；本地 POSIX 检查还会终止原进程组中的子进程。恢复流程只清理由 TripleTeam 标记、属于本机和当前仓库、已经过期且 owner PID 已死亡的检查容器。其他仓库、活跃 owner 或尚未过期的容器不会被删除；Docker 不可用等清理错误记录在 reconciliation 报告中。

## 边界与回归验证

本地文件监测不是 OS sandbox，因此其证据强度不会升级为行为级。只读 Docker 约束的是检查进程；它并不为宿主机上具有相同权限的恶意进程、被篡改的 Docker daemon 或错误的测试逻辑提供保证。整个系统的 Pi writer 仍按文档中的宿主工具权限执行。

常规验证：

```sh
npm run check
npm test
```

可选的真实 Docker 回归（不调用模型 API，不下载镜像）：

```sh
TRIPLETEAM_TEST_DOCKER_IMAGE=sha256:YOUR_INSTALLED_PYTHON_IMAGE_ID \
  node --import tsx --test test/verification/*.test.ts
```

测试镜像需有 `python3`。回归覆盖默认结构交付、dirty tree 拒绝、修改后恢复、验收文件削弱、npm script 替换、只读执行、检查子进程回收和按仓库隔离的过期容器清理。没有配置测试镜像时，Docker 专项会明确标记 skipped。
