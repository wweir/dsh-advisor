# 全仓评审 2026-10-19

本轮把 `dsh-advisor` 的全部源码（`src/` 22 个文件、`client/index.js`、17 个测试文件、
仓库元数据）逐文件过了一遍，修掉确认的缺陷，并独立复核了修复本身。本文是这轮工作的
短期记录：每条 finding 带 file:line 证据与最终处置；已排除项带理由；遗留项写清楚为什么
留。

## 范围与方法

- 只读评审按文件组分成 7 个评审员（`src` 根层与 host 基础层、review/prompt/catalog、
  subscription/delivery/status、安全与策略边界、advice/state/overrides/stats、
  Web client 与打包元数据、测试有效性）。每个评审员读全文、给 `file:line` 证据、带工具
  预算，且**禁止修改任何文件**。
- 评审员产出只作证据。每条 finding 由 lead 回到源码逐条复核（读被引用行、必要时读上游
  `.d.ts`/`lib` 确认 API 语义），确认属实才落改。
- 修复由 lead 落地；随后派独立复核员（`verify-fixes`）对修复本身做反向验证并实跑门禁。
- 评审期间的基线：`pnpm run typecheck` 通过、`pnpm run test` 17 文件 / 193 测试通过。

## 结论摘要

- 评审共提出 42 条 finding；下列 22 条经 lead 回源复核确认属实并已修。
- 本轮**已修 22 条**（1 blocker + 15 concern + 6 nit），另加强/新增 9 组测试断言，
  同步 3 处文档断言。其余 finding 在复核后判为不成立、已文档化或属测试卫生问题
  （见「已排除」与「遗留」）。
- **遗留 8 项**（见文末），其中 4 项是有意不修并说明原因，4 项是覆盖缺口。
- 落改后门禁：`pnpm run verify`（typecheck + 200 tests + tsc build）通过；测试数从 193
  升到 200。

## 已修 findings

### 1. [blocker] follow-up 的「模型回复」确认没有绑定到它自己那一轮

`src/state.ts:336` 的 `noteModelOutput()` 原先不带 turn 参数，任何一次非 `interrupted`
的 assistant 回复都会确认 claim。claim 只有在本插件的 follow-up 真的开出一轮时才会
绑定 turn（`src/state.ts:314-321` 的 `noteTurnStart`），所以当 host 接受了 `followup()`
却从未开出 turn 时，claim 会一直挂着，然后被用户下一轮的回复确认：笔记进 dedupe、
出 pending，永不重投——与 README 承诺的「an unconfirmed note is requeued, never silently
dropped」直接矛盾。

修复：`noteModelOutput(turnNumber)` 只在 `claimTurn === turnNumber` 时确认；调用面
`src/host/subscription.ts:209` 传 `event.data.turn`。测试：`tests/runtime-delivery.test.ts`
新增「无关轮次的回复不得确认 claim」用例。

### 2. [concern] 同一 finding 可能被投递两次

`src/state.ts` 的 `drainPending` 原先只查 mute 与 dispatch 闸门，不查 dedupe。第二次
review 在 claim 未确认的窗口里重新发现同一 key 时会正常入队（此时 dedupe 表里还没有
它），随后 claim 被确认，那条 pending 仍会被 `steer` 出去。

修复：交付前用**同一个** dedupe 策略重新判定，`suppress` 时 `deleteIf` 删除并不投递；
策略抽成 `DEDUPE_POLICY` 常量，与入队时的判定共用（`src/state.ts:63`、`src/state.ts:642`）。

### 3. [concern] review 正常完成却被记成 timeout 失败

`src/host/review.ts` 原先在 `Promise.race` 之后直接判 `deadline.aborted`。当 `whenIdle()`
先 resolve、deadline 在同一微任务批次里 abort 时，race 的赢家是 `whenIdle`，但
`deadline.aborted` 已为真：一个 silent 完成的 review 被记成 `failed: review timed out`，
推进 `failureStreak`，三次即暂停自动评审。

修复：deadline 的 abort 监听器置 `deadlineWon`，只有它真正赢得 race 时才报超时
（`src/host/review.ts:274`、`:359`、`:392`），且该判断仍在 owner-cancel 与已记录 finding
之后（原优先级不变）。

### 4. [concern] 安全策略在 Linux 上不折叠大小写

