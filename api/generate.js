// サーバーレス関数（Vercel / Node）。APIキーをサーバー側(env)で保持し、
// 2段のオーケストレーション（分解・見積り → 反証・組み直し）を実行して、
// 各ステップを SSE でブラウザへ流す。
//
// AIの呼び先は env で自動選択（＝「1か所差し替え」の実証）:
//   - GEMINI_API_KEY があれば Google Gemini（無料枠・REST。既定）
//   - なければ ANTHROPIC_API_KEY で Claude
//   - どちらも無ければ 503{error:"nokey"} → クライアントはデモ再生へ自動フォールバック
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const ANTHROPIC_MODEL = "claude-opus-4-8";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

// Vercel: 2段のAI呼び出しは合計で数十秒かかるため、関数の最大実行時間を延ばす
// （既定10秒だと途中で打ち切られる。Hobbyプランの上限=60秒に設定）
export const config = { maxDuration: 60 };

// ---- 簡易レート制限（公開URLの無料枠いたずら消費・DoS 対策）----
// サーバーレスはインスタンスが揮発するためベストエフォート（強固にするなら Vercel KV / Upstash 等へ）。
const RL_WINDOW_MS = 10 * 60 * 1000; // 10分
const RL_MAX = 30; // 1IPあたり 10分で30回まで
const rlHits = new Map(); // ip -> number[]（アクセス時刻）
function isRateLimited(ip) {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  // 上限到達なら記録せず即拒否（連打時に配列が無限に伸びるのを防ぐ）
  if (arr.length >= RL_MAX) {
    rlHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  rlHits.set(ip, arr);
  if (rlHits.size > 5000) {
    // 古いエントリを掃除（メモリ肥大の抑制）
    for (const [k, v] of rlHits) {
      if (!v.length || now - v[v.length - 1] > RL_WINDOW_MS) rlHits.delete(k);
    }
  }
  return false;
}
function clientIp(req) {
  const h = req.headers || {};
  // Vercel 等のプロキシ配下では x-real-ip が実クライアントIP。
  // x-forwarded-for は最左がクライアント詐称可能なので、使う場合は最右（プロキシ付与分）を採る。
  if (h["x-real-ip"]) return String(h["x-real-ip"]).trim();
  const xff = h["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",");
    return parts[parts.length - 1].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// ---- 出力スキーマ（Anthropic=Zod / Gemini=JSON Schema の2形式で用意）----
const GenTaskZ = z.object({
  name: z.string(),
  startDay: z.number().int().min(0),
  dur: z.number().int().positive(),
  status: z.enum(["todo", "doing", "review", "done"]),
  ghost: z.boolean(),
  crit: z.boolean(),
  ref: z.string(),
});
const PlanAZ = z.object({ tasks: z.array(GenTaskZ) });
const PlanBZ = z.object({
  findings: z.array(z.object({ text: z.string(), fixed: z.boolean() })),
  tasks: z.array(GenTaskZ),
  improvements: z.array(z.object({ ok: z.boolean(), text: z.string() })),
});

const GEN_TASK_JSON = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    startDay: { type: "INTEGER" },
    dur: { type: "INTEGER" },
    status: { type: "STRING", enum: ["todo", "doing", "review", "done"] },
    ghost: { type: "BOOLEAN" },
    crit: { type: "BOOLEAN" },
    ref: { type: "STRING" },
  },
  required: ["name", "startDay", "dur", "status", "ghost", "crit", "ref"],
  propertyOrdering: ["name", "startDay", "dur", "status", "ghost", "crit", "ref"],
};
const PLAN_A_JSON = {
  type: "OBJECT",
  properties: { tasks: { type: "ARRAY", items: GEN_TASK_JSON } },
  required: ["tasks"],
};
const PLAN_B_JSON = {
  type: "OBJECT",
  properties: {
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, fixed: { type: "BOOLEAN" } },
        required: ["text", "fixed"],
      },
    },
    tasks: { type: "ARRAY", items: GEN_TASK_JSON },
    improvements: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { ok: { type: "BOOLEAN" }, text: { type: "STRING" } },
        required: ["ok", "text"],
      },
    },
  },
  required: ["findings", "tasks", "improvements"],
};

