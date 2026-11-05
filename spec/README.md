# dsh-zipfix 形式化验证规格（TLA+ / TLC）

本目录用 TLA+ 抽象建模 dsh-zipfix 的两条核心安全契约，并用 TLC 穷尽可达状态检查不变量：

| 规格 | 建模对象 | 真实代码主入口 |
| --- | --- | --- |
| `FixSafety.tla` / `.cfg` | ZIP 修复流水线（嗅探 → 计划 → 解压落盘 → 重建修复版 ZIP → 回读校验）的安全红线 | `dsh-zipfix-plugin/lib/fix.js` → `fixZipArchive()` |
| `Pairing.tla` / `.cfg` | 按 `(size, CRC32)` 与源 ZIP 唯一配对改名 + ALG-7 指纹验证 | `dsh-zipfix-plugin/lib/fix.js` → `matchSource()` / `verifyNames()` |

运行器：`tools/tla-run.mjs`（Node 22+，零 npm 依赖，自动下载并校验 tla2tools.jar）。

---

## 1. `FixSafety`：修复流水线的安全红线

### 1.1 与真实代码的对应关系

| 模型中的阶段/动作 | 真实代码位置 | 说明 |
| --- | --- | --- |
| `Sniff`（"init" → "sniff"） | `fix.js` `fixZipArchive()` 中 `sniffZipEncoding(catalog.entries, { encoding })`（`detect.js`） | 只读解析中央目录，嗅探条目名编码 |
| `PlanEntry` / `FinishPlan`（→ "extract"） | `fix.js` `fixZipArchive()` 的 `plans` 构建循环：`sanitizeEntryName`、`dedupe()`、`detectRedundantRoot` | 只做规划（读多写零），允许跳过条目（如不安全名字/加密/不支持压缩方式） |
| `ExtractEntry`（"extract"） | `fix.js` L786–L830 `if (!dryRun && extract) { ... }`；`zip.js` `extractEntry()` | 目标文件以 `fs.open('wx')` / `createWriteStream(..., { flags: 'wx' })` **独占创建**；流式解压并逐条校验 `uncompressedSize` + CRC32 |
| 冲突后缀 `DestFor` | `fix.js` `uniqueNestedPath()`（L80）/ `uniqueTargetPath()`（L96） | 目标同名时自动追加 `_fixed`、`_fixed_2`…，绝不覆盖 |
| `RebuildFixedZip`（"rebuild"） | `fix.js` L856–L887；`zip.js` `writeFixedZip()` | 以 `fs.openSync(destPath, 'wx')` 独占创建修复版 ZIP；**所有条目 `flags = ZIP_UTF8_FLAG (0x0800)`**，UTF-8 编码文件名，逐条回填本地文件头 |
| `SkipRebuild` | `fix.js` `if (!dryRun && buildFixedZip)` 的否定分支 | dry-run 或未要求 `buildFixedZip` 时不生成修复版 ZIP，只记录计划 |
| `VerifyReadBack`（"verify" → "done"） | `fix.js` L870 `verifyFixedZip()`；`zip.js` `verifyFixedZip()` | 回读 `allUtf8Flag = entries.every(flags & 0x0800)`，并逐条校验 CRC32 |
| `dryRun` 分支 | `fix.js` L831 `else if (dryRun)`、L843 dry-run 下的修复版 ZIP 计划行 | dry-run 只产出报告行，不建目录、不解压、不写 ZIP、不写报告文件 |
| 源 ZIP 只读 | `zip.js` `ZipCatalog` 仅 `fs.openSync(zipPath, 'r')`；`fix.js` 全部写操作另有目标路径 | 源 ZIP 以只读句柄打开，模型抽象为 `sourceHash` 常量 |

### 1.2 状态机

```
init ──Sniff──▶ sniff ──PlanEntry*──▶ plan ──FinishPlan──▶ extract
     ──ExtractEntry*（可跳过条目）──▶ rebuild
     ──RebuildFixedZip 或 SkipRebuild──▶ verify ──VerifyReadBack──▶ done
```