`src/policy/security.ts` 的 `comparePath` 只在 `win32`/`darwin` 折叠大小写，而名字、
扩展名、目录名规则用的是原始 `fileName`/`parts`。实测（本机 Linux）`.ENV`、`server.PEM`、
`ID_RSA`、`Credentials.JSON`、`.Netrc`、`secrets.KEY` 全部 ALLOW——同一个秘密换个拼写就
能读到。

修复：名字/扩展名/目录名规则无条件 `toLowerCase()` 后比较（`src/policy/security.ts:135`、`:141`），
路径级比较行为不变。实测 `.ENV`/`Server.PEM`/`ID_RSA`/`Credentials.JSON`/`.Netrc`/`secrets.KEY`/
`.SSH/config` 全部 DENY，而 `id_generator.ts`、`.environment.md`、`Identity.ts` 仍 ALLOW。

### 5. [concern] 凭据脱敏漏掉 CLI 写法

`src/policy/redaction.ts` 的 inline 模式 lookbehind 是 `(?<![A-Za-z0-9_-])`，`-` 被排除，
于是最常见的 `--password=hunter2` 完全不被匹配（实测 0 命中）。

修复：lookbehind 放宽到 `(?<![A-Za-z0-9_])`（`src/policy/redaction.ts:44-52`）。实测
`--password=hunter2`、`mysql -u root --password=hunter2 db`、`--api-key=abc123` 均被脱敏，
而 `monkey=banana`、`publicKey=zzz` 不误伤（关键字自身的 `[A-Za-z0-9]+` 前缀会吃掉尾巴）。

### 6. [concern] 不可读的配置 override 会被下一次保存覆盖

`src/host/config-store.ts` 的类注释承诺「unreadable 不会被静默替换」，但 `save()` 没有任何
前置检查：文件因版本不符、JSON 截断或手改坏而不可读时，页面上第一次保存就把它整个换成
新的全量投影。侧车有这道闸（`restored=false` 时 `persist` 直接 return），配置文件没有。

修复：`load()` 在不可读分支 latch `loadFailed`，`save()` 抛错拒绝覆盖
（`src/host/config-store.ts:43`、`:75-76`、`:88-91`）。同一处把版本比较改用
`ADVISOR_CONFIG_VERSION`，删掉本地重复的 `CONFIG_VERSION`（同一事实原本有两个来源）。

### 7. [concern] `enabled && !model` 的不变式可被 override 绕过

`src/index.ts` 原先在合并 override **之前**校验 row 配置。持久化的 override 层可以只写
`{"enabled": true}`（`parseConfigPatch` 只校验字段形状，不校验两者的组合），得到
`effective.enabled === true && model === undefined`：`shouldReview` 永久返回 false，
不评审也不报错——正是那句注释「must be loud rather than a permanently inert row」要避免的
状态。

修复：校验移到合并之后，判 `effective`（`src/index.ts:133-136`）。

### 8. [concern] 路由 dispose 串行 await，前一个 reject 会吞掉后一个

`src/index.ts` 的 disposer 里 `await catalogRoute.dispose(); await statusRoute.dispose();`，
前者 reject 时 `/advisor/status` 不会被注销；fiber 重跑时对同一路径重复注册会抛错
（注释自己写了「duplicate registration throws inside the fiber」），页面与状态面一起消失。

修复：`await Promise.allSettled([catalogRoute.dispose(), statusRoute.dispose()])`
（`src/index.ts:190`）。

### 9. [concern] reviewer claim 与 fiber 生命周期错配，且释放不区分持有者

进程级 claim 是布尔量，disposer 无条件置 false。多 fiber 行里非 owner 分支静默 return；
任一卸载顺序（owner 先卸载，或热重载时新 fiber 先 apply、旧 fiber 的 disposer 后跑）都会
留下「flag 为 false 但没有存活的 owner」，直到下次 reload 都不评审、也没有页面路由，且
无任何日志。

修复：claim 改为 token（`claimReviewer(): symbol | undefined`），`releaseReviewer(token)`
只释放自己持有的那个；非 owner 分支写一条 warn（`src/index.ts:99-116`、`:138-146`）。

### 10. [concern] 页面路由拒绝 session store 自己铸造的 id

