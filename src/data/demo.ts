// デモ用の初期スケジュール（架空）。P5 で本物のAIに差し替える。
import type { Task, PlanConfig, PastSchedule, PlanTask } from "../types";

/** CPM用の初期計画（支社ITインフラ構築・工数と依存つき・架空） */
export function demoPlan(): PlanTask[] {
  return [
    { id: "t1", name: "キックオフ・要件確認", effort: 2, deps: [], status: "done" },
    { id: "t2", name: "回線開通 申込→工事", effort: 40, deps: ["t1"], status: "doing", ref: "参考：A支社 回線工事35日" },
    { id: "t3", name: "機器 発注→納品待ち", effort: 21, deps: ["t1"], status: "doing", ref: "参考：本社20日/A支社22日" },
    { id: "t4", name: "ネットワーク構築", effort: 8, deps: ["t3"], status: "todo" },
    { id: "t5", name: "サーバー構築", effort: 8, deps: ["t4"], status: "todo" },
    { id: "t6", name: "PCキッティング(20台)", effort: 6, deps: ["t3"], status: "todo" },
    { id: "t7", name: "総合テスト", effort: 4, deps: ["t2", "t5", "t6"], status: "todo" },
    { id: "t8", name: "移行・立ち会い", effort: 3, deps: ["t7"], status: "todo" },
  ];
}

/** 参考にする過去実績（架空サンプル）。CSV取込で増やせる。 */
export function demoPasts(): PastSchedule[] {
  return [
    {
      name: "本社NW更改（2025）",
      tasks: [
        { name: "キックオフ・要件", days: 3 },
        { name: "機器選定", days: 5 },
        { name: "機器発注", days: 1 },
        { name: "機器納品待ち", days: 20 },
        { name: "ネットワーク構築", days: 9 },
        { name: "サーバー構築", days: 8 },
        { name: "総合テスト", days: 5 },
        { name: "移行", days: 4 },
      ],
    },
    {
      name: "A支社IT構築（2024）",
      tasks: [
        { name: "要件確認", days: 4 },
        { name: "回線開通申込→工事", days: 35 },
        { name: "機器選定", days: 4 },
        { name: "機器納品待ち", days: 22 },
        { name: "NW構築", days: 10 },
        { name: "サーバー構築", days: 9 },
        { name: "キッティング", days: 7 },
        { name: "テスト", days: 5 },
        { name: "移行", days: 4 },
      ],
    },
  ];
}

/** 取込UIの「サンプルCSVを入れる」用 */
export const SAMPLE_CSV =
  "要件確認,3\n回線開通申込→工事,38\n機器選定,4\n機器発注,1\n機器納品待ち,24\nネットワーク構築,8\nサーバー構築,7\nキッティング,6\n総合テスト,5\n移行・立ち会い,4";

export const planConfig: PlanConfig = {
  startDate: "2026-11-01",
  deadline: 49, // 12/20 まで
  today: 14, // 11/15
};

let seq = 0;
const uid = () => "t" + ++seq;

/** 反証を反映済みの現実的なスケジュール（デモ） */
export function demoTasks(): Task[] {
  seq = 0;
  return [
    { id: uid(), name: "キックオフ・要件確認", start: 0, dur: 2, status: "done" },
    { id: uid(), name: "回線開通 申込→工事(4-6週)", start: 1, dur: 40, ghost: true, crit: true, status: "doing", ref: "参考：A支社IT構築 回線工事35日" },
    { id: uid(), name: "機器選定", start: 2, dur: 3, status: "review" },
    { id: uid(), name: "機器発注", start: 5, dur: 1, status: "todo" },
    { id: uid(), name: "機器 納品待ち(約3週)", start: 6, dur: 15, ghost: true, status: "todo", ref: "参考：本社20日 / A支社22日" },
    { id: uid(), name: "ネットワーク構築", start: 22, dur: 8, status: "todo" },
    { id: uid(), name: "サーバー構築", start: 26, dur: 8, status: "todo" },
    { id: uid(), name: "PCキッティング(20台)", start: 34, dur: 6, status: "todo" },
    { id: uid(), name: "総合テスト", start: 41, dur: 4, crit: true, status: "todo" },
    { id: uid(), name: "移行・立ち会い", start: 45, dur: 3, crit: true, status: "todo" },
  ];
}