// ---- 変換・整形 ----
function toTasks(gen) {
  let seq = 0;
  return gen.map((g) => ({
    id: "a" + ++seq,
    name: g.name,
    start: g.startDay,
    dur: g.dur,
    status: g.status,
    ghost: g.ghost,
    crit: g.crit,
    ref: g.ref || undefined,
  }));
}
function pastsText(pasts) {
  if (!pasts || !pasts.length) return "（参考にする過去実績はありません）";
  return pasts
    .map((p) => `● ${p.name}\n` + (p.tasks || []).map((t) => `  - ${t.name}：${t.days}日`).join("\n"))
    .join("\n");
}
function tasksText(tasks) {
  return tasks.map((t) => `- ${t.name}（開始${t.start}日目・${t.dur}日${t.ghost ? "・待ち" : ""}）`).join("\n");
}
function scoutText(pasts) {
  const list = pasts || [];
  // 実績名はユーザー由来 → v-html に流す前にエスケープ（XSS対策）
  const names = esc(list.map((p) => p.name).join("・")) || "（実績なし）";
  const max = (re) => {
    let m = 0;
    for (const p of list) for (const t of p.tasks || []) if (re.test(t.name)) m = Math.max(m, t.days || 0);
    return m;
  };
  const line = max(/回線|開通/) || 35;
  const deliv = max(/納品/) || 22;
  return `過去の <b>${list.length}件</b>（${names}）を参考にします。実績では <b>回線工事 最大${line}日</b>、<b>機器納品 最大${deliv}日</b>。今回もこれを見込みます。`;
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 土台モード用：タスクを依存順（開始日→元順）にカスケード配置して重複密集を解消し、
// 締切に合わせて分散（余裕あり）／圧縮（超過）する。必ず全タスクが締切内に収まる。
function reflowToDeadline(tasks, deadline) {
  if (!tasks.length || !(deadline > 0)) return tasks;
  const ordered = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.start - b.t.start || a.i - b.i)
    .map((x) => x.t);
  // カスケード配置（前タスクの約6割経過で次を開始＝ほどよい重なりでずらす）
  let cursor = 0;
  const laid = ordered.map((t) => {
    const start = cursor;
    cursor += Math.max(1, Math.ceil(t.dur * 0.6));
    return { ...t, start };
  });
  const span = laid.reduce((m, t) => Math.max(m, t.start + t.dur), 0);
  if (span <= 0) return laid;
  const clamp = (start, dur) => {
    if (start > deadline - 1) start = Math.max(0, deadline - 1);
    if (start + dur > deadline) dur = Math.max(1, deadline - start);
    return { start, dur };
  };
  if (span > deadline) {
    // 超過→比例圧縮
    const f = deadline / span;
    return laid.map((t) => {
      const c = clamp(Math.round(t.start * f), Math.max(1, Math.round(t.dur * f)));
      return { ...t, start: c.start, dur: c.dur };
    });
  }
  // 余裕あり→開始日を広げて期間全体へ分散（所要日数は維持）
  const g = deadline / span;
  return laid.map((t) => {
    let start = Math.round(t.start * g);
    let dur = t.dur;
    if (start + dur > deadline) start = Math.max(0, deadline - dur);
    const c = clamp(start, dur);
    return { ...t, start: c.start, dur: c.dur };
  });
}

const SYS_A =
  "あなたは経験豊富なITインフラPMです。構築・改修プロジェクトのスケジュール案を作ります。" +
  "過去の類似案件の実績を参考に各タスクの所要日数を見積もり、機器の納品リードタイムや回線工事などの待ち時間は『待ち』タスク(ghost=true)として入れます。" +
  "全体が完了希望日(deadline)内に収まるよう日程を配置します。出力は指定のJSONスキーマに厳密に従ってください。";
const SYS_B =
  "あなたは反証役のPMです。提示されたスケジュールの穴（機器の納品リードタイム漏れ、回線工事の考慮漏れ、クリティカルパス、予備日不足）を突き、現実的に組み直します。" +
  "findings に指摘、tasks に修正後の全タスク、improvements に改善点(ok=true)と残課題(ok=false)を入れます。クリティカルパス上のタスクだけ crit=true にします（多くのタスクを crit にしない。目安は全体の2〜4割まで）。タスクを過度に減らさず、元の粒度を保ってください。" +
  "【厳守】全タスクの完了（startDay+dur）が完了希望日(deadline)を超えないよう、並行実行・前倒し・短縮で必ず期間内に収めること。超過は禁止。予備が少ない場合のみ improvements の残課題(ok=false)として明示する。" +
  "【厳守】渡されたタスクを統合・削除・要約しない。件数を維持したまま、日程・依存・クリティカルのみ調整する。";

