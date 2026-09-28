// 本物のAIクライアント：Claude Opus 4.8 に、利用者のキーでブラウザから直接つなぐ。
// キーは利用者が入力したものだけを使い、送信先は Claude のみ（作者のサーバーは無い）。
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { LLMClient, GenInput, GenResult, StepEvent } from "./types";
import type { Task, PastSchedule } from "../types";
import { buildScoutText } from "../data/demo";

const MODEL = "claude-opus-4-8";

// AIに返させるタスクの形
const GenTask = z.object({
  name: z.string(),
  startDay: z.number().int().min(0).describe("開始日（計画開始日からの日数。0=開始日当日）"),
  dur: z.number().int().positive().describe("所要日数"),
  status: z.enum(["todo", "doing", "review", "done"]).describe("状態（未対応/処理中/処理済み/完了）"),
  ghost: z.boolean().describe("機器納品や回線工事などの『待ち』期間か"),
  crit: z.boolean().describe("クリティカルパス上のタスクか"),
  ref: z.string().describe("見積りの根拠（参考にした過去実績など）。無ければ空文字"),
});
const PlanA = z.object({ tasks: z.array(GenTask) });
const PlanB = z.object({
  findings: z.array(z.object({ text: z.string(), fixed: z.boolean() })),
  tasks: z.array(GenTask),
  improvements: z.array(z.object({ ok: z.boolean(), text: z.string() })),
});

type GenTaskT = z.infer<typeof GenTask>;

let seq = 0;
function toTasks(gen: GenTaskT[]): Task[] {
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

function pastsText(pasts: PastSchedule[]): string {
  if (!pasts.length) return "（参考にする過去実績はありません）";
  return pasts
    .map((p) => `● ${p.name}\n` + p.tasks.map((t) => `  - ${t.name}：${t.days}日`).join("\n"))
    .join("\n");
}
function tasksText(tasks: Task[]): string {
  return tasks.map((t) => `- ${t.name}（開始${t.start}日目・${t.dur}日${t.ghost ? "・待ち" : ""}）`).join("\n");
}

const SYS_A =
  "あなたは経験豊富なITインフラPMです。構築・改修プロジェクトのスケジュール案を作ります。" +
  "過去の類似案件の実績を参考に各タスクの所要日数を見積もり、機器の納品リードタイムや回線工事などの待ち時間は『待ち』タスク(ghost=true)として入れます。" +
  "出力は指定のJSONスキーマに厳密に従ってください。";
const SYS_B =
  "あなたは反証役のPMです。提示されたスケジュールの穴（機器の納品リードタイム漏れ、回線工事の考慮漏れ、クリティカルパス、予備日不足）を突き、現実的に組み直します。" +
  "findings に指摘、tasks に修正後の全タスク、improvements に改善点(ok=true)と残課題(ok=false)を入れます。クリティカルパス上のタスクは crit=true にします。";

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async generate(input: GenInput, onStep: (s: StepEvent) => void): Promise<GenResult> {
    const { project, config, pasts } = input;

    // 実績参考役（コードで要約）
    onStep({ agent: "scout", text: buildScoutText(pasts) });

    // 呼び出しA：分解・見積り・日程配置（たたき台）
    const userA =
      `案件：${project}\n期間：${config.startDate} から ${config.deadline}日後まで\n\n` +
      `参考にする過去実績：\n${pastsText(pasts)}\n\n` +
      `この案件のタスクを洗い出し、開始日(startDay)・所要日数(dur)・状態(status)・待ちか(ghost)・見積り根拠(ref)を付けて返してください。`;
    const a = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: SYS_A,
      messages: [{ role: "user", content: userA }],
      output_config: { format: zodOutputFormat(PlanA) },
    });
    const planA = a.parsed_output;
    if (!planA) throw new Error("AIの応答を解釈できませんでした（分解・見積り）");
    const before = toTasks(planA.tasks);
    onStep({ agent: "analyst", text: `${before.length}個のタスクに分解し、過去実績から日数を見積もりました。` });
    onStep({ agent: "arch", text: "日程に配置しました。まずはたたき台です。", preview: before });

    // 呼び出しB：反証と組み直し
    const userB =
      `完了希望：${config.deadline}日目まで\n\nたたき台：\n${tasksText(before)}\n\n` +
      `穴を指摘(findings)し、修正した全タスク(tasks)と改善点(improvements)を返してください。`;
    const b = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: SYS_B,
      messages: [{ role: "user", content: userB }],
      output_config: { format: zodOutputFormat(PlanB) },
    });
    const planB = b.parsed_output;
    if (!planB) throw new Error("AIの応答を解釈できませんでした（反証）");
    const findingsHtml = "<ul>" + planB.findings.map((f) => `<li>${escapeHtml(f.text)}</li>`).join("") + "</ul>";
    onStep({ agent: "ref", text: findingsHtml, loop: true });
    const after = toTasks(planB.tasks);
    onStep({ agent: "arch", text: "反証を反映して組み直しました。", revise: true, preview: after });
    onStep({ agent: "intg", text: "最終案にまとめました。ガント編集画面で確定してください。" });

    return { tasks: after, improvements: planB.improvements };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