- `ExtractEntry` 在 `dryRun = TRUE` 时只记录 `extracted`/`destOf`，**不修改** `disk`/`writes`（对应代码里 dry-run 只出计划行）。
- `RebuildFixedZip` 仅在 `~dryRun ∧ BuildFixedZip` 时使能；它把 `planned` 全部条目写入修复版 ZIP，并给每个条目置位 0x0800（`flagged = planned`）。
- `VerifyReadBack` 只在回读确认 `flagged = included` 后才把 `phase` 置为 `"done"`。
- 终态 `"done"` 之后没有使能动作，属于合法停止；cfg 中 `CHECK_DEADLOCK FALSE` 避免把流水线终态误报为死锁。

### 1.3 常量与抽象值域

TLC 的 config 解析器不支持元组/函数常量，且 TLC 指纹要求同一集合内元素类型统一可比较。因此模型采用**统一整数名字空间**：

| 抽象 | 值域 | 含义 |
| --- | --- | --- |
| 条目 / 目标基名 | `1, 2, 3` | 每个整数同时是条目 id 和它的期望落盘基名 |
| 冲突后缀名 | `e + 10`（11、12、13） | `uniqueNestedPath` 追加 `_fixed` 后的名字 |
| 修复版 ZIP 期望名 / 冲突后缀名 | `1000` / `1001` | 修复版 ZIP 的落盘名 |

`FixSafety.cfg` 的常量：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `Entries` | `{1, 2, 3}` | 3 个条目 |
| `PreExisting` | `{2}` | 输出目录里已存在目标名 `2`（触发冲突后缀路径） |
| `FffdEntries` | `{3}` | 名字含 U+FFFD、字节已销毁的条目 |
| `FingerprintOk` | `{}` | 没有 U+FFFD 条目通过 ALG-7 指纹验证 |
| `BuildFixedZip` | `TRUE` | 本次运行要求生成修复版 ZIP |
| `FixedZipTaken` | `TRUE` | 修复版 ZIP 期望名已被占用（触发 `uniqueNestedPath` 冲突后缀） |

### 1.4 变量（抽象含义）

| 变量 | 含义 | 对应真实状态 |
| --- | --- | --- |
| `phase` | 流水线阶段 | 函数内执行到的代码段 |
| `dryRun` | 是否 dry-run（初始非确定选择，覆盖两种模式） | `options.dryRun` |
| `sourceHash` | 源 ZIP 内容摘要，只读 | 源 ZIP 文件字节 |
| `disk` | 输出目录当前已存在的目标名集合 | 输出目录文件系统状态 |
| `writes` | 本次运行写入过的目标名集合 | 所有落盘写操作 |
| `planned` | 进入计划的条目 | `plans` 数组元素 |
| `extracted` | 已解压落盘的条目 | `applied.extractedFiles` 对应条目 |
| `destOf` | 条目 → 实际目标名关系 | 各条目的最终落盘路径 |
| `included` | 进入修复版 ZIP 的条目 | `plans.map(p => ({entry, name}))` |
| `flagged` | 修复版 ZIP 中置位 0x0800 的条目 | `verifyFixedZip().allUtf8Flag` 的逐条依据 |
| `fixedZipBuilt` | 修复版 ZIP 是否已生成 | `applied.fixedZipPath !== null` |
| `verified` | 回读校验是否通过 | `applied.fixedZip.allUtf8Flag` 等 |

### 1.5 不变量清单