`src/host/status-route.ts` 的 `SESSION_ID` 要求 `session-` 之后至少 8 个字符，而 session
store 铸造的是 `session-1`（自增计数器）：`/api/advisor/status`、`/api/advisor/context`
对这类会话一律 400，Advisor tab 表现为「没状态」。该形状检查不提供安全收益（id 只用于
`ctx.agents.get(SessionId(id))` 与 Map 查找，不参与路径拼接）。

修复：去掉长度下限（`src/host/status-route.ts:55-62`），并补两条测试：`session-1` 返回
200，`../../etc/passwd` 与空串返回 400（`tests/status.test.ts`）。

### 11. [concern] 页面配置的数组字段无上界

`parseConfigPatch` 对 `delivery.activeIdleSeverities` 只校验元素、不校验长度（实测接受
20 000 项），而这段数组会被持久化并在每次状态轮询里重新渲染——正是 `LIMITS` 注释写明要
避免的情况。

修复：长度上界取词表大小并去重（`src/policy/overrides.ts:167-186` 附近，上界判断在 `:173`）。

### 12. [concern] 行配置超出页面上界时会写出读不回来的 override

`toConfigPatch` 原样拷贝行值，而 `parseConfigPatch` 对同样的字段强制 `LIMITS`；行 schema
只有下界。行里写 `instructions` 长度 > 20 000 之后，页面只要保存一次就会写出一个下次加载
被判 invalid 的文件，整层 override（包括页面刚存的东西）被丢弃，日志只说 unreadable。

修复：新增 `canPersistConfigPatch(config)`（`src/policy/overrides.ts:249-260`），
`SessionObserver.configure()` 在保存前自检，不可持久化时抛错——调用方（状态路由）会把它
作为 500 报出来，而不是留下一个读不回来的文件（`src/host/subscription.ts:354-360`）。

### 13. [concern] 目录投影的顶层调用在 try 之外

`src/host/catalog.ts` 只把逐 provider、逐 model 的调用包在 try 里，`llm.listProviders()`
裸奔；registry 自身抛错时整条路由 reject，前端两个下拉全空且不是稳定 JSON 形状。

修复：把 `listProviders()` 包进 try，失败时 `logWarn` 并返回空列表（路由仍 200）
（`src/host/catalog.ts:106-118`）。

### 14. [concern] 超时/取消路径丢掉 usage

`src/host/review.ts` 的 catch 分支不返回 usage，而 `src/port.ts:21-22` 的契约是「只有从未
到达模型的 review 才没有 usage」。子会话已经跑起来之后再抛错（例如 `whenIdle()` 拒绝），
这次 review 的 token/时长在统计里完全消失。

修复：catch 里 `handle !== undefined` 时用同一个 `foldReviewUsage(...)` 组出 usage 并带上
（`src/host/review.ts:419-428`）。

### 15. [concern] 持久化 advice 的 usage 用未类型化字符串键累加

`foldReviewUsage` 原先 `(event.data as { usage?: unknown })` 后逐个字符串键探测，上游字段
改名只会静默变成 0，编译期发现不了。

修复：改用 `@deepseek-ai/dsh-llm` 的 `TokenUsage` 类型（已核对上游
`lib/types/types.d.ts:160-172` 与 `dsh-session` 的 `assistant/message` 事件确实携带它）。

### 16. [concern] 不可信投影没有边界，也没有「不是指令」的反向声明

`src/host/prompt.ts` 的 composed text 原先只把投影拼在 `"\n\nRecent Executor work:\n"`
之后，`REVIEW_INSTRUCTIONS` 也没有声明后文是证据而非指令。投影内容来自工具输出、文件
正文、模型自己的话，是可伪造的文本；产出的 advice 会被投递回 Executor 主对话，构成二阶
注入面。

修复：`REVIEW_INSTRUCTIONS` 增加一段明确声明（`src/host/prompt.ts:20-28`），并用
`EVIDENCE_OPEN/EVIDENCE_CLOSE` 围栏包住投影、把围栏计入 token overhead
（`src/host/prompt.ts:49-51`、`:99-118`）。测试同步更新（`tests/prompt.test.ts`）。

### 17. [nit] `DSH_HOME` 原样使用

`~` 会创建字面 `~` 目录，相对路径让 `advisor/` 落在进程 cwd 下，症状是「状态莫名其妙
不回来」而不是报错。

