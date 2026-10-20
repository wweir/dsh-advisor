// dsh-advisor web client: the Advisor tab in the conversation view ring.
//
// Hand-written CJS behind the __ModuleLoader__ banner, no build step. The host
// half (lib/index.js) owns every piece of state; this tab asks /api/advisor/
// status for the session it is showing and /api/advisor/catalog for the model
// dropdowns, and renders the answers. The routes are registered through the
// platform Connection service, so the browser session cookie and the
// Host/Origin fence apply to them exactly as to /api.
//
// Presentation is a single injected stylesheet over DSH semantic tokens instead
// of inline styles: color, surfaces, focus, hover and motion then follow the
// host theme (light/dark) and a contrast-safe palette, while the markup stays a
// status surface (region, headings, live status, real labels).
// The bundle body, registered below under the published name and — until every
// deployment has restarted onto it — under the pre-rename alias as well: the
// loader refuses a profile resolution change at runtime (`profile resolution:
// replacing "..." requires a process restart`), so a host started before the
// rename still asks for the old id. Drop the alias arm once no host mounts it.
var advisorFactory=function(require){
var module={exports:{}},exports=module.exports;
var React=require("react");
var h=React.createElement,useEffect=React.useEffect,useRef=React.useRef,useState=React.useState,useId=React.useId;

var ENDPOINT="/api/advisor/status";
var CATALOG_ENDPOINT="/api/advisor/catalog";
var STYLE_ID="dsh-advisor/styles";
var EFFORTS=["off","minimal","low","medium","high","xhigh","max"];
var POLL_MS=5000;

var zh={
  "tab.title":"\u4e8c\u5ba1",
  "loading":"\u6b63\u5728\u8bfb\u53d6\u4e8c\u5ba1\u72b6\u6001\u2026",
  "noSession":"\u672c\u4f1a\u8bdd\u5c1a\u672a\u88ab\u4e8c\u5ba1\u63d2\u4ef6\u89c2\u6d4b\u5230\u3002",
  "unavailable":"\u672c\u90e8\u7f72\u672a\u542f\u7528\u4e8c\u5ba1\u9875\u9762\uff08\u72b6\u6001\u8def\u7531\u4e0d\u53ef\u7528\uff09\u3002",
  "stale":"\u72b6\u6001\u5237\u65b0\u5931\u8d25\uff0c\u663e\u793a\u7684\u662f\u4e0a\u4e00\u6b21\u6210\u529f\u8bfb\u53d6\u7684\u6570\u636e\u3002",
  "enabled":"\u5df2\u542f\u7528",
  "disabled":"\u5df2\u5173\u95ed",
  "paused":"\u5df2\u6682\u505c",
  "reviewing":"\u5ba1\u67e5\u4e2d",
  "idle":"\u7a7a\u95f2",
  "route":"\u6a21\u578b\u8def\u7531",
  "session":"\u4f1a\u8bdd",
  "turn":"\u8f6e\u6b21",
  "lastReview":"\u4e0a\u6b21\u5ba1\u67e5",
  "ctx.short":"\u9001\u5ba1\u4e0a\u4e0b\u6587",
  "ctx.chars":"{n} \u5b57\u7b26",
  "never":"\u5c1a\u672a\u5ba1\u67e5",
  "queue":"\u961f\u5217",
  "queueEmpty":"\u5f53\u524d\u6ca1\u6709\u5f85\u6295\u9012\u3001\u5728\u9014\u6216\u5f85\u786e\u8ba4\u7684\u63d0\u9192\u3002",
  "queueHeld":"\u672a\u6295\u9012\uff1a",
  "queueItem":"{label} {n} \u6761",
  "pending":"\u5f85\u6295\u9012",
  "inFlight":"\u5728\u9014",
  "inFlightHint":"\u5df2\u4ea4\u5165\u6536\u4ef6\u7bb1\uff0c\u4e0b\u4e00\u6b65\u8fb9\u754c\u627f\u63a5\u65f6\u8fdb\u5165\u6a21\u578b\u4e0a\u4e0b\u6587\u3002",
  "inFlightMeta":"\u8f6e\u6b21 {turn} \u00b7 {time}",
  "muted":"\u5df2\u5c4f\u853d",
  "delivered":"\u5df2\u6295\u9012",
  "awaiting":"\u5f85\u786e\u8ba4",
  "awaitingNotes":"\u5f85\u786e\u8ba4\u7684\u63d0\u9192",
  "awaitingHint":"\u5df2\u4ea4\u7ed9\u8ddf\u8fdb\u56de\u5408\uff0c\u6a21\u578b\u56de\u590d\u540e\u624d\u8ba1\u4e3a\u5df2\u6295\u9012\u3002",
  "followUpCapSpent":"\u5df2\u7528\u5c3d",
  "pendingAttempted":"\u5df2\u91cd\u8bd5",
  "hold.running":"\u8fd0\u884c\u4e2d\uff0c\u7b49\u4e0b\u4e00\u6b65\u8fb9\u754c\u63d2\u5165",
  "hold.followUpOpen":"\u4e0a\u4e00\u6b21\u8ddf\u8fdb\u56de\u5408\u8fd8\u5f00\u7740",
  "hold.idleFollowUpRetried":"\u4e0a\u4e00\u6b21\u8ddf\u8fdb\u672a\u88ab\u5904\u7406\uff0c\u7b49\u8fd0\u884c\u4e2d\u7684\u56de\u5408",
  "hold.idleFollowUpCap":"\u7a7a\u95f2\u8ddf\u8fdb\u989d\u5ea6\u5df2\u7528\u5c3d",
  "hold.newerInstruction":"\u4e4b\u540e\u6709\u65b0\u7684\u7528\u6237\u8f93\u5165\uff0c\u7b49\u540e\u7eed\u56de\u5408",
  "hold.idleSeverity":"\u8be5\u7ea7\u522b\u4e0d\u4f1a\u5524\u9192\u7a7a\u95f2\u4f1a\u8bdd",
  "followUps":"\u7a7a\u95f2\u8ddf\u8fdb",
  "health":"\u5065\u5eb7",
  "failures":"\u8fde\u7eed\u5931\u8d25",
  "lastFailure":"\u6700\u8fd1\u5931\u8d25",
  "pendingNotes":"\u5f85\u6295\u9012\u7684\u63d0\u9192",
  "silence":"\u9759\u9ed8\u662f\u6b63\u5e38\u7ed3\u679c\uff1a\u5ba1\u67e5\u8005\u6ca1\u6709\u80fd\u6307\u51fa\u7684\u5177\u4f53\u95ee\u9898\u3002",
  "reload":"\u6545\u969c\u6682\u505c\u53ea\u9700\u91cd\u65b0\u52a0\u8f7d\u63d2\u4ef6\u5373\u53ef\u89e3\u9664\u3002",
  "outcomeUnknown":"\u672a\u77e5\uff08\u63d2\u4ef6\u52a0\u8f7d\u540e\u5c1a\u672a\u5ba1\u67e5\uff09",
  "outcomeSilent":"\u65e0\u53d1\u73b0\uff08\u9759\u9ed8\uff09",
  "outcomeFinding":"\u53d1\u73b0\u95ee\u9898",
  "outcomeSuppressed":"\u5df2\u6291\u5236",
  "outcomeFailed":"\u5931\u8d25",
  "outcomeCancelled":"\u5df2\u53d6\u6d88\uff08\u4e0d\u8ba1\u5931\u8d25\uff09",
  "severity.nit":"\u7ec6\u8282",
  "severity.concern":"\u5173\u6ce8",
  "severity.blocker":"\u963b\u65ad",
  "tokens":"Token \u6d88\u8017\uff08\u4e8c\u5ba1\uff09",
  "tokensOut":"\u8f93\u51fa",
  "tokensPrompt":"\u63d0\u793a\u8bcd",
  "tokensCacheShare":"{p}% \u547d\u4e2d\u7f13\u5b58",
  "tokensReviews":"{n} \u6b21\u5ba1\u67e5 \u00b7 \u5e73\u5747 {avg}",
  "noStats":"\u8fd8\u6ca1\u6709\u5b8c\u6210\u7684\u5ba1\u67e5\uff08\u4e0b\u4e00\u8f6e\u7ed3\u675f\u540e\u5f00\u59cb\u8ba1\u91cf\uff09\u3002",
  "history":"\u5ba1\u67e5\u8bb0\u5f55",
  "kind.silent":"\u65e0\u53d1\u73b0",
  "kind.finding":"\u53d1\u73b0",
  "kind.failed":"\u5931\u8d25",
  "kind.cancelled":"\u5df2\u53d6\u6d88",
  "review.turn":"\u7b2c",
  "review.turnSuffix":"\u8f6e",
  "contextTruncated":"\u5df2\u622a\u65ad",
  "config":"\u914d\u7f6e",
  "config.enabled":"\u542f\u7528\u4e8c\u5ba1",
  "config.provider":"Provider",
  "config.model":"\u6a21\u578b",
  "config.effort":"\u63a8\u7406\u7b49\u7ea7",
  "config.effortInherit":"\u9ed8\u8ba4",
  "config.everyTurns":"\u5ba1\u67e5\u95f4\u9694\uff08\u56de\u590d\u6b21\u6570\uff09",
  "config.maxContextTokens":"\u9001\u5ba1\u4e0a\u4e0b\u6587\u4e0a\u9650\uff08token\uff09",
  "config.timeoutMs":"\u8d85\u65f6\uff08ms\uff09",
  "config.maxAdviceChars":"\u63d0\u9192\u6b63\u6587\u4e0a\u9650",
  "config.severities":"\u7a7a\u95f2\u65f6\u4e3b\u52a8\u6295\u9012\u7ea7\u522b",
  "config.instructions":"\u8ffd\u52a0\u5ba1\u67e5\u6307\u4ee4",
  "config.save":"\u4fdd\u5b58",
  "config.saving":"\u4fdd\u5b58\u4e2d\u2026",
  "config.saved":"\u5df2\u4fdd\u5b58\uff0c\u4e0b\u4e00\u6b21\u5ba1\u67e5\u751f\u6548\uff08\u5199\u5165 config.json\uff09",
  "config.error":"\u4fdd\u5b58\u5931\u8d25",
  "config.routeIncomplete":"\u6a21\u578b\u8def\u7531\u4e0d\u5b8c\u6574\uff1aprovider \u4e0e\u6a21\u578b\u8981\u4e48\u90fd\u586b\uff0c\u8981\u4e48\u90fd\u7559\u7a7a\u3002",
  "config.routeNoClear":"\u9875\u9762\u65e0\u6cd5\u6e05\u7a7a\u6a21\u578b\u8def\u7531\uff1a\u7559\u7a7a\u4e0d\u4f1a\u6539\u53d8\u5df2\u914d\u7f6e\u7684\u8def\u7531\uff1b\u8981\u505c\u6b62\u4e8c\u5ba1\u8bf7\u53d6\u6d88\u300c\u542f\u7528\u4e8c\u5ba1\u300d\u3002",
  "config.routeRequired":"\u542f\u7528\u4e8c\u5ba1\u9700\u8981\u6a21\u578b\u8def\u7531\uff1a\u8bf7\u5148\u9009\u597d provider \u4e0e\u6a21\u578b\u3002",
  "config.numberInvalid":"\u8bf7\u586b\u4e0d\u5c0f\u4e8e 1 \u7684\u6574\u6570",
  "config.unset":"\u672a\u8bbe\u7f6e",
  "config.hint":"\u5176\u4f59\u5b57\u6bb5\uff08maxPending\u3001\u4fdd\u62a4\u8def\u5f84\u7b49\uff09\u4e0d\u5728\u672c\u9875\u4fee\u6539\u3002"
};
var en={
  "tab.title":"Advisor",
  "loading":"Reading advisor status\u2026",
  "noSession":"The advisor plugin has not observed this session yet.",
  "unavailable":"This deployment does not expose the Advisor status route.",
  "stale":"Status refresh failed \u2014 showing the last successful result.",
  "enabled":"enabled",
  "disabled":"disabled",
  "paused":"PAUSED",
  "reviewing":"review in flight",
  "idle":"idle",
  "route":"Model route",
  "session":"Session",
  "turn":"turn",
  "lastReview":"Last review",
  "ctx.short":"Review context",
  "ctx.chars":"{n} chars",
  "never":"never",
  "queue":"Queue",
  "queueEmpty":"Nothing is waiting for delivery, in flight, or confirmation.",
  "queueHeld":"Not delivered: ",
  "queueItem":"{n} {label}",
  "pending":"pending",
  "inFlight":"in flight",
  "inFlightHint":"Already in the inbox; the next step boundary admits it into the model context.",
  "inFlightMeta":"turn {turn} \u00b7 {time}",
  "muted":"muted",
  "delivered":"delivered",
  "awaiting":"awaiting confirmation",
  "awaitingNotes":"Notes awaiting confirmation",
  "awaitingHint":"Handed to a follow-up turn; counts as delivered once the model replies.",
  "followUpCapSpent":"spent",
  "pendingAttempted":"retried",
  "hold.running":"executor is running; goes in at the next step boundary",
  "hold.followUpOpen":"the previous follow-up turn is still open",
  "hold.idleFollowUpRetried":"the last follow-up was not processed; waiting for a running turn",
  "hold.idleFollowUpCap":"the idle follow-up budget is spent",
  "hold.newerInstruction":"a newer user message arrived; waiting for a later turn",
  "hold.idleSeverity":"this severity does not wake an idle session",
  "followUps":"idle follow-ups",
  "health":"Health",
  "failures":"consecutive failures",
  "lastFailure":"Last failure",
  "pendingNotes":"Notes waiting for delivery",
  "silence":"Silence is the normal outcome: the reviewer pointed at nothing concrete.",
  "reload":"Reloading the plugin is what re-arms a paused advisor.",
  "outcomeUnknown":"unknown (nothing reviewed since the plugin loaded)",
  "outcomeSilent":"no finding (silent)",
  "outcomeFinding":"finding",
  "outcomeSuppressed":"dropped before delivery",
  "outcomeFailed":"failed",
  "outcomeCancelled":"cancelled (not a failure)",
  "severity.nit":"nit",
  "severity.concern":"concern",
  "severity.blocker":"blocker",
  "tokens":"Token usage (advisor)",
  "tokensOut":"output",
  "tokensPrompt":"prompt",
  "tokensCacheShare":"{p}% cache hit",
  "tokensReviews":"{n} reviews \u00b7 avg {avg}",
  "noStats":"No completed review yet (counting starts with the next turn end).",
  "history":"Review history",
  "kind.silent":"silent",
  "kind.finding":"finding",
  "kind.failed":"failed",
  "kind.cancelled":"cancelled",
  "review.turn":"turn",
  "review.turnSuffix":"",
  "contextTruncated":"Truncated",
  "config":"Configuration",
  "config.enabled":"Enable reviews",
  "config.provider":"Provider",
  "config.model":"Model",
  "config.effort":"Reasoning level",
  "config.effortInherit":"Default",
  "config.everyTurns":"Review every N rounds",
  "config.maxContextTokens":"Review context budget (tokens)",
  "config.timeoutMs":"Timeout (ms)",
  "config.maxAdviceChars":"Advice body cap",
  "config.severities":"Deliver while idle for",
  "config.instructions":"Extra review instructions",
  "config.save":"Save",
  "config.saving":"Saving\u2026",
  "config.saved":"Saved \u2014 applies to the next review (written to config.json)",
  "config.error":"Save failed",
  "config.routeIncomplete":"An incomplete model route: fill both provider and model, or neither.",
  "config.routeNoClear":"The page cannot clear a model route (an empty value keeps the row's route); turn off \"Enable review\" to stop reviewing.",
  "config.routeRequired":"Enabling reviews needs a model route: pick a provider and a model first.",
  "config.numberInvalid":"Enter an integer of at least 1",
  "config.unset":"Not set",
  "config.hint":"Other fields (maxPending, protected paths) are not edited on this page."
};

// One stylesheet, DSH tokens only. State hues are used on dots, tints and
// hairlines; text always uses label-primary/secondary, which keeps every text
// pair at AA in both themes (the old inline palette used the hue as text and
// fell to 1.6:1 on white).
var CSS=[
"[data-advisor-tab],.adv-state{--adv-ok:var(--dsw-alias-state-success-primary);--adv-warn:var(--dsw-alias-state-warn-primary);--adv-error:var(--dsw-alias-state-error-primary);--adv-info:var(--dsw-alias-state-business-primary);--adv-neutral:var(--dsw-alias-label-secondary)}",
".adv{display:flex;flex-direction:column;padding:20px 24px 28px;max-width:720px;min-height:0;overflow:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
".adv *,.adv-state *{box-sizing:border-box}",
".adv-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}",
".adv-band{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding-bottom:14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}",
".adv-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
".adv-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:11.5px;line-height:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--adv-hue) 10%,transparent);border:0.5px solid var(--dsw-alias-border-l1);border-color:color-mix(in srgb,var(--adv-hue) 26%,transparent);white-space:nowrap}",
".adv-chip--ok{--adv-hue:var(--adv-ok)}.adv-chip--warn{--adv-hue:var(--adv-warn)}.adv-chip--error{--adv-hue:var(--adv-error)}.adv-chip--info{--adv-hue:var(--adv-info)}.adv-chip--neutral{--adv-hue:var(--adv-neutral)}",
".adv-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--adv-hue,var(--adv-neutral));flex:none}",
".adv-route{display:flex;align-items:baseline;gap:8px;min-width:0}",
".adv-route-v{font-size:12.5px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
".adv-k{font-size:11.5px;color:var(--dsw-alias-label-secondary);letter-spacing:0.01em}",
".adv-section{margin-top:22px}",
".adv-h2{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.01em;color:var(--dsw-alias-label-primary)}",
".adv-h2--toggle{margin:0}",
".adv-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 2px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left}",
".adv-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}",
".adv-toggle-label{font-size:12px;font-weight:600;letter-spacing:0.01em}",
".adv-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
".adv-chevron{flex:none;color:var(--dsw-alias-label-secondary);transition:transform .16s var(--ds-ease-in-out)}",
".adv-chevron--open{transform:rotate(180deg)}",
".adv-facts{display:flex;flex-direction:column;gap:2px;margin:0}",
".adv-fact{display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px;align-items:baseline;padding:5px 0}",
".adv-v{min-width:0;margin:0;font-size:13px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}",
".adv-hint{margin-top:3px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
".adv-banner{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:9px 11px;border-radius:10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);background:color-mix(in srgb,var(--adv-hue) 8%,var(--dsw-alias-bg-module-platform));border:0.5px solid var(--dsw-alias-border-l1);border-color:color-mix(in srgb,var(--adv-hue) 22%,transparent)}",
".adv-banner--warn{--adv-hue:var(--adv-warn)}.adv-banner--error{--adv-hue:var(--adv-error)}",
".adv-banner .adv-dot{margin-top:6px}",
".adv-empty{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
".adv-queue{display:flex;flex-direction:column;gap:10px}",
".adv-queue-item{margin:0}",
".adv-queue-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
".adv-queue-n{font-weight:500;font-variant-numeric:tabular-nums}",
".adv-queue-why{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
".adv-queue-why .adv-k{margin-right:4px}",
".adv-queue-meta{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
".adv-metrics{display:flex;flex-direction:column;gap:4px}",
".adv-metric{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
".adv-metric--sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
".adv-disc-body{margin-top:6px}",
".adv-note{margin-top:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);background:color-mix(in srgb,var(--adv-hue) 5%,var(--dsw-alias-bg-module-platform))}",
".adv-note--nit{--adv-hue:var(--adv-neutral)}.adv-note--concern{--adv-hue:var(--adv-warn)}.adv-note--blocker{--adv-hue:var(--adv-error)}",
".adv-note-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}",
".adv-note-sev{font-size:11px;letter-spacing:0.02em;color:var(--dsw-alias-label-secondary)}",
".adv-note-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
".adv-note-text{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
".adv-review{display:flex;flex-direction:column;gap:4px;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}",
".adv-review:first-child{padding-top:2px;border-top:0}",
".adv-review--silent{flex-direction:row;align-items:baseline;gap:8px;padding:5px 0;border-top:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
".adv-review--silent .adv-review-text{color:var(--dsw-alias-label-secondary)}",
".adv-review--finding{margin-top:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-module-platform);background:color-mix(in srgb,var(--adv-hue) 6%,var(--dsw-alias-bg-module-platform))}",
".adv-review--neutral{--adv-hue:var(--adv-neutral)}.adv-review--nit{--adv-hue:var(--adv-neutral)}.adv-review--concern{--adv-hue:var(--adv-warn)}.adv-review--blocker{--adv-hue:var(--adv-error)}.adv-review--failed{--adv-hue:var(--adv-error)}",
".adv-review-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
".adv-review-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}",
".adv-review-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
".adv-review-clock{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
".adv-review-text{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
".adv-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto}",
".adv-badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;white-space:nowrap}",
".adv-badge--warn{--adv-hue:var(--adv-warn)}.adv-badge--ok{--adv-hue:var(--adv-ok)}",
".adv-form{display:flex;flex-direction:column;gap:2px}",
".adv-field{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:center;min-height:44px;padding:3px 0}",
".adv-field--group{align-items:start;padding-top:9px}",
".adv-field--stack{grid-template-columns:1fr;gap:4px;align-items:start;padding:6px 0}",
".adv-checks{display:flex;flex-wrap:wrap;gap:0 16px;align-items:center}",
".adv-check{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-size:13px}",
".adv-check input,.adv-field input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}",
".adv-input{width:100%;max-width:280px;min-height:44px;padding:0 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
".adv-input--num{max-width:180px}",
".adv-input:hover{border-color:var(--dsw-alias-border-l3)}",
".adv-textarea{min-height:88px;max-width:100%;padding:9px 10px;resize:vertical}",
".adv-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}",
".adv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
".adv-btn:disabled{opacity:.55;cursor:default}",
".adv-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-top:10px}",
".adv-msg{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary)}",
".adv-msg--ok{--adv-hue:var(--adv-ok)}.adv-msg--error{--adv-hue:var(--adv-error)}",
".adv-state{display:flex;align-items:flex-start;gap:10px;padding:20px 24px;max-width:720px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}",
".adv-state .adv-dot{margin-top:7px}",
".adv-state--neutral{--adv-hue:var(--adv-neutral)}.adv-state--error{--adv-hue:var(--adv-error)}.adv-state--info{--adv-hue:var(--adv-info)}",
".adv-state-text{margin:0}",
".adv-silence{margin-top:18px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
".adv :focus-visible,.adv-state :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
".adv ::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}",
".adv-disc-body{animation:adv-reveal .16s var(--ds-ease-in-out) both}",
"@keyframes adv-reveal{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}",
"@media (max-width:520px){.adv{padding:16px 16px 24px}.adv-fact{grid-template-columns:112px minmax(0,1fr);gap:10px}.adv-field{grid-template-columns:1fr;gap:3px;align-items:start;padding:5px 0}.adv-input{max-width:100%}.adv-route{flex-direction:column;gap:2px}.adv-review-clock{margin-left:0}}",
"@media (prefers-reduced-motion:reduce){.adv-chevron{transition:none}.adv-disc-body{animation:none}}",
"@supports not (background:color-mix(in srgb,red 10%,transparent)){.adv-chip{background:var(--dsw-alias-bg-layer-2)}.adv-banner,.adv-note{background:var(--dsw-alias-bg-module-platform)}}"
].join("\n");

function installStyles(){
  if(typeof document==="undefined") return undefined;
  var existing=document.getElementById(STYLE_ID);
  if(existing!==null){ existing.textContent=CSS; return function(){}; }
  var tag=document.createElement("style");
  tag.id=STYLE_ID;
  tag.dataset.plugin="dsh-advisor";
  tag.textContent=CSS;
  document.head.appendChild(tag);
  return function(){ if(tag.parentNode!==null) tag.parentNode.removeChild(tag); };
}

function severityLabel(t,severity){
  return t("severity."+severity);
}

/** One queue figure, phrased for the locale ("待投递 2 条" / "2 pending"). */
function queueCount(t,label,count){
  return t("queueItem").replace("{label}",label).replace("{n}",String(count));
}

/** Severity pills for a queue figure; a pill row reads better than "(a, b)". */
function severityBadges(t,severities){
  if(!severities||severities.length===0) return null;
  return h("span",{className:"adv-badges",style:{"marginLeft":"0"}},
    severities.map(function(severity,index){
      return h("span",{key:index,className:"adv-badge"},severityLabel(t,severity));
    }));
}

/**
 * Cumulative delivery figures. They are history, not state, so they sit in one
 * muted line under the live queue instead of competing with it as equal cells,
 * and a zero counted over a whole session is not worth a figure of its own.
 */
function queueMeta(t,s,followUpCap){
  var parts=[];
  if(s.delivered>0) parts.push(t("delivered")+" "+s.delivered);
  if(s.muted>0) parts.push(t("muted")+" "+s.muted);
  // The row is what the session actually counted. count=0 is the case the row
  // exists to avoid: it drew a zero the moment a queue emptied, and the host
  // reports a cap on every session, so an untouched budget is not a figure.
  if(s.followUpsUsed>0){
    parts.push(t("followUps")+" "+s.followUpsUsed+(followUpCap===undefined?"":" / "+followUpCap)+
      (followUpCap!==undefined&&s.followUpsUsed>=followUpCap?" \u00b7 "+t("followUpCapSpent"):""));
  }
  if(parts.length===0) return null;
  return h("p",{key:"meta",className:"adv-queue-meta"},parts.join(" \u00b7 "));
}

/**
 * The queue block answers one question: is anything waiting, and why has it not
 * moved? So the live state leads, the hold reason is the sentence under it, and
 * the cumulative figures are a muted footer.
 *
 * In-flight notes are shown with their content: a note already handed to the
 * inbox is invisible in the chat until the next step admits it, so this row is
 * the only place the reader can see what was delivered in that window.
 */
function queueBlock(t,s,pending,awaiting,inFlight,followUpCap){
  if(pending.count===0&&awaiting.count===0&&inFlight.count===0){
    return h("div",{className:"adv-queue"},
      h("p",{key:"empty",className:"adv-empty"},t("queueEmpty")),
      queueMeta(t,s,followUpCap));
  }
  var items=[];
  if(pending.count>0){
    items.push(h("div",{key:"p",className:"adv-queue-item"},
      h("p",{className:"adv-queue-line"},
        h("span",{className:"adv-queue-n"},queueCount(t,t("pending"),pending.count)),
        severityBadges(t,pending.severities)),
      pending.hold?h("p",{className:"adv-queue-why"},
        h("span",{className:"adv-k"},t("queueHeld")),t("hold."+pending.hold)):null));
  }
  if(awaiting.count>0){
    items.push(h("div",{key:"a",className:"adv-queue-item"},
      h("p",{className:"adv-queue-line"},
        h("span",{className:"adv-queue-n"},queueCount(t,t("awaiting"),awaiting.count)),
        severityBadges(t,awaiting.severities)),
      h("p",{className:"adv-queue-why"},t("awaitingHint"))));
  }
  if(inFlight.count>0){
    // A host that predates the notes array (or a partial payload) must not take
    // the whole tab down with a TypeError; the count line alone is still true.
    var inFlightNotes=inFlight.notes||[];
    items.push(h("div",{key:"f",className:"adv-queue-item"},
      h("p",{className:"adv-queue-line"},
        h("span",{className:"adv-queue-n"},queueCount(t,t("inFlight"),inFlight.count)),
        severityBadges(t,inFlightNotes.map(function(entry){ return entry.severity; }))),
      h("p",{className:"adv-queue-why"},t("inFlightHint")),
      inFlightNotes.map(function(entry,index){
        return h(NoteCard,{key:"f"+index,t:t,severity:entry.severity,note:entry.note,
          meta:t("inFlightMeta").replace("{turn}",String(entry.turn)).replace("{time}",fmtClock(entry.at))});
      })));
  }
  return h("div",{className:"adv-queue"},items,queueMeta(t,s,followUpCap));
}

function fmtTokens(value){
  if(typeof value!=="number"||!(value>0)) return "0";
  // Each tier starts where the previous one would round to "1000.0".
  if(value<1000) return String(Math.round(value));
  if(value<999950) return (value/1000).toFixed(1)+"K";
  if(value<999950000) return (value/1000000).toFixed(1)+"M";
  return (value/1000000000).toFixed(1)+"G";
}

function fmtChars(value){ return fmtTokens(value); }

function fmtDuration(ms){
  if(typeof ms!=="number"||ms<0) return "0ms";
  if(ms<1000) return Math.round(ms)+"ms";
  var seconds=Math.round(ms/1000);
  if(seconds<60) return seconds+"s";
  return Math.floor(seconds/60)+"m"+(seconds%60)+"s";
}

function fmtClock(at){
  var date=new Date(at), now=new Date();
  var clock=String(date.getHours()).padStart(2,"0")+":"+String(date.getMinutes()).padStart(2,"0");
  var sameDay=date.getFullYear()===now.getFullYear()&&date.getMonth()===now.getMonth()&&date.getDate()===now.getDate();
  return sameDay?clock:(String(date.getMonth()+1)+"/"+String(date.getDate())+" "+clock);
}

function kindLabel(t,kind){
  return t("kind."+kind);
}

/**
 * What one review costs and what it produced, one idea per line: how much the
 * reviewer read (with the share that came from cache), how often and how long it
 * ran, then what came out of it. The five equal cells this replaces said the same
 * thing but left the reader to divide a cache figure by a prompt figure.
 */
function reviewStatsBlock(t,stats){
  var prompt=stats.inputTokens+stats.cacheReadTokens+(stats.cacheWriteTokens||0);
  var share=prompt>0?Math.round((stats.cacheReadTokens*100)/prompt):0;
  var lines=[
    h("p",{key:"volume",className:"adv-metric"},
      t("tokensPrompt")+" "+fmtTokens(prompt),
      stats.cacheReadTokens>0?h("span",{key:"share",className:"adv-metric--sub"}," \u00b7 "+t("tokensCacheShare").replace("{p}",String(share))):null,
      " \u00b7 "+t("tokensOut")+" "+fmtTokens(stats.outputTokens)),
    h("p",{key:"runs",className:"adv-metric adv-metric--sub"},
      t("tokensReviews").replace("{n}",String(stats.reviews)).replace("{avg}",fmtDuration(stats.reviewMs/stats.reviews)))
  ];
  // Only outcomes that happened: a fresh install should not read "发现 0 · 失败 0".
  var outcomes=[["finding",stats.findings],["silent",stats.silent],["failed",stats.failed],["cancelled",stats.cancelled]]
    .filter(function(pair){ return pair[1]>0; })
    .map(function(pair){ return kindLabel(t,pair[0])+" "+pair[1]; });
  if(outcomes.length>0){
    lines.push(h("p",{key:"outcomes",className:"adv-metric adv-metric--sub"},outcomes.join(" \u00b7 ")));
  }
  return h("div",{className:"adv-metrics"},lines);
}

function outcomeText(t,outcome){
  if(outcome===undefined||outcome===null) return t("outcomeUnknown");
  switch(outcome.kind){
    case "silent": return t("outcomeSilent");
    case "finding": return t("outcomeFinding")+" \u00b7 "+(outcome.severity?severityLabel(t,outcome.severity):"?");
    case "suppressed": return t("outcomeSuppressed")+(outcome.reason?" \u00b7 "+outcome.reason:"");
    case "failed": return t("outcomeFailed")+": "+(outcome.reason||"unknown");
    case "cancelled": return t("outcomeCancelled")+(outcome.reason?" \u00b7 "+outcome.reason:"");
    default: return outcome.kind;
  }
}

function clip(text,maximum){
  if(typeof text!=="string") return "";
  var characters=Array.from(text);
  return characters.length<=maximum?text:characters.slice(0,maximum).join("")+"\u2026";
}

function useStatus(sessionId,t){
  var pair=useState({kind:"loading"}),state=pair[0],setState=pair[1];
  // Locale switching must not rebuild the poll loop (that would flash the tab
  // back to "loading"), but failures localized after the switch should use the
  // new language: read the translator through a ref instead of the closure.
  var tRef=useRef(t); tRef.current=t;
  useEffect(function(){
    if(sessionId===undefined||sessionId===null){ setState({kind:"no-session"}); return undefined; }
    var alive=true;
    // A poll failure (host restart, proxy blip, plugin reload) must not unmount the
    // tab: the settings form holds unsaved input, and rebuilding it from the server
    // silently discards what the user typed. Keep the last good status and report
    // the failure next to it; only a tab that never had data shows a full error.
    var lastReady=null, lastJson=null, lastStale=null, seq=0;
    setState({kind:"loading"});
    function fail(kind,detail){
      if(!alive) return;
      if(lastReady!==null){
        // Identical failures must not re-render the tab every poll either.
        if(detail===lastStale) return;
        lastStale=detail;
        setState({kind:"ready",status:lastReady,stale:detail});
      } else setState({kind:kind,detail:detail});
    }
    function tick(){
      var mine=++seq;
      fetch(ENDPOINT+"?sessionId="+encodeURIComponent(sessionId),{headers:{accept:"application/json"}})
        .then(function(response){
          return response.json().catch(function(){ return null; }).then(function(body){
            if(!alive||mine!==seq) return;
            if(!response.ok){
              fail(response.status===404?"unavailable":"error",(body&&body.error)||("HTTP "+response.status));
              return;
            }
            if(body===null||body===undefined){ fail("error",tRef.current("unavailable")); return; }
            if(body.error!==undefined){ fail("error",String(body.error)); return; }
            if(body.status===null){
              // The host reports no live state for this session (a restart drops
              // the in-process runtime). Keeping the last good payload would let a
              // later poll failure resurrect it as "ready", showing data the host
              // just said it does not have.
              lastReady=null; lastStale=null;
              if(lastJson!=="null"){ lastJson="null"; setState({kind:"no-session"}); }
              return;
            }
            // The tab is polled every few seconds; only a changed payload may
            // replace the state. Re-rendering an unchanged (long) page every poll is
            // what makes it look like it "keeps refreshing".
            var next=JSON.stringify(body.status);
            if(next===lastJson) return;
            lastJson=next; lastStale=null; lastReady=body.status;
            setState({kind:"ready",status:body.status});
          });
        })
        .catch(function(error){ if(alive&&mine===seq) fail("error",String(error&&error.message||error)); });
    }
    tick();
    var timer=setInterval(function(){ if(!document.hidden) tick(); },POLL_MS);
    // A tab the user just came back to is the moment the stale figure matters:
    // waiting out the interval would show an outdated queue for up to POLL_MS.
    var onVisible=function(){ if(!document.hidden) tick(); };
    document.addEventListener("visibilitychange",onVisible);
    return function(){ alive=false; clearInterval(timer); document.removeEventListener("visibilitychange",onVisible); };
  },[sessionId]);
  return state;
}

function Chevron(props){
  return h("svg",{className:"adv-chevron"+(props.open?" adv-chevron--open":""),width:14,height:14,viewBox:"0 0 16 16","aria-hidden":"true",focusable:"false"},
    h("path",{d:"M4 6.25 8 10.25 12 6.25",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}));
}

function Chip(props){
  return h("span",{className:"adv-chip adv-chip--"+props.tone},
    h("span",{className:"adv-dot","aria-hidden":"true"}),
    h("span",null,props.label));
}

// Section with a real heading. The id is generated so aria-labelledby names the
// region for assistive tech without asking every caller to invent ids.
function Section(props){
  var id=useId();
  return h("section",{className:"adv-section","aria-labelledby":id},
    h("h2",{className:"adv-h2",id:id},props.title),
    props.children);
}

function Fact(props){
  return h("div",{className:"adv-fact"},
    h("dt",{className:"adv-k"},props.label),
    h("dd",{className:"adv-v"},props.value,props.hint?h("div",{className:"adv-hint"},props.hint):null));
}

function StatePanel(props){
  return h("div",{"data-advisor-tab":true,className:"adv-state adv-state--"+props.tone,role:props.role,"aria-busy":props.busy?"true":undefined},
    h("span",{className:"adv-dot","aria-hidden":"true"}),
    h("p",{className:"adv-state-text"},props.text));
}

function Collapsible(props){
  var id=useId();
  var pair=useState(false),open=pair[0],setOpen=pair[1];
  var bodyId="adv-body-"+id;
  return h("section",{className:"adv-section","aria-labelledby":id},
    h("h2",{className:"adv-h2 adv-h2--toggle",id:id},
      h("button",{type:"button",className:"adv-toggle",onClick:function(){ setOpen(!open); },"aria-expanded":open,"aria-controls":bodyId},
        h(Chevron,{open:open}),
        h("span",{className:"adv-toggle-label"},props.title),
        props.count===undefined?null:h("span",{className:"adv-count"},String(props.count)))),
    // keepMounted: a collapsed settings body must survive the collapse, or
    // reopening it would discard whatever the user had typed but not saved.
    h("div",{className:"adv-disc-body",id:bodyId,hidden:!open},
      props.keepMounted?props.body:(open?props.body:null)));
}

function NoteCard(props){
  var t=props.t;
  var severity=props.severity||"nit";
  return h("article",{className:"adv-note adv-note--"+severity},
    h("div",{className:"adv-note-head"},
      h("span",{className:"adv-dot","aria-hidden":"true"}),
      h("span",{className:"adv-note-sev"},severityLabel(t,severity)),
      props.meta?h("span",{className:"adv-note-meta"},props.meta):null),
    h("p",{className:"adv-note-text"},props.note));
}

function ReviewRow(props){
  var t=props.t, r=props.review;
  var clock=fmtClock(r.at);
  var usage=fmtTokens(r.usage&&r.usage.inputTokens)+" in / "+fmtTokens(r.usage&&r.usage.outputTokens)+" out \u00b7 "+fmtDuration(r.usage&&r.usage.durationMs);
  var turn=t("review.turn")+" "+r.turn+(t("review.turnSuffix")?" "+t("review.turnSuffix"):"");
  // Silence is the expected outcome; it renders as one secondary line so a
  // healthy session's history stays scannable. Findings carry the note inline
  // (the note IS the deliverable — it must not appear a second time in a
  // separate "delivered" list) on a tinted card, with the delivery state the
  // host recorded matched back by turn.
  if(r.kind==="silent"){
    return h("div",{className:"adv-review adv-review--silent"},
      h("span",{className:"adv-dot","aria-hidden":"true"}),
      h("span",{className:"adv-review-text"},turn+" \u00b7 "+kindLabel(t,r.kind)+" \u00b7 "+usage+" \u00b7 "+clock));
  }
  var tone=r.kind==="finding"?(r.severity||"nit"):r.kind==="failed"?"failed":"neutral";
  var head=turn+" \u00b7 "+kindLabel(t,r.kind)+(r.severity?" \u00b7 "+severityLabel(t,r.severity):"");
  var chip=props.delivery==="delivered"
    ?h("span",{className:"adv-badge adv-badge--ok",key:"del"},h("span",{className:"adv-dot","aria-hidden":"true"}),t("delivered"))
    :props.delivery==="awaiting"
      ?h("span",{className:"adv-badge",key:"aw"},h("span",{className:"adv-dot","aria-hidden":"true"}),t("awaiting"))
      :null;
  var detail=clip(r.note||r.reason||"",220);
  return h("article",{className:"adv-review adv-review--"+tone+(r.kind==="finding"?" adv-review--finding":"")},
    h("div",{className:"adv-review-head"},
      h("span",{className:"adv-dot","aria-hidden":"true"}),
      h("span",{className:"adv-review-title"},head),
      chip,
      h("span",{className:"adv-review-meta"},usage),
      h("span",{className:"adv-review-clock"},clock)),
    detail?h("p",{className:"adv-review-text"},detail):null);
}


function configKey(cfg){ return JSON.stringify(cfg||null); }

function ConfigSection(props){
  var t=props.t, cfg=props.config||{};
  var sevLabelId=useId();
  function initial(){
    var m=cfg.model||{provider:"",model:""};
    return {enabled:cfg.enabled!==false,provider:m.provider||"",model:m.model||"",effort:m.reasoningEffort||"",
      everyTurns:(cfg.review&&cfg.review.everyTurns)||1,
      maxContextTokens:(cfg.review&&cfg.review.maxContextTokens)||32000,
      timeoutMs:(cfg.review&&cfg.review.timeoutMs)||180000,
      maxAdviceChars:(cfg.review&&cfg.review.maxAdviceChars)||2000,
      severities:(cfg.delivery&&cfg.delivery.activeIdleSeverities)||["concern","blocker"],
      instructions:cfg.instructions||""};
  }
  var pair=useState(initial), form=pair[0], setForm=pair[1];
  var key=configKey(cfg);
  var dirtyRef=useRef(false);
  var aliveRef=useRef(true);
  /* eslint-disable-next-line */
  useEffect(function(){ return function(){ aliveRef.current=false; }; },[]);
  /* eslint-disable-next-line */
  useEffect(function(){
    // An external save (another tab, the CLI) must not overwrite unsaved input.
    if(!dirtyRef.current) setForm(initial());
  },[key]);
  // The provider/model dropdowns read the live model catalog. null = still
  // loading, false = unavailable (older host or no LLM registry): the form then
  // keeps the free-text inputs it always had.
  var catalogPair=useState(null), catalog=catalogPair[0], setCatalog=catalogPair[1];
  /* eslint-disable-next-line */
  useEffect(function(){
    var alive=true;
    fetch(CATALOG_ENDPOINT,{headers:{accept:"application/json"}})
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .then(function(body){ if(alive) setCatalog(Array.isArray(body.providers)?body.providers:[]); })
      .catch(function(){ if(alive) setCatalog(false); });
    return function(){ alive=false; };
  },[]);
  var notePair=useState(null), note=notePair[0], setNote=notePair[1];
  var busyPair=useState(false), busy=busyPair[0], setBusy=busyPair[1];
  function set(field,value){
    var next=Object.assign({},form); next[field]=value; setForm(next);
    dirtyRef.current=true;
    // "Saved" must not keep claiming the visible values when they changed after it.
    if(note!==null) setNote(null);
  }
  function setMany(values){
    var next=Object.assign({},form,values); setForm(next);
    dirtyRef.current=true;
    if(note!==null) setNote(null);
  }
  function catalogGroups(){ return catalog===false||catalog===null?[]:catalog; }
  function providerGroup(id){
    var groups=catalogGroups();
    for(var i=0;i<groups.length;i++) if(groups[i].id===id) return groups[i];
    return undefined;
  }
  function modelEntry(group,id){
    if(!group) return undefined;
    for(var i=0;i<group.models.length;i++) if(group.models[i].id===id) return group.models[i];
    return undefined;
  }
  // "" (inherit the row's effort) is always legal; otherwise the selected
  // model's advertised efforts win when it has any, and the static list is the
  // fallback for a model that advertises none.
  function effortAllowed(entry,effort){
    if(effort==="") return true;
    // Present-and-empty means "advertised, none of them offerable" — not "unknown".
    if(entry&&entry.efforts!==undefined) return entry.efforts.indexOf(effort)>=0;
    return true;
  }
  function effortOptions(entry,current){
    var list=(entry&&entry.efforts!==undefined)?entry.efforts.slice():EFFORTS;
    // A configured value the catalog does not advertise must stay representable.
    if(current&&list.indexOf(current)<0) list=list.concat([current]);
    return list;
  }
  // Linked dropdowns: switching the provider re-points the model at the new
  // provider's first entry and re-checks the effort against it, so the route
  // never serializes as a dangling provider/model pair.
  function onProviderChange(id){
    var group=providerGroup(id), first=group&&group.models[0];
    var effort=form.effort;
    if(first&&!effortAllowed(first,effort)) effort=first.defaultEffort||"";
    setMany({provider:id,model:first?first.id:"",effort:effort});
  }
  function onModelChange(id){
    var entry=modelEntry(providerGroup(form.provider),id);
    var effort=form.effort;
    if(!effortAllowed(entry,effort)) effort=(entry&&entry.defaultEffort)||"";
    setMany({model:id,effort:effort});
  }
  function toggleSeverity(severity,on){
    var list=(form.severities||[]).filter(function(s){ return s!==severity; });
    if(on) list.push(severity);
    set("severities",list);
  }
  function save(){
    var hadRoute=!!(cfg.model&&cfg.model.provider&&cfg.model.model);
    var provider=form.provider.trim(), model=form.model.trim();
    if((provider.length>0)!==(model.length>0)){
      // One half of a route is not a route, and the host rejects a half-filled
      // model block; reporting it beats a "saved" note that changed nothing.
      setNote({kind:"error",text:t("config.routeIncomplete")});
      return;
    }
    if(hadRoute&&provider.length===0){
      // An absent `model` in the patch keeps the row's route, so this save would
      // claim success while the reviewer keeps its old model.
      setNote({kind:"error",text:t("config.routeNoClear")});
      return;
    }
    // The page's own bounds, mirroring the host's: catching an over-bound value
    // here reports it on its own field, in the page's language, instead of
    // surfacing the host's English path string.
    var review={};
    var numberFields=[["everyTurns","config.everyTurns",1000],["maxContextTokens","config.maxContextTokens",1000000],
      ["timeoutMs","config.timeoutMs",3600000],["maxAdviceChars","config.maxAdviceChars",100000]];
    for(var n=0;n<numberFields.length;n++){
      var value=Number(String(form[numberFields[n][0]]).trim());
      if(!Number.isInteger(value)||value<1||value>numberFields[n][2]){
        setNote({kind:"error",text:t(numberFields[n][1])+" \u00b7 "+t("config.numberInvalid")});
        return;
      }
      review[numberFields[n][0]]=value;
    }
    if(form.enabled&&provider.length===0){
      // enable-without-route is a configuration error the host only checks for the
      // row; accepting it here would save a config that reviews nothing.
      setNote({kind:"error",text:t("config.routeRequired")});
      return;
    }
    setBusy(true); setNote(null);
    var patch={enabled:form.enabled,
      instructions:form.instructions,
      review:review,
      delivery:{activeIdleSeverities:form.severities||[]}};
    // A row with no route legitimately stays model-less, so an empty pair is
    // omitted rather than submitted as two empty strings, which the host rejects.
    if(provider.length>0&&model.length>0){
      patch.model={provider:provider,model:model,
        // null is "inherit the row's effort"; omitting it would keep the previous save.
        reasoningEffort:form.effort?form.effort:null};
    }
    fetch("/api/advisor/config",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify(patch)})
      .then(function(r){ return r.json().then(function(body){ return {ok:r.ok,body:body}; }); })
      .then(function(res){
        if(!aliveRef.current) return;
        if(res.ok){ dirtyRef.current=false; setNote({kind:"ok",text:t("config.saved")}); }
        else { setNote({kind:"error",text:(res.body&&res.body.error)||t("config.error")}); }
      })
      .catch(function(){ if(aliveRef.current) setNote({kind:"error",text:t("config.error")}); })
      .then(function(){ if(aliveRef.current) setBusy(false); });
  }
  function field(key,labelText,control,modifier){
    return h("label",{key:key,className:"adv-field"+(modifier?" "+modifier:"")},
      h("span",{className:"adv-k"},labelText),control);
  }
  var enabledBox=h("input",{type:"checkbox",checked:form.enabled,onChange:function(e){ set("enabled",e.target.checked); }});
  var severities=h("div",{className:"adv-checks",role:"group","aria-labelledby":sevLabelId},
    ["concern","blocker"].map(function(severity){
      var on=(form.severities||[]).indexOf(severity)>=0;
      return h("label",{key:severity,className:"adv-check"},
        h("input",{type:"checkbox",checked:on,onChange:function(e){ toggleSeverity(severity,e.target.checked); }}),
        severityLabel(t,severity));
    }));
  // With a live catalog, provider and model are linked dropdowns; a configured
  // value the registry no longer lists stays as an extra option so the form can
  // round-trip it. The "—" entries are placeholders, not choices: the host has no
  // "clear the route" patch (an absent `model` keeps the row's route), so letting
  // someone pick an empty route would save nothing while claiming success.
  var groups=catalogGroups(), useSelects=groups.length>0;
  var group=providerGroup(form.provider), entry=modelEntry(group,form.model);
  var providerControl;
  if(useSelects){
    var providerOptions=groups;
    if(form.provider&&!group) providerOptions=providerOptions.concat([{id:form.provider,name:form.provider,models:[]}]);
    providerControl=h("select",{className:"adv-input",value:form.provider,onChange:function(e){ onProviderChange(e.target.value); }},
      h("option",{value:"",disabled:true},t("config.unset")),
      providerOptions.map(function(g){ return h("option",{key:g.id,value:g.id},g.name||g.id); }));
  }else{
    providerControl=h("input",{type:"text",className:"adv-input",value:form.provider,onChange:function(e){ set("provider",e.target.value); }});
  }
  var modelControl;
  if(useSelects){
    var models=group?group.models:[];
    var modelOptions=models;
    if(form.model&&models.every(function(m){ return m.id!==form.model; }))
      modelOptions=modelOptions.concat([{id:form.model,name:form.model}]);
    modelControl=h("select",{className:"adv-input",value:form.model,disabled:!group,onChange:function(e){ onModelChange(e.target.value); }},
      h("option",{value:"",disabled:true},t("config.unset")),
      modelOptions.map(function(m){ return h("option",{key:m.id,value:m.id},m.name||m.id); }));
  }else{
    modelControl=h("input",{type:"text",className:"adv-input",value:form.model,onChange:function(e){ set("model",e.target.value); }});
  }
  // The effort is part of the route, not a setting of its own: a patch without
  // `model` drops it, so with no provider/model picked the control is inert and
  // shows "inherit the row's effort" rather than claiming a value nothing stored.
  var routePicked=form.provider.trim().length>0&&form.model.trim().length>0;
  var effortValue=routePicked?(form.effort||""):"";
  var effortList=effortOptions(entry,effortValue);
  return h("div",{className:"adv-form","aria-busy":busy?"true":undefined},
    field("enabled",t("config.enabled"),enabledBox),
    field("provider",t("config.provider"),providerControl),
    field("model",t("config.model"),modelControl),
    field("effort",t("config.effort"),h("select",{className:"adv-input",value:effortValue,disabled:!routePicked,onChange:function(e){ set("effort",e.target.value); }},
      [""].concat(effortList).map(function(value){
        return h("option",{key:value||"inherit",value:value},value||t("config.effortInherit"));
      }))),
    field("everyTurns",t("config.everyTurns"),h("input",{type:"number",min:1,max:1000,step:1,className:"adv-input adv-input--num",value:form.everyTurns,onChange:function(e){ set("everyTurns",e.target.value); }})),
    field("maxContextTokens",t("config.maxContextTokens"),h("input",{type:"number",min:1,max:1000000,step:1,className:"adv-input adv-input--num",value:form.maxContextTokens,onChange:function(e){ set("maxContextTokens",e.target.value); }})),
    field("timeoutMs",t("config.timeoutMs"),h("input",{type:"number",min:1,max:3600000,step:1,className:"adv-input adv-input--num",value:form.timeoutMs,onChange:function(e){ set("timeoutMs",e.target.value); }})),
    field("maxAdviceChars",t("config.maxAdviceChars"),h("input",{type:"number",min:1,max:100000,step:1,className:"adv-input adv-input--num",value:form.maxAdviceChars,onChange:function(e){ set("maxAdviceChars",e.target.value); }})),
    h("div",{key:"severities",className:"adv-field adv-field--group"},
      h("span",{className:"adv-k",id:sevLabelId},t("config.severities")),severities),
    field("instructions",t("config.instructions"),
      h("textarea",{rows:2,className:"adv-input adv-textarea",value:form.instructions,onChange:function(e){ set("instructions",e.target.value); }}),
      "adv-field--stack"),
    h("div",{key:"actions",className:"adv-actions"},
      h("button",{type:"button",className:"adv-btn",onClick:save,disabled:busy},busy?t("config.saving"):t("config.save")),
      note?h("span",{key:"note",className:"adv-msg adv-msg--"+note.kind,role:note.kind==="error"?"alert":"status"},
        h("span",{className:"adv-dot","aria-hidden":"true"}),note.text):null),
    h("p",{key:"hint",className:"adv-hint",style:{"marginTop":"6px"}},t("config.hint")));
}