| 不变量 | 语义 | 真实代码依据 |
| --- | --- | --- |
| `SourceIntact` | `sourceHash = SourceHash0`：源包摘要永不变 | 源 ZIP 只以 `'r'` 打开；所有写操作指向新目标 |
| `NoOverwrite` | `writes ∩ InitialDisk = {}`：任何预先存在的目标文件永不被替换 | `extractEntry` 的 `'wx'` 独占创建；`writeFixedZip` 的 `fs.openSync(destPath,'wx')`；`uniqueNestedPath` 冲突后缀 |
| `DryRunPure` | `dryRun ⇒ writes = {}`：dry-run 不产生任何写操作 | `if (!dryRun && extract)` / `if (!dryRun && buildFixedZip)` / `if (!dryRun)` 才写报告 |
| `NoUfffdGuess` | 含 U+FFFD 且未通过指纹验证的条目不得改名/落盘 | `verifyNames` 明确“无一通过指纹验证 → 不得擅自改名”；U+FFFD 条目交给 `matchSource` / `verifyNames` 人工路径 |
| `AllFixedUtf8Flagged` | 修复版 ZIP 只有在全部条目置位 0x0800 后才进入完成态 | `writeFixedZip` 对本地头/中央目录恒写 `ZIP_UTF8_FLAG`；`verifyFixedZip` 回读 `allUtf8Flag` 后才报告成功 |
| `DistinctTargets`（附加） | 一个目标名最多被一个条目占用 | 独占创建 + 冲突后缀保证名字唯一 |
| `DoneImpliesVerified`（附加） | 进入完成态前必须完成回读校验 | 只有 `VerifyReadBack` 能把 `phase` 置为 `"done"` |

`AllFixedUtf8Flagged` 由 `RebuildFixedZip`（`flagged' = planned`）与 `VerifyReadBack`（`FlagCheck`）的守卫共同保证；TLC 校验所有可达状态（包括不同 `dryRun`、计划子集、解压顺序、冲突路径）均满足。

---

## 2. `Pairing`：`(size, CRC32)` 配对改名 + 指纹验证

### 2.1 与真实代码的对应关系

| 模型 | 真实代码位置 | 说明 |
| --- | --- | --- |
| `ZeroCandidates` | `fix.js` `matchSource()`：`bucket.length === 0` → `unmatched` | 源 ZIP 中找不到 `(size, CRC32)` 条目 → 不动 |
| `AmbiguousCandidates` | `matchSource()`：`bucket.length > 1` → “不猜名字，请人工确认” | 歧义（≥2 命中）→ 不动 |
| `UniqueCandidates` | `matchSource()`：`bucket.length === 1` 且 `sanitizeEntryName(name).safe` | 唯一命中才允许改名 |
| `FingerprintOk` | `fix.js` `verifyCandidateName()` / `verifyNames()`：候选名 `GBK 编码 → UTF-8 替换解码` 必须与当前乱码名完全一致（或折叠 U+FFFD 连续段后一致） | 未通过指纹不得改名 |
| `Assign` 中的目标名互斥 | `fix.js` `uniqueTargetPath()` | 独占创建 + 冲突后缀，绝不覆盖 |
| `contentHash` | `matchSource()` 改名后复核 `size` + `SHA-256` | 改名不改变内容 |

> 说明：真实代码中 `matchSource` 以唯一 `(size, CRC32)` + 事后 SHA-256 复核授权改名，`verifyNames` 以指纹验证授权改名。本模型把两条路径合并为更强契约：**唯一命中 ∧ 指纹通过才允许改名**，便于同时验证两类风险。

### 2.2 常量与抽象值域

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `Files` | `{1, 2, 3, 4, 5}` | 受损目录中的 5 个文件 |
| `ZeroCandidates` | `{4}` | 0 个 `(size, CRC32)` 候选 |
| `UniqueCandidates` | `{1, 2, 5}` | 恰好 1 个候选 |
| `AmbiguousCandidates` | `{3}` | ≥2 个候选（歧义） |
| `FingerprintOk` | `{1, 2}` | 通过 GBK→UTF-8 指纹比对的文件（`5` 唯一命中但指纹未通过，应被阻止） |
| `DestNames` | `{101, 102, 103}` | 可用目标名（真实代码中是源条目安全化后的 basename） |
| `PreTaken` | `{101}` | 目录中已存在的名字（预占） |

候选关系被抽象为「每个文件属于哪一类候选集合」，不建模真实 CRC32 数值。

### 2.3 变量