修复：`resolveAdvisorStateRoot()` 现在 resolve（`~`、`~/x`、相对路径）（`src/host/paths.ts:18-34`）。

### 18. [nit] 打包元数据缺运行期 peer

`@deepseek-ai/dsh-atomic-write` 被 `src/host/config-store.ts` 与 `src/host/sidecar.ts` 运行期
import，却只声明在 `devDependencies`：装进 profile 时 DSH 的 peer 守卫不会校验它，缺依赖
就是 MODULE_NOT_FOUND。

修复：补进 `peerDependencies`（`package.json:64`，dev 侧仍是 `:76`）。

### 19. [nit] Web client 的数值字段只有下界

四个数字输入只有 `min:1`，`save()` 也只校验下界；超上界只能吃 host 的 400 并原样显示
英文 host 文案（同一条路径的下界错误却是本地化中文）。

修复：补 `max`（与 host `LIMITS` 一致），`save()` 校验上下界（`client/index.js:831-835`、
`:736-745`）。

### 20. [nit] 累计行与文档不一致

README 写「omits zero counts」，实现里 `followUps` 无条件渲染（空队列也会画 `Follow-ups 0`）。

修复：`queueMeta` 在无内容时返回 `null`，不再画任何行；`followUpsUsed > 0` 或宿主上报了
cap 时才显示 followup 计数（`client/index.js:340-352`）。README 同步。

### 21. [nit] 页签隐藏期间只能等下一个轮询周期

`setInterval` 在隐藏时跳过 tick，切回页签后最长 5 秒仍是旧状态——而这块 UI 的用途正是
「为什么队列不动」的即时诊断。

修复：加 `visibilitychange` 立即 tick，并在 disposer 里移除监听（`client/index.js:516-523`）。

### 22. [nit] 文档与代码矛盾（3 处）

- `README.md`：「reloading it (config change or restart) clears the tripwire」——页面保存
  走 `configure()` → `applyConfig`，不碰 `paused`；清 pause 只发生在 `restore`。改为
  「插件重载（配置行变更或进程重启）清除，页面保存不自解」。
- `README.md`：「validated against the same bounds」——loader schema 只有下界，页面侧更严。
  改为明确的「比 loader schema 更严的页面上界」。
- `docs/DECISIONS.md`：写「blocks workspace-root private keys (`id_*`)」，代码与测试只挡
  6 个精确名（有意的取舍，`id_*` 会误伤 `id_generator.ts`）。按代码改文档，并注明大小写
  不敏感。

## 已排除（评审提出，复核后判为不成立 / 已文档化）

- **`status-route` 的认证与 CSRF**：`dsh-client-connection` 的 `admit()` 施加 Host/Origin
  围栏与浏览器 cookie，分发处 `peer.principal.kind !== 'owner' → 403`。config 路由未校验
  content-type 不构成 CSRF 面。
- **sessionId 路径穿越**：`encodeURIComponent` 不转义 `.`，但 `%2F` 不是路径分隔符，join
  之后仍在目录内。
- **prototype pollution**：`parseConfigPatch` 逐层白名单拒绝未知键（含 JSON.parse 出来的
  `__proto__`），`applyConfigPatch` 只合并解析器构造的字段；`security` 被显式拒绝。
- **符号链接绕过受保护路径**：候选路径来自 host 的 `ctx.fs.resolve`（已 realpath），配置项
  自身也走 `canonicalize`。
- **`..`、相对路径、Windows 分隔符、Unicode/NFKC**：策略只判 host 已解析的绝对路径；全角
  `.ｅｎｖ` 是另一个文件名，判定的与工具打开的是同一字节序列。
- **ReDoS**：各正则量词互斥，无嵌套同类量词；`bound()` 先脱敏后截断。
- **只读工具面被 preset 覆盖**：运行时是 allow-list（`readOnlyTools.has(exec.name)` 否则
  deny），`selectReviewReadOnlyTools` 精确名匹配，`bash`/`write`/MCP 读工具进不来。
- **「search 工具能从子目录搜到受保护文件正文」**：README「Known limits」已文档化，且
  search 结果走二次脱敏。