const SYS_A_ADAPT =
  "あなたは経験豊富なITインフラPMです。提示された『過去の工程表』を土台に、今回の案件向けにスケジュールを再構成します。" +
  "元のタスクをできるだけ引き継ぎ（名称を尊重し、粒度も維持して省略しすぎない）、今回の案件に不要なものは省き、不足は補います。" +
  "各タスクに開始日(startDay)・所要日数(dur)・状態(status)・待ちか(ghost)・見積り根拠(ref)を付け、依存関係を考慮して日程に並べます。全体が完了希望日(deadline)内に収まるよう配置します。" +
  "同一開始日への集中（重複）を避け、依存に沿って開始日を少しずつずらし、締切まで無理なく分散させます。" +
  "【重要】元の工程表のタスクは原則すべて残す（統合・省略・要約をしない。件数を大きく減らさない）。出力はJSONスキーマに厳密に従ってください。";

// ---- プロバイダ別の呼び出し ----
async function callGemini(apiKey, system, user, jsonSchema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: jsonSchema, maxOutputTokens: 8192 },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini API エラー(${resp.status}) ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini の応答が空でした");
  return JSON.parse(text);
}
async function callAnthropic(apiKey, system, user, zodSchema) {
  const client = new Anthropic({ apiKey });
  const r = await client.messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(zodSchema) },
  });
  if (!r.parsed_output) throw new Error("Claude の応答を解釈できませんでした");
  return r.parsed_output;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  // レート制限（1IPあたりの回数上限を超えたら 429）
  if (isRateLimited(clientIp(req))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const provider = geminiKey ? "gemini" : anthropicKey ? "anthropic" : null;
  if (!provider) {
    res.status(503).json({ error: "nokey" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // ---- 入力の上限・サニタイズ（課金/DoS 対策。過大な入力は拒否）----
  const LIM = { project: 500, pastCount: 20, taskCount: 200, totalTasks: 800, name: 200, deadline: 1000 };
  const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const rawPasts = Array.isArray(body && body.pasts) ? body.pasts : [];
  const totalPastTasks = rawPasts.reduce((a, p) => a + (Array.isArray(p && p.tasks) ? p.tasks.length : 0), 0);
  if (rawPasts.length > LIM.pastCount || totalPastTasks > LIM.totalTasks) {
    res.status(413).json({ error: "input_too_large" });
    return;
  }
  const project = clip((body && body.project) || "この案件", LIM.project);
  const rawConfig = (body && body.config) || {};
  const config = {
    startDate: clip(rawConfig.startDate || "", 20),
    deadline: Math.min(Math.max(Math.round(num(rawConfig.deadline, 40)), 1), LIM.deadline),
    today: Math.round(num(rawConfig.today, 0)),
  };
  const pasts = rawPasts.slice(0, LIM.pastCount).map((p) => ({
    name: clip(p && p.name, LIM.name),
    tasks: (Array.isArray(p && p.tasks) ? p.tasks : []).slice(0, LIM.taskCount).map((t) => ({
      name: clip(t && t.name, LIM.name),
      days: Math.min(Math.max(Math.round(Number(t && t.days) || 0), 0), 100000),
    })),
  }));
  const baseOnPast = !!(body && body.baseOnPast) && pasts.length > 0;

  const callA = (sys, user) =>
    provider === "gemini" ? callGemini(geminiKey, sys, user, PLAN_A_JSON) : callAnthropic(anthropicKey, sys, user, PlanAZ);
  const callB = (sys, user) =>
    provider === "gemini" ? callGemini(geminiKey, sys, user, PLAN_B_JSON) : callAnthropic(anthropicKey, sys, user, PlanBZ);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    // 実績参考役（サーバーで要約）
    send({ agent: "scout", text: scoutText(pasts) });

    // 呼び出しA：分解・見積り・日程配置（たたき台）。土台モードなら過去工程表をベースに再構成。
    const userA = baseOnPast
      ? `案件：${project}\n期間：${config.startDate} から ${config.deadline}日後まで\n\n` +
        `土台にする過去工程表（この内容をベースに再スケジュールする）：\n${pastsText(pasts)}\n\n` +
        `上記を土台に、今回の案件向けに全タスクを配置し直してください。元のタスク名を尊重し、粒度も維持（省略しすぎない）。開始日(startDay)・所要日数(dur)・状態(status)・待ちか(ghost)・クリティカル(crit)・見積り根拠(ref)を付ける。`
      : `案件：${project}\n期間：${config.startDate} から ${config.deadline}日後まで\n\n` +
        `参考にする過去実績：\n${pastsText(pasts)}\n\n` +
        `この案件のタスクを洗い出し、開始日(startDay)・所要日数(dur)・状態(status)・待ちか(ghost)・見積り根拠(ref)を付けて返してください。`;
    const planA = await callA(baseOnPast ? SYS_A_ADAPT : SYS_A, userA);
    const before = toTasks(planA.tasks || []);
    send({
      agent: "analyst",
      text: baseOnPast
        ? `取り込んだ工程表を土台に、${before.length}タスクへ再構成しました。`
        : `${before.length}個のタスクに分解し、過去実績から日数を見積もりました。`,
    });
    send({ agent: "arch", text: "日程に配置しました。まずはたたき台です。", preview: before });

    // 呼び出しB：反証と組み直し
    const userB =
      `完了希望：${config.deadline}日目まで（この日を超えてはいけない）\n\nたたき台：\n${tasksText(before)}\n\n` +
      `穴を指摘(findings)し、修正した全タスク(tasks)と改善点(improvements)を返してください。` +
      `※最終タスクの完了(startDay+dur)が ${config.deadline} を超えないよう必ず収めること（超過厳禁）。`;
    const planB = await callB(SYS_B, userB);
    const findingsHtml = "<ul>" + (planB.findings || []).map((f) => `<li>${esc(f.text)}</li>`).join("") + "</ul>";
    send({ agent: "ref", text: findingsHtml, loop: true });

    let finalTasks = toTasks(planB.tasks || []);
    let reviseText = "反証を反映して組み直しました。";
    // 土台モードで反証がタスクを大きく減らした場合は、詳細版（分解直後）を採用して粒度を守る
    if (baseOnPast && before.length && finalTasks.length < before.length * 0.7) {
      finalTasks = before;
      reviseText = "反証を反映しつつ、取り込んだ工程表の粒度を維持しました。";
    }

    const deadline = Number(config.deadline) || 0;
    if (baseOnPast) {
      // 土台モード：重複密集を解消し、締切に合わせて分散/圧縮（必ず締切内・全タスク保持）
      finalTasks = reflowToDeadline(finalTasks, deadline);
      reviseText += "（重複を分散し、締切まで無理なく配置し直しました）";
    } else if (deadline > 0) {
      // 参考モード：締切超過時のみ確定的に圧縮（必ず締切内）
      const maxEnd = finalTasks.reduce((m, t) => Math.max(m, t.start + t.dur), 0);
      if (maxEnd > deadline) {
        const f = deadline / maxEnd;
        finalTasks = finalTasks.map((t) => {
          let start = Math.round(t.start * f);
          let dur = Math.max(1, Math.round(t.dur * f));
          if (start > deadline - 1) start = Math.max(0, deadline - 1);
          if (start + dur > deadline) dur = Math.max(1, deadline - start);
          return { ...t, start, dur };
        });
        reviseText += `（締切内に収まるよう圧縮調整：${maxEnd}日→${deadline}日）`;
      }
    }

    send({ agent: "arch", text: reviseText, revise: true, preview: finalTasks });
    send({ agent: "intg", text: `最終案にまとめました（${finalTasks.length}タスク）。ガント編集画面で確定してください。（AI: ${provider}）` });
    send({ done: true, result: { tasks: finalTasks, improvements: planB.improvements || [] } });
    res.end();
  } catch (err) {
    send({ error: err && err.message ? err.message : String(err) });
    res.end();
  }
}