function liveSummary(t,s,stale){
  if(stale) return t("stale");
  var parts=[s.enabled?t("enabled"):t("disabled")];
  parts.push(s.paused?t("paused"):(s.reviewing?t("reviewing"):t("idle")));
  if(s.pending&&s.pending.count>0){
    // The visible queue leads with the hold reason; the spoken summary must not
    // stop at the count.
    parts.push(t("pending")+" "+s.pending.count+(s.pending.hold?" ("+t("hold."+s.pending.hold)+")":""));
  }
  if(s.awaiting&&s.awaiting.count>0) parts.push(t("awaiting")+" "+s.awaiting.count);
  if(s.inFlight&&s.inFlight.count>0) parts.push(t("inFlight")+" "+s.inFlight.count);
  if(s.failureStreak>0) parts.push(t("failures")+" "+s.failureStreak);
  return parts.join(" \u00b7 ");
}

function AdvisorTab(props){
  var sessionId=props.sessionId;
  var t=props.t;
  var state=useStatus(sessionId,t);

  if(state.kind==="loading") return h(StatePanel,{tone:"info",role:"status",busy:true,text:t("loading")});
  if(state.kind==="no-session") return h(StatePanel,{tone:"neutral",role:"status",text:t("noSession")});
  if(state.kind==="unavailable") return h(StatePanel,{tone:"neutral",role:"status",text:t("unavailable")});
  if(state.kind==="error") return h(StatePanel,{tone:"error",role:"alert",text:state.detail||t("unavailable")});

  var s=state.status;
  var model=!s.model?"none":s.model.provider+"/"+s.model.model+(s.model.reasoningEffort?" ("+s.model.reasoningEffort+")":"");
  var chips=[
    h(Chip,{key:"enabled",tone:s.enabled?"ok":"neutral",label:s.enabled?t("enabled"):t("disabled")}),
    s.paused?h(Chip,{key:"paused",tone:"error",label:t("paused")}):null,
    h(Chip,{key:"state",tone:s.reviewing?"info":"neutral",label:s.reviewing?t("reviewing"):t("idle")})
  ].filter(Boolean);

  // Delivery state the host reports: a note handed to a follow-up turn is
  // "awaiting confirmation" (in neither queue nor history) until the model replies;
  // a note handed to the inbox of a running Executor is "in flight" until a step
  // admits it, which is the window the chat itself cannot show.
  var awaiting=s.awaiting||{count:0,severities:[],notes:[]};
  var pending=s.pending||{count:0,severities:[]};
  var inFlight=s.inFlight||{count:0,notes:[]};
  var followUpCap=typeof s.followUpCap==="number"?s.followUpCap:undefined;

  var live=liveSummary(t,s,state.stale);

  var blocks=[
    h("div",{key:"live",className:"adv-sr",role:"status","aria-live":"polite","aria-atomic":"true"},live),
    h("div",{key:"band",className:"adv-band"},
      h("div",{className:"adv-chips"},chips),
      h("div",{className:"adv-route"},
        h("span",{className:"adv-k"},t("route")),
        h("span",{className:"adv-route-v"},model))),
    state.stale?h("div",{key:"stale",className:"adv-banner adv-banner--warn"},
      h("span",{className:"adv-dot","aria-hidden":"true"}),
      h("span",null,t("stale")+" ("+state.stale+")")):null,
    s.paused?h("div",{key:"paused",className:"adv-banner adv-banner--error"},
      h("span",{className:"adv-dot","aria-hidden":"true"}),
      h("span",null,t("reload"))):null,
    h(Section,{key:"session",title:t("session")},
      h("dl",{className:"adv-facts"},
        h(Fact,{key:"turn",label:t("turn"),value:String(s.currentTurn)}),
        h(Fact,{key:"last",label:t("lastReview"),value:s.lastReviewedTurn===0?t("never"):String(s.lastReviewedTurn)+" \u00b7 "+outcomeText(t,s.lastOutcome)}),
        // The removed context section left one fact worth keeping: how much the
        // reviewer read, and whether earlier work was dropped. Just the fact —
        // nothing to expand, nothing to switch.
        s.lastReviewContext
          ?h(Fact,{key:"ctxShort",label:t("ctx.short"),
              value:t("ctx.chars").replace("{n}",fmtChars(s.lastReviewContext.promptChars))+(s.lastReviewContext.truncated?" \u00b7 "+t("contextTruncated"):"")})
          :null)),
    h(Section,{key:"queue",title:t("queue")},queueBlock(t,s,pending,awaiting,inFlight,followUpCap)),
    h(Section,{key:"health",title:t("health")},
      h("dl",{className:"adv-facts"},
        h(Fact,{key:"failures",label:t("failures"),value:String(s.failureStreak)}),
        s.lastFailure!==undefined?h(Fact,{key:"lastFailure",label:t("lastFailure"),value:s.lastFailure.reason}):null))
  ];

  // Actionable queues come before cost and diagnostics: a note awaiting the
  // model's confirmation outranks the pending queue.
  var awaitingNotes=awaiting.notes||[];
  if(awaitingNotes.length){
    blocks.push(h(Collapsible,{key:"awaitingNotes",title:t("awaitingNotes"),count:awaitingNotes.length,
      body:h("div",null,awaitingNotes.map(function(entry,index){
        return h(NoteCard,{key:"a"+index,t:t,severity:entry.severity,note:clip(entry.note,220),meta:t("review.turn")+" "+entry.turn+" \u00b7 "+t("awaiting")});
      }))}));
  }

  var pendingNotes=s.pendingNotes||[];
  if(pendingNotes.length){
    var shown=pendingNotes.slice(0,6);
    blocks.push(h(Collapsible,{key:"pendingNotes",title:t("pendingNotes"),count:pendingNotes.length,
      body:h("div",null,
        shown.map(function(entry,index){
          return h(NoteCard,{key:"p"+index,t:t,severity:entry.severity,note:clip(entry.note,220),meta:entry.attempted?t("pendingAttempted"):undefined});
        }),
        pendingNotes.length>shown.length?h("p",{key:"more",className:"adv-hint"},"+"+(pendingNotes.length-shown.length)+" \u2026"):null)}));
  }

  var stats=s.stats;
  blocks.push(h(Section,{key:"tokens",title:t("tokens")},
    stats&&stats.reviews>0
      ?reviewStatsBlock(t,stats)
      :h("p",{className:"adv-empty"},t("noStats"))));

  // One merged history: reviews are the timeline and a finding's note renders
  // inline (the note IS the deliverable — a separate "delivered" list only
  // showed it twice). Delivery state is matched back by turn from the host's
  // delivered/awaiting note records; unmatched findings stay silent rather
  // than guess between suppressed and still-queued.
  var reviews=s.recentReviews||[];
  if(reviews.length){
    var deliveredTurns={}, awaitingTurns={};
    (s.recentNotes||[]).forEach(function(n){ deliveredTurns[n.turn]=true; });
    awaitingNotes.forEach(function(n){ awaitingTurns[n.turn]=true; });
    blocks.push(h(Collapsible,{key:"history",title:t("history"),count:reviews.length,
      body:h("div",null,reviews.map(function(r){
        var delivery=r.kind!=="finding"?null:deliveredTurns[r.turn]?"delivered":awaitingTurns[r.turn]?"awaiting":null;
        return h(ReviewRow,{key:"r"+r.at+":"+r.turn,t:t,review:r,delivery:delivery});
      }))}));
  }

  if(s.config){
    blocks.push(h(Collapsible,{key:"configSection",title:t("config"),keepMounted:true,
      body:h(ConfigSection,{t:t,config:s.config})}));
  }

  if(s.lastOutcome&&s.lastOutcome.kind==="silent"){
    blocks.push(h("p",{key:"silence",className:"adv-silence"},t("silence")));
  }

  return h("div",{"data-advisor-tab":true,className:"adv",role:"region","aria-label":t("tab.title")},blocks);
}

exports.inject=["slots","locale"];
exports.apply=function(ctx){
  var t=ctx.locale.bind("advisor");
  ctx.effect(function(){ return ctx.locale.register("advisor",{zh:zh,en:en}); },"dsh-advisor: dictionaries");
  ctx.effect(function(){ return installStyles(); },"dsh-advisor: styles");
  ctx.effect(function(){
    return ctx.slots.inject("conversation.view",function(){
      return ctx.slots.register({name:"conversation.view",id:"conv-advisor",order:21,locale:"advisor",label:function(){ return t("tab.title"); }},
        function(props){ return h(AdvisorTab,{sessionId:props.sessionId,t:t}); });
    });
  },"dsh-advisor: advisor tab");
};
return module.exports;
};
window.__ModuleLoader__.load({id:"@wweir/dsh-advisor",factory:advisorFactory});
window.__ModuleLoader__.load({id:"dsh-advisor",factory:advisorFactory});