/** 新規タスクの雛形 */
export function newTask(todayIndex: number, deadline: number): Task {
  return { id: "n" + Date.now(), name: "新しいタスク", start: Math.min(todayIndex, deadline - 3), dur: 3, status: "todo" };
}

/** 反証前の「たたき台」（リードタイム・回線を無視した素朴な案） */
export function demoBefore(): Task[] {
  seq = 100;
  return [
    { id: uid(), name: "キックオフ・要件確認", start: 0, dur: 2, status: "done" },
    { id: uid(), name: "機器選定", start: 2, dur: 4, status: "doing" },
    { id: uid(), name: "機器発注", start: 6, dur: 1, status: "todo" },
    { id: uid(), name: "ネットワーク構築", start: 7, dur: 10, status: "todo" },
    { id: uid(), name: "サーバー構築", start: 14, dur: 9, status: "todo" },
    { id: uid(), name: "PCキッティング(20台)", start: 28, dur: 7, status: "todo" },
    { id: uid(), name: "総合テスト", start: 37, dur: 5, status: "todo" },
    { id: uid(), name: "移行・立ち会い", start: 43, dur: 4, status: "todo" },
  ];
}

// ==== オーケストレーション（デモ再生） ====
export type AgentKey = "scout" | "analyst" | "arch" | "ref" | "intg";

export interface OrchStep {
  agent: AgentKey;
  /** 空文字なら実行時に buildScoutText で生成 */
  text: string;
  gantt?: "before" | "after";
  loop?: boolean; // 反証→差し戻しの線を出す
  revise?: boolean; // 「組み直し」バッジ
  done?: boolean; // 最後
}

export const ORCH_STEPS: OrchStep[] = [
  { agent: "scout", text: "" },
  { agent: "analyst", text: "今回のタスクを洗い出し、過去実績から日数を見積もりました。PC20台のキッティングは本社実績から約6日と置きます。" },
  { agent: "arch", text: "依存関係を考えて日程に並べました。まずはたたき台です。", gantt: "before" },
  {
    agent: "ref",
    text: "このたたき台には穴があります。<ul><li>機器の<b>納品リードタイム(約3週)</b>が入っていない</li><li><b>回線開通</b>が計画にない。工事に4-6週</li><li>クリティカルパスが見えず、予備日もゼロ</li></ul>",
    loop: true,
  },
  {
    agent: "arch",
    text: "反証を反映して組み直します。<b>回線申込をキックオフ直後に最前倒し</b>、機器は納品待ちを挟んでから構築、テスト・移行を回線開通後に配置します。",
    revise: true,
    gantt: "after",
  },
  { agent: "ref", text: "リードタイムと回線は解消。ただし移行が <b>12/19</b> で予備日がほぼゼロ。回線工事が数日遅れると押し出されます。残課題です。" },
  { agent: "intg", text: "最終案にまとめました。クリティカルパスは <b>回線開通→総合テスト→移行</b>。ガント編集画面で確定してください。", done: true },
];

/** v-html に流し込む前にユーザー由来文字列をエスケープする（XSS対策） */
export function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 実績参考役の発言（取り込んだ過去実績から動的生成） */
export function buildScoutText(pasts: PastSchedule[]): string {
  const names = esc(pasts.map((p) => p.name).join("・")) || "（実績なし）";
  const max = (re: RegExp) => {
    let m = 0;
    for (const p of pasts) for (const t of p.tasks) if (re.test(t.name)) m = Math.max(m, t.days || 0);
    return m;
  };
  const line = max(/回線|開通/) || 35;
  const deliv = max(/納品/) || 22;
  return `過去の <b>${pasts.length}件</b>（${names}）を参考にします。実績では <b>回線工事 最大${line}日</b>、<b>機器納品 最大${deliv}日</b>。今回もこれを見込みます。`;
}

/** 反証で良くなった点（デモ） */
export const IMPROVEMENTS = [
  { ok: true, text: "機器の納品リードタイム(約3週)を計画に追加（無視されていた）" },
  { ok: true, text: "回線開通の申込をキックオフ直後に最前倒し（工事4-6週を吸収）" },
  { ok: true, text: "クリティカルパス（回線→テスト→移行）を明示" },
  { ok: false, text: "残課題：予備日がほぼゼロ。回線工事の遅延に備え、前倒し申込を必須条件に" },
];
