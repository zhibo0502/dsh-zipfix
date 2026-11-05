-------------------------------- MODULE Pairing --------------------------------
(*
 * 抽象状态机：按 (size, CRC32) 与源 ZIP 配对后改名（ALG-6 / ALG-7 的安全契约）。
 *
 * 真实代码对应关系（详见 spec/README.md）：
 *   lib/fix.js  matchSource        —— 源包 (size, CRC32) 桶：0 个/多个命中不猜名字；
 *                                     唯一命中才 rename，改名后复核 size + SHA-256
 *   lib/fix.js  uniqueTargetPath   —— 目标同名时加 _fixed 后缀，绝不覆盖
 *   lib/fix.js  verifyCandidateName—— 候选名 GBK 编码 → UTF-8 替换解码 = 当前乱码指纹
 *   lib/fix.js  verifyNames        —— 只有指纹完全吻合的候选才算“已验证，可安全改名”
 *
 * 抽象说明：
 *   - 每个受损文件 f 与源 ZIP 的 (size, CRC32) 候选关系被抽象为三类集合：
 *       ZeroCandidates（0 个候选）、UniqueCandidates（恰好 1 个）、
 *       AmbiguousCandidates（≥2 个，歧义）；
 *   - 目标名（源条目安全化后的 basename）抽象为 DestNames 中的模型值；
 *   - 指纹验证结果抽象为文件级集合 FingerprintOk；
 *   - 不建模真实 CRC32 计算、大小写/路径分隔符等细节。
 * -----------------------------------------------------------------------------
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Files,                \* 受损目录中的文件
    ZeroCandidates,       \* 源 ZIP 中 (size, CRC32) 候选数为 0 的文件
    UniqueCandidates,     \* 恰好 1 个候选（唯一命中）
    AmbiguousCandidates,  \* ≥2 个候选（歧义，不得猜名字）
    FingerprintOk,        \* 已通过 GBK→UTF-8 指纹比对的文件
    DestNames,            \* 可用的目标名（源条目安全化后的 basename）
    PreTaken              \* 目录中已存在、被预占的文件名

ASSUME ZeroCandidates \subseteq Files
ASSUME UniqueCandidates \subseteq Files
ASSUME AmbiguousCandidates \subseteq Files
ASSUME Files \subseteq ZeroCandidates \cup UniqueCandidates \cup AmbiguousCandidates
ASSUME ZeroCandidates \cap UniqueCandidates = {}
ASSUME ZeroCandidates \cap AmbiguousCandidates = {}
ASSUME UniqueCandidates \cap AmbiguousCandidates = {}
ASSUME FingerprintOk \subseteq Files
ASSUME PreTaken \subseteq DestNames

\* 文件内容摘要：改名不改变内容（真实代码改名前后复核 size + SHA-256）。
ContentHash0 == "SHA-256-ORIGINAL"

VARIABLES
    assigned,     \* 已执行改名的文件集合
    destOf,       \* 文件 → 目标名（关系：集合 of <<file, dest>>）
    occupied,     \* 目录中当前被占用的名字（初始为 PreTaken）
    contentHash   \* 文件内容摘要（只读）

vars == <<assigned, destOf, occupied, contentHash>>

-------------------------------------------------------------------------------
\* 初始状态：尚未改名，目录中只有预先存在的文件。
-------------------------------------------------------------------------------
Init ==
    /\ assigned = {}
    /\ destOf = {}
    /\ occupied = PreTaken
    /\ contentHash = ContentHash0

-------------------------------------------------------------------------------
\* 分配（改名）一个文件：
\*   1) 只有 (size, CRC32) 唯一命中的文件才允许分配（AmbiguousUnassigned）；
\*   2) 必须通过指纹验证（FingerprintRequired）；
\*   3) 目标名必须尚未被占用（Injective / NoPreExistingOverwrite，
\*      对应 uniqueTargetPath 的“绝不覆盖”）。
-------------------------------------------------------------------------------
Assign(f, n) ==
    /\ f \in UniqueCandidates
    /\ f \notin assigned
    /\ f \in FingerprintOk
    /\ n \in DestNames
    /\ n \notin occupied
    /\ assigned' = assigned \cup {f}
    /\ destOf' = destOf \cup {<<f, n>>}
    /\ occupied' = occupied \cup {n}
    /\ UNCHANGED contentHash

Next == \E f \in Files, n \in DestNames : Assign(f, n)

Spec == Init /\ [][Next]_vars

-------------------------------------------------------------------------------
\* 不变量
-------------------------------------------------------------------------------

\* Injective：一个目标名最多被一个文件占用。
OurNames == {p[2] : p \in destOf}
Injective == Cardinality(OurNames) = Cardinality(assigned)

\* AmbiguousUnassigned：歧义（≥2 候选）与零命中（0 候选）的文件不得被分配改名。
AmbiguousUnassigned == assigned \cap (AmbiguousCandidates \cup ZeroCandidates) = {}

\* FingerprintRequired：未通过 GBK→UTF-8 指纹比对的文件不得改名。
FingerprintRequired == assigned \subseteq FingerprintOk

\* NoPreExistingOverwrite：已存在的同名文件永不被覆盖。
NoPreExistingOverwrite == OurNames \cap PreTaken = {}

\* ContentIntact：改名不改变文件内容。
ContentIntact == contentHash = ContentHash0

================================ END MODULE ================================