- **sidecar/config 的原子性**：`writeFileAtomic` + `withFileLock` + 每会话写链。
- **`settleReviewOutcome` 语义、监听器与子会话清理**：与 `review.ts` 实现一致，abort
  监听器 `{once:true}` 且在 finally 显式移除，子会话在 finally cancel+dispose。
- **`stats` 除零 / `padStart(16)` 溢出 / 容量淘汰 / bigint 往返**：逐项核对，正确。
- **`BoundedKeyedFifo.peek()/shift()` 无 `src` 调用**：被 `tests/delivery.test.ts` 驱动，
  不算死代码。
- **测试套件整体有效性**：193 个 `it()` 分块统计无空断言测试；无假计时器/真实时间混用；
  无跨用例顺序依赖（唯一模块级状态是不可变输入的 home 缓存）。
- **host I/O 模块未测**（sidecar/config-store/subscription）：按 AGENTS.md 第 7/10 条属
  允许范围。

## 遗留与已知限制

1. **`noteModelOutput` 修复后的 awaiting 残留**（有意不修）：host 接受 follow-up 但从未
   开出 turn 时，声明会停留在 awaiting，直到下次插件重载才回收（README 已文档化）。lead
   没有在 `noteInstructionInput` 里主动撤回 claim：那会改变「用户插话」路径的语义，且
   缺乏测试支撑，改动面大于收益。
2. **超时竞态的修复没有自动化测试**：`deadlineWon` 的判定需要真实子会话与精确的同 tick
   时序，现只有代码内注释与推理；`tests/review-outcome.test.ts` 覆盖的是 outcome 归一化，
   不是这段竞态。
3. **`AdvisorStatus`/`ReviewRecord` 的字段级前后端核对未做完**：评审只核对了顶层 23 个
   字段与路由契约，stats/recentReviews 的内部字段未逐条比对。
4. **`tests/read-only-tools.test.ts` 的恒真断言、`tests/stats.test.ts` 的 fixture 回显**
   （`truncated`/尺寸断言等于回显测试自造的值）**未修**：前者删一行即可，后者需要把
   fixture 换成真实 `composeReviewPrompt` 产出；两者都不会让缺陷逃逸，属测试卫生问题。
5. **缺两个高价值运行时用例**：`newerInstructionInput` 与 `reviewFollowUpCapExhausted`
   两个投递闸门只有纯函数覆盖，生产接线（`state.ts` 与 `subscription.ts` 的调用点）没有
   runtime 用例驱动；`followUpsUsed` 推到 cap 之后的行为也没有用例。
6. **没有真机端到端验证**：本轮是静态评审 + 单测门禁 + 定向探针（security/redaction 的
   case-folding、脱敏、canonical home、围栏、queueMeta 分支），没有跑长驻 `dsh web` 与真实
   模型路由的完整链路。评审员报告里引用上游行为时读的是 `node_modules` 里的 `.d.ts`/`lib`，
   不是实机。
7. **`drainPending` 重判出的 tag 被丢弃**（复核新发现，已确认语义可接受）：投递用条目入队
   时记录的 tag；若某条目只在 drain 期才被判为 re-raise，它会以无 tag 的形式投递。在线流程
   不可达（入队时已判定、入队到投递之间没有 await 窗口），只有 restore 载入的 sidecar 能
   构造出来。
8. **cap 判定在 client 侧有第二份实现**：`client/index.js` 不能 import host 的
   `isAdviceFollowUpCapExhausted`，跨语言重复无法消除，属已知重复点。

## 独立复核（`verify-fixes`）

落改后派了一个独立复核员，只读、带工具预算，对上述 20 组修复做反向验证（每条给
`file:line`、构造反例、必要时用进程外假 port 探针实跑）。复核结论：

- 19 组判为「属实且正确」，含反例实测：未绑定 claim 遇到无关 turn 不确认、dedupe 已确认
  的 key 不再被 steer、re-raise 未被误杀、`pendingFollowUp` 不覆盖较新条目、NaN/负数标量
  归 0、`.ENV`/`server.PEM`/`ID_RSA`/`.SSH` DENY 而三个白名单 ALLOW、canonical home 生效、
  `--password=` 脱敏而 `monkey=`/`publicKey=` 不误伤。
