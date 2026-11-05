----------------------------- MODULE FixSafety -----------------------------
(*
 * 抽象状态机：dsh-zipfix 的 ZIP 修复流水线。
 *
 * 真实代码对应关系（详见 spec/README.md）：
 *   lib/fix.js  fixZipArchive       —— 流水线编排：嗅探 → 计划 → 解压 → 重建 → 回读校验
 *   lib/zip.js  extractEntry        —— fs.open('wx') 独占创建 + 流式 CRC32 校验
 *   lib/fix.js  uniqueNestedPath    —— 目标同名时自动加 _fixed 后缀，绝不覆盖
 *   lib/zip.js  writeFixedZip       —— 全部条目 flags = 0x0800（ZIP_UTF8_FLAG）
 *   lib/zip.js  verifyFixedZip      —— 回读 allUtf8Flag 并逐条校验
 *
 * 抽象说明：
 *   - Entries 的每个元素同时充当“条目 id”和“期望的落盘基名”，
 *     因此模型里“目标名”与“条目”共用同一模型值；
 *   - 冲突后缀后的名字抽象为元组 <<e, 1>>（每个条目至多冲突一次）；
 *   - 修复版 ZIP 的文件名用字符串常量 FixedZipName 表示；
 *   - 不建模压缩数据字节、ZIP64、编码嗅探评分等实现细节。
 *
 * 流水线阶段：
 *   "init" → Sniff → "sniff" → Plan* → "plan" → "extract" → "rebuild"
 *          → "verify" → "done"
 * ---------------------------------------------------------------------------
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    \* 待处理条目（2~3 个），cfg 中为模型值集合
    Entries,
    \* 输出目录中“预先存在”的目标文件名（与 Entries 的基名重名者）
    PreExisting,
    \* 名字中含 U+FFFD、字节已销毁的条目
    FffdEntries,
    \* 已通过 ALG-7 GBK→UTF-8 指纹验证的 U+FFFD 条目
    FingerprintOk,
    \* 本次运行是否要求生成修复版 ZIP（--buildFixedZip）
    BuildFixedZip,
    \* 修复版 ZIP 期望文件名在运行前是否已被占用（冲突后缀场景）
    FixedZipTaken

ASSUME PreExisting \subseteq Entries
ASSUME FffdEntries \subseteq Entries
ASSUME FingerprintOk \subseteq FffdEntries

\* 源 ZIP 的内容摘要：整个模型中没有任何动作会改写它。
SourceHash0 == "SRC-ORIGINAL"

\* 目标名域使用统一的整数空间（TLC 指纹要求集合内元素同类型可比较）：
\* 条目基名 = cfg 中给出的整数 1..N；冲突后缀名 = 基名 + SuffixOffset。
SuffixOffset == 10

\* 修复版 ZIP 的期望文件名与冲突后缀名。
FixedZipName == 1000
FixedZipAltName == 1001

\* 运行开始前磁盘上已存在的目标文件集合（安全红线：这些名字永不覆盖）。
InitialDisk == PreExisting \cup (IF FixedZipTaken THEN {FixedZipName} ELSE {})

\* 含 U+FFFD 且未通过指纹验证的条目：禁止自动改名/落盘。
UnverifiedFffd == FffdEntries \ FingerprintOk

VARIABLES
    phase,          \* 当前流水线阶段
    dryRun,         \* true = dry-run，只出计划不写盘
    sourceHash,     \* 源 ZIP 内容摘要（只读）
    disk,           \* 输出目录当前已存在的目标文件名集合
    writes,         \* 本次运行创建/写入过的目标文件名集合
    planned,        \* 已进入计划的条目
    extracted,      \* 已解压落盘的条目
    destOf,         \* 条目 → 实际目标名（关系：集合 of <<entry, name>>）
    included,       \* 被写入修复版 ZIP 的条目
    flagged,        \* 修复版 ZIP 中已置位 0x0800 的条目
    fixedZipBuilt,  \* 修复版 ZIP 是否已生成
    verified        \* 回读校验是否通过

vars == <<phase, dryRun, sourceHash, disk, writes, planned, extracted, destOf,
          included, flagged, fixedZipBuilt, verified>>

\* 写入时目标名的选择：基名被占用则改用加后缀的名字（uniqueNestedPath 的抽象）。
DestFor(e) == IF e \in disk THEN e + SuffixOffset ELSE e

\* 修复版 ZIP 的落盘名：期望名被占用则冲突后缀（uniqueNestedPath 的抽象）。
FixedZipDest == IF FixedZipName \in disk THEN FixedZipAltName ELSE FixedZipName

-----------------------------------------------------------------------------
\* 初始状态
-----------------------------------------------------------------------------
Init ==
    /\ phase = "init"
    /\ dryRun \in BOOLEAN
    /\ sourceHash = SourceHash0
    /\ disk = InitialDisk
    /\ writes = {}
    /\ planned = {}
    /\ extracted = {}
    /\ destOf = {}
    /\ included = {}
    /\ flagged = {}
    /\ fixedZipBuilt = FALSE
    /\ verified = FALSE

-----------------------------------------------------------------------------
\* 动作
-----------------------------------------------------------------------------

\* 嗅探条目名编码（只读源 ZIP）
Sniff ==
    /\ phase = "init"
    /\ phase' = "sniff"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, planned, extracted, destOf,
                   included, flagged, fixedZipBuilt, verified>>

\* 规划一个条目（读多写零；允许跳过某些条目，故为可选子集）
PlanEntry(e) ==
    /\ phase \in {"sniff", "plan"}
    /\ e \in Entries
    /\ e \notin planned
    /\ planned' = planned \cup {e}
    /\ phase' = "plan"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, extracted, destOf,
                   included, flagged, fixedZipBuilt, verified>>

\* 计划完成，进入解压阶段
FinishPlan ==
    /\ phase \in {"sniff", "plan"}
    /\ phase' = "extract"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, planned, extracted, destOf,
                   included, flagged, fixedZipBuilt, verified>>

\* 解压一个条目：
\*   - dry-run 分支只记录计划，不产生任何写操作；
\*   - 写分支以“名字未被占用”为前置条件（extractEntry 的 fs.open 'wx' 独占创建）；
\*   - 含 U+FFFD 且未通过指纹验证的条目一律不得进入写路径。
ExtractEntry(e) ==
    LET dest == DestFor(e) IN
    /\ phase = "extract"
    /\ e \in planned
    /\ e \notin extracted
    /\ e \notin UnverifiedFffd
    /\ extracted' = extracted \cup {e}
    /\ destOf' = destOf \cup {<<e, dest>>}
    /\ IF dryRun
       THEN UNCHANGED <<disk, writes>>
       ELSE (/\ disk' = disk \cup {dest}
             /\ writes' = writes \cup {dest})
    /\ UNCHANGED <<phase, dryRun, sourceHash, planned, included, flagged,
                   fixedZipBuilt, verified>>

\* 解压阶段完成
FinishExtract ==
    /\ phase = "extract"
    /\ phase' = "rebuild"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, planned, extracted, destOf,
                   included, flagged, fixedZipBuilt, verified>>

\* 重建修复版 ZIP：以独占方式创建，全部条目置位 0x0800。
\* dry-run 或未要求 buildFixedZip 时不会走到这里（由 SkipRebuild 处理）。
RebuildFixedZip ==
    /\ phase = "rebuild"
    /\ ~dryRun
    /\ BuildFixedZip
    /\ FixedZipDest \notin disk
    /\ included' = planned
    /\ flagged' = planned
    /\ fixedZipBuilt' = TRUE
    /\ disk' = disk \cup {FixedZipDest}
    /\ writes' = writes \cup {FixedZipDest}
    /\ phase' = "verify"
    /\ UNCHANGED <<dryRun, sourceHash, planned, extracted, destOf, verified>>

\* 不需要（或 dry-run 下不实际执行）重建修复版 ZIP
SkipRebuild ==
    /\ phase = "rebuild"
    /\ (dryRun \/ ~BuildFixedZip)
    /\ phase' = "verify"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, planned, extracted, destOf,
                   included, flagged, fixedZipBuilt, verified>>

\* 回读校验修复版 ZIP：确认全部条目置位 0x0800 后才允许进入完成态。
FlagCheck == fixedZipBuilt => (flagged = included)

VerifyReadBack ==
    /\ phase = "verify"
    /\ verified' = FlagCheck
    /\ phase' = "done"
    /\ UNCHANGED <<dryRun, sourceHash, disk, writes, planned, extracted, destOf,
                   included, flagged, fixedZipBuilt>>

Next ==
    \/ Sniff
    \/ \E e \in Entries : PlanEntry(e)
    \/ FinishPlan
    \/ \E e \in Entries : ExtractEntry(e)
    \/ FinishExtract
    \/ RebuildFixedZip
    \/ SkipRebuild
    \/ VerifyReadBack

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* 不变量（安全红线）
-----------------------------------------------------------------------------

\* SourceIntact：源包摘要保持不变（任何动作都没有改写源 ZIP）。
SourceIntact == sourceHash = SourceHash0

\* NoOverwrite：任何预先存在的目标文件永不被替换。
NoOverwrite == writes \cap InitialDisk = {}

\* DryRunPure：dry-run 状态下不产生任何写操作。
DryRunPure == dryRun => writes = {}

\* NoUfffdGuess：含 U+FFFD 的条目在没有指纹验证通过时不得改名/落盘。
NoUfffdGuess == extracted \cap UnverifiedFffd = {}

\* AllFixedUtf8Flagged：修复版 ZIP 只有在全部条目置位 0x0800 后才进入完成态。
AllFixedUtf8Flagged == (phase = "done" /\ fixedZipBuilt) => (flagged = included)

\* DistinctTargets：一个目标名最多被一个条目占用（独占创建的名字唯一性）。
DestNamesUsed == {p[2] : p \in destOf}
DistinctTargets == Cardinality(DestNamesUsed) = Cardinality(extracted)

\* DoneImpliesVerified：进入完成态前必须完成回读校验。
DoneImpliesVerified == phase = "done" => verified

=============================================================================