| 变量 | 含义 |
| --- | --- |
| `assigned` | 已执行改名的文件集合 |
| `destOf` | 文件 → 目标名关系（集合 of `<<file, dest>>`） |
| `occupied` | 目录中当前被占用的名字（初始为 `PreTaken`） |
| `contentHash` | 文件内容摘要（只读，改名不改变内容） |

### 2.4 不变量清单

| 不变量 | 语义 | 真实代码依据 |
| --- | --- | --- |
| `Injective` | 一个目标名最多被一个文件占用 | `uniqueTargetPath` 生成唯一名字；文件系统独占创建 |
| `AmbiguousUnassigned` | 歧义（≥2 候选）与零命中（0 候选）的文件不得被分配改名 | `matchSource` 对 `bucket.length !== 1` 一律不猜名字 |
| `FingerprintRequired` | 未通过 GBK→UTF-8 指纹比对的文件不得改名 | `verifyNames`：“没有任何候选通过指纹验证……不得擅自改名” |
| `NoPreExistingOverwrite`（附加） | 已存在的同名文件永不被覆盖 | `uniqueTargetPath` / `'wx'` 独占创建 |
| `ContentIntact`（附加） | 改名不改变文件内容 | 改名后复核 `size` + `SHA-256` |

---

## 3. 运行方式

前置：Node 22+；Java 21+（或通过 `TLA_JAVA` 指定便携版 JRE）。`tools/tla-run.mjs` 会在缺少 jar 时自动下载固定版本 `tla2tools.jar v1.7.1` 到系统临时目录并做 SHA-256 校验。

```powershell
# 运行 spec/ 下全部规格
node tools/tla-run.mjs

# 只运行某个规格
node tools/tla-run.mjs --spec FixSafety
node tools/tla-run.mjs --spec Pairing

# 只列出发现的规格
node tools/tla-run.mjs --list
```

环境变量（均可选）：

| 变量 | 作用 |
| --- | --- |
| `TLA_JAVA` | java 可执行文件路径；未设置则使用 PATH 中的 `java` |
| `TLA2TOOLS_JAR` | tla2tools.jar 路径；未设置则自动下载 `v1.7.1` 到 `os.tmpdir()` 并校验 SHA-256（`d532ba31…52da5`） |

本机没有 Java 时（本次验证环境的做法）：

```powershell
Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse" -OutFile "$env:TEMP\temurin-jre.zip"
Expand-Archive "$env:TEMP\temurin-jre.zip" -DestinationPath "$env:TEMP\temurin-jre"
$env:TLA_JAVA = (Get-ChildItem "$env:TEMP\temurin-jre" -Recurse -Filter java.exe | Select-Object -First 1).FullName
node tools/tla-run.mjs
```

手动等价命令（工作目录 `spec/`；`-metadir` 把 TLC 元数据重定向到临时目录，避免在仓库中产生 `states/` 目录）：

```
java -cp <tla2tools.jar> tlc2.TLC -metadir %TEMP%\tlc-meta\FixSafety -config FixSafety.cfg FixSafety.tla
java -cp <tla2tools.jar> tlc2.TLC -metadir %TEMP%\tlc-meta\Pairing   -config Pairing.cfg   Pairing.tla
```

成功判据：退出码 0 且输出包含 `Model checking completed. No error has been found.`

---

## 4. 本机验证结果

验证环境：Windows x64、Node v25.9.0、Temurin JRE 21.0.13、TLC2 v2.16（tla2tools v1.7.1，SHA-256 校验通过）。

| 规格 | generated states | distinct states | diameter | 结果 |
| --- | --- | --- | --- | --- |
| `FixSafety` | 176 | 162 | 11 | `Model checking completed. No error has been found.` |
| `Pairing` | 9 | 7 | 3 | `Model checking completed. No error has been found.` |

`node tools/tla-run.mjs` 退出码 0。

## 5. 反向验证（证明 TLC 确实在检查，而非空转）

两次临时破坏（验证后均已恢复，仓库未保留任何破坏版本）：