- **1 组判为「有问题」**：`queueMeta` 的第一版修复在真实宿主路径上永不返回 `null`——宿主
  无条件上报 `followUpCap`，于是新会话仍画「空闲跟进 0 / 5」。已按反例重写：现在
  `delivered/muted/followUpsUsed` 全为 0 时返回 `null`，有计数时才画该图；探针复跑 6 个
  输入全部符合预期。
- 复核另提出两条新发现：`src/state.ts` 的 `drainPending` 注释声称「队列条目不带 tag」
  与实现不符（已改注释；drain 期重判出的 tag 有意不消费，理由见代码注释），以及
  `client/index.js` 里 cap 判定是 host `isAdviceFollowUpCapExhausted` 的第二份实现
  （跨语言无法复用，保留但记入遗留）。
- 复核未能验证：真实宿主端到端时序、超时竞态的同 tick 触发、浏览器里的实际渲染。

## 部署到运行中的 dsh web（本会话实跑，2026-10-19 19:15–19:32）

插件以 `link:` 方式装在 `profiles/web` 与 `profiles/headless`，所以"发布"这一步就是
构建 host 半部并让运行中的 `dsh web`（PID 3126026，16:30 启动，已加载旧代码）重新加载。

- 构建：`pnpm run verify`（含 `tsc -p tsconfig.json` → `lib/`）。
- 热重载：按 `dsh-hot-reload-linked-plugin` 的方法，临时改一次
  `~/.dsh/profiles/web/cordis.patch.yml` 的内容触发 hmr reconcile（`stopPlanned` 会
  `await` 旧 fiber 后 `recomposeProfile` 再启动），随后按原字节恢复并 `cmp` 核验
  （sha256 `4f6334b1…`）。全程未重启服务（`ActiveEnterTimestamp` 保持 16:30:22）。
- 验证标记：`GET /api/advisor/status?sessionId=session-1`——旧代码返回
  400 `sessionId is invalid`，新代码返回 200；`/api/advisor/catalog` 200 且带 providers；
  真实会话 `session-0927cccb…` 返回 `enabled: true, currentTurn: 2, followUpCap: 5`；
  浏览器 bundle（rev `3c48b8a1b9bd`）包含新 `queueMeta` 与 `max:1000`、`visibilitychange`。
- **过程中暴露一个真缺陷**（已修，commit `dace26d`）：claim 从布尔改为 symbol token 后，
  存在性仍按 `!== undefined` 判断。旧实例 dispose 时写入的是 `false`，热重载后新实例把
  "前任的墓碑"当成活着的 owner，warn 后直接 return——行没有 observer、没有页面路由，
  直到重启。改为按类型判断（只有 symbol 才算持有）。这正是一次热部署才能暴露的
  in-process 兼容问题，单测与静态评审都不会发现；修复后第二次 reconcile 路由恢复 200。

## 门禁记录（本会话实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck`（`tsc -p tsconfig.test.json`） | exit 0（落改后与落改前均通过；复核员另行实跑 exit 0） |
| `pnpm exec vitest run` | 17 test files / 200 tests passed（基线为 193；复核员另行实跑 200 passed / 0 failed） |
| `pnpm run verify`（typecheck + test + `tsc -p tsconfig.json` build） | exit 0 |
| `node --check client/index.js` | SYNTAX_OK |
| 定向探针（`node --experimental-transform-types`，用后已删除） | 大小写 7 例 DENY/ALLOW 符合预期；脱敏 7 例符合预期；symlink home 与 ENOENT 回溯分支均 DENY；`queueMeta` 6 个输入符合预期 |

## 后续建议

1. 给 `noteInstructionInput` 补「用户插话时撤回未绑定 turn 的 claim」的行为与用例，
   把遗留 1 的 awaiting 残留窗口收掉（需要先定义「插话发生在 hand-off 之前还是之后」的
   语义）。
2. 把 `tests/stats.test.ts` 的 context fixture 换成真实 `composeReviewPrompt(...)` 产出，
   让 `truncated`/尺寸断言跟随生产实现（遗留 4）。
3. 补 runtime 用例覆盖 `newerInstructionInput` 与 cap 耗尽两条投递闸门（遗留 5）。
4. 如果要真机验证，用长驻 `dsh web` + 真实模型路由跑一次完整 review 链路，重点看
   follow-up 确认、超时、以及页面 tab 的队列显示。