1. **`NoOverwrite`**：把 `FixSafety.tla` 的 `DestFor(e)` 从“基名占用则 `e + SuffixOffset`”改成直接返回 `e`（等价于去掉冲突后缀/覆盖保护）：
   - 结果：`node tools/tla-run.mjs --spec FixSafety` 退出码 **1**，TLC 报 `Error: Invariant NoOverwrite is violated.`
   - 反例轨迹（State 5）：`planned = {2}`、`extracted = {2}`、`writes = {2}`，而 `disk` 此前已含预占的 `2` → 证明覆盖了已存在的目标。
2. **`FingerprintRequired`**：把 `Pairing.tla` `Assign` 中的 `f \in FingerprintOk` 守卫删除：
   - 结果：`node tools/tla-run.mjs --spec Pairing` 退出码 **1**，TLC 报 `Error: Invariant FingerprintRequired is violated.`
   - 反例轨迹（State 2）：`assigned = {5}`（文件 5 唯一命中但未通过指纹）→ 证明模型会拦住无指纹改名。

恢复后重新运行 `node tools/tla-run.mjs` 全绿（见 §4）。

---

## 6. 模型边界与未覆盖风险

模型是对真实实现的**有损抽象**，证明的是“抽象契约成立”，不是“JS 代码逐行正确”。以下真实复杂点未建模：

1. **字节级格式细节**：压缩数据流、ZIP64 / EOCD64、数据描述符、CRC32 算法、目录项压缩方式、编码嗅探评分（`sniffZipEncoding` 的启发式）均被抽象为布尔/集合分类。
2. **异常与 IO 失败**：磁盘满、权限拒绝、中断（`AbortSignal`）、部分写入后的清理（`extractEntry` 失败时 `rm(outPath)`）、TLC 不建模的错误分支。真实代码在这些路径上可能留下半成品或提前返回，安全性质需要另外的错误注入测试覆盖。
3. **U+FFFD 处理策略差异**：`FixSafety` 按任务要求采用**更严格**的契约——“未通过指纹验证的 U+FFFD 条目不得改名/落盘”；真实 `fixZipArchive` 仍会以替换字符名解压这类条目（有损但非猜测），并把 `status` 标为 `mixed`/`irreversible`、引导用户改用 `matchSource` / `verifyNames`。模型的意图是验证“自动写路径不会猜测”，对“以有损名落盘”这一现状没有建模；该差异是**保守方向**的（模型比代码更严）。
4. **命名策略**：真实 `uniqueNestedPath` / `uniqueTargetPath` 支持 `_fixed`、`_fixed_2`… 多级后缀与目录合并；模型只保留“目标名必须唯一且不得占用预存在名字”，后缀的具体挑选顺序（`_fixed_2` 等）未建模。
5. **文件名校验**：`sanitizeEntryName` 的路径穿越、绝对路径、Windows 保留名、非法字符等检查未建模；模型假定进入写路径的名字已安全化。
6. **修复版 ZIP 的“全量校验”降级**：真实代码在总体积 > 512 MiB 时跳过逐条解压校验（`full = totalUncompressed <= 512MB`）；模型把回读校验抽象为“全部条目置位 0x0800 即通过”，未建模体积阈值分支。
7. **Pairing 的候选抽象**：真实 `(size, CRC32)` 是数值键、桶按精确值匹配；模型只保留桶大小分类（0 / 1 / ≥2），不建模“两个不同键碰撞”或哈希碰撞。
8. **并发**：真实工具是单进程顺序执行；未建模多进程并发写同一目录的竞争（`'wx'` 在并发场景下的正确性依赖操作系统独占语义）。
9. **TLA+ 配置值域限制**：TLC config 解析器不支持元组/函数常量，且指纹要求同集合元素类型统一，故名字域使用整数；这不改变安全不变量的语义，但会限制“名字”的可读性。
10. **`Spec` 未加公平性（fairness）**：本验证只检查安全性（不变量），不检查活性（liveness：例如“最终一定会完成”）。
