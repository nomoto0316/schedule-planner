<script setup lang="ts">
import { ref, computed } from "vue";
import PastReference from "./components/PastReference.vue";
import Orchestration from "./components/Orchestration.vue";
import GanttEditor from "./components/GanttEditor.vue";
import { demoPasts } from "./data/demo";
import { AutoClient, type RunMode } from "./llm/autoClient";
import type { Task, PastSchedule, PlanConfig, Status } from "./types";
import { PROGRESS } from "./types";

// ==== 入力状態 ====
const project = ref("新支社オフィスのITインフラ構築（NW・サーバー・PC20台）");
const startDate = ref("2026-11-01");
const dueDate = ref("2026-12-20");
const pasts = ref<PastSchedule[]>(demoPasts());
const baseOnPast = ref(false);

// ==== 画面状態 ====
const view = ref<"build" | "edit">("build");
const result = ref<Task[]>([]);
const orch = ref<InstanceType<typeof Orchestration> | null>(null);

// ==== 計画設定（日付から算出）====
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}
function localToday(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
const config = computed<PlanConfig>(() => {
  const deadline = Math.max(1, daysBetween(startDate.value, dueDate.value));
  const todayIdx = daysBetween(startDate.value, localToday());
  const today = Math.min(Math.max(todayIdx, 0), deadline);
  return { startDate: startDate.value, deadline, today };
});

// ==== AIクライアント：サーバー(本物AI)優先・未設定時はデモ再生に自動フォールバック ====
const runMode = ref<RunMode | "idle">("idle");
const client = new AutoClient((m) => {
  runMode.value = m;
});
const modeText = computed(() =>
  runMode.value === "server"
    ? "本物AI（サーバー）で実行しました"
    : runMode.value === "demo"
      ? "デモ再生（サーバー未設定のため自動切替）"
      : "サーバーのAIで実行（未設定時はデモ再生に自動切替）"
);
const modeShort = computed(() =>
  runMode.value === "server" ? "本物AI 稼働中" : runMode.value === "demo" ? "デモ再生" : "スタンバイ"
);

// 期間の要約（開始〜完了希望の日数）。設定カードに表示する。
const spanInfo = computed(() => {
  const d = config.value.deadline;
  if (!(d > 0)) return { text: "日付を確認", cls: "warn" };
  const w = Math.round((d / 7) * 10) / 10;
  return { text: `${d}日間 ・ 約${w}週`, cls: "ok" };
});

function build() {
  view.value = "build";
  orch.value?.run();
}
function onEdit(tasks: Task[]) {
  result.value = tasks;
  view.value = "edit";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ==== 書き出し ====
function dateOf(i: number): string {
  const d = new Date(startDate.value + "T00:00:00");
  d.setDate(d.getDate() + i);
  // ローカル日付で組み立てる（toISOString は UTC 変換で日付が1日ずれるため使わない）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const STATUS_LABEL: Record<Status, string> = { todo: "未対応", doing: "処理中", review: "処理済み", done: "完了" };
// タスクの進捗率(%)。手動値があればそれ、無ければ状態から算出。待ちは対象外
function taskPctText(t: Task): string {
  if (t.ghost) return "待ち";
  const p = typeof t.progress === "number" ? t.progress : Math.round(PROGRESS[t.status] * 100);
  return `${p}%`;
}
function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
function exportCsv() {
  const head = "タスク,開始日,日数,終了日,状態,進捗,クリティカル,根拠";
  const rows = result.value.map((t) =>
    [t.name, dateOf(t.start), t.dur, dateOf(t.start + t.dur - 1), STATUS_LABEL[t.status], taskPctText(t), t.crit ? "★" : "", t.ref ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  download("schedule.csv", "﻿" + [head, ...rows].join("\r\n"), "text/csv;charset=utf-8");
}
function exportJson() {
  download(
    "schedule.json",
    JSON.stringify({ project: project.value, config: config.value, tasks: result.value }, null, 2),
    "application/json"
  );
}
async function exportXlsx() {
  // write-excel-file（v4）でガント形式の .xlsx を書き出す。左＝タスク情報、右＝日付グリッド＋予定バー。
  const tasks = result.value;
  const base = new Date(startDate.value + "T00:00:00");
  const maxEnd = tasks.reduce((m, t) => Math.max(m, t.start + t.dur), 0);
  const N = Math.min(Math.max(maxEnd, config.value.deadline), 200); // 日付列数（上限200）
  const label = (i: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const C = { normal: "#4a9fc7", crit: "#d5432f", ghost: "#b8bcc2", head: "#eef2f7", dead: "#f6d8c9", info: "#e8eef5" };

  // 見出し行（左5列＋日付列。週頭と締切日にラベル）
  const header: any[] = [
    { value: "タスク", fontWeight: "bold", backgroundColor: C.info },
    { value: "開始", fontWeight: "bold", align: "center", backgroundColor: C.info },
    { value: "終了", fontWeight: "bold", align: "center", backgroundColor: C.info },
    { value: "日数", fontWeight: "bold", align: "center", backgroundColor: C.info },
    { value: "状態", fontWeight: "bold", align: "center", backgroundColor: C.info },
    { value: "進捗", fontWeight: "bold", align: "center", backgroundColor: C.info },
  ];
  for (let i = 0; i <= N; i++) {
    const show = i % 7 === 0 || i === config.value.deadline;
    header.push({
      type: String,
      value: show ? label(i) : "",
      align: "center",
      fontSize: 8,
      backgroundColor: i === config.value.deadline ? C.dead : C.head,
    });
  }

  const rows: any[][] = [header];
  for (const t of tasks) {
    const color = t.crit ? C.crit : t.ghost ? C.ghost : C.normal;
    const row: any[] = [
      { value: t.name },
      { type: String, value: dateOf(t.start), align: "center" },
      { type: String, value: dateOf(t.start + t.dur - 1), align: "center" },
      { type: Number, value: t.dur, align: "center" },
      { type: String, value: STATUS_LABEL[t.status], align: "center" },
      { type: String, value: taskPctText(t), align: "center" },
    ];
    for (let i = 0; i <= N; i++) {
      const inBar = i >= t.start && i < t.start + t.dur;
      row.push(inBar ? { type: String, value: "", backgroundColor: color } : null);
    }
    rows.push(row);
  }

  const columns = [{ width: 34 }, { width: 10 }, { width: 10 }, { width: 6 }, { width: 9 }, { width: 7 }];
  for (let i = 0; i <= N; i++) columns.push({ width: 2.8 });

  const mod: any = await import("write-excel-file/browser");
  const writeXlsxFile = mod.default ?? mod;
  const out = writeXlsxFile(rows, { sheet: "スケジュール", columns });
  const blob = await (out.toBlob ? out.toBlob() : out);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "schedule.xlsx";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <header class="app">
    <div class="hbar">
      <div class="logo">
        <span class="mk" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" />
            <path d="M7 13.5l2.5 2.5L15 11" stroke-width="2.2" />
          </svg>
        </span>
        <div class="logo-t">
          <span class="nm">Schedule&nbsp;Planner</span>
          <span class="sub">複数AIが連携し、過去実績を土台に構築スケジュールを組む（反証つき）</span>
        </div>
      </div>
      <div class="hmeta">
        <span class="mode-pill" :class="runMode === 'server' ? 'live' : runMode === 'demo' ? 'demo' : 'idle'">
          <span class="dot"></span>{{ modeShort }}
        </span>
        <span class="tag-demo">個人制作デモ</span>
      </div>
    </div>
  </header>

  <main>
    <!-- 構築ビュー -->
    <section v-show="view === 'build'">
      <div class="setup">
        <div class="frow">
          <label class="fld grow"><span>案件</span><input v-model="project" maxlength="500" placeholder="例：新支社オフィスのITインフラ構築" /></label>
          <label class="fld"><span>開始</span><input type="date" v-model="startDate" /></label>
          <label class="fld"><span>完了希望</span><input type="date" v-model="dueDate" /></label>
          <div class="fld span-box" :class="spanInfo.cls">
            <span>期間</span>
            <div class="span-val">{{ spanInfo.text }}</div>
          </div>
        </div>
        <PastReference v-model="pasts" />
        <div class="actions">
          <button class="build" @click="build">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
            スケジュールを構築
          </button>
          <label class="opt"><input type="checkbox" v-model="baseOnPast" /><span>取り込んだ工程表を土台に詳細化（再スケジュール）</span></label>
          <span class="mode" :class="{ live: runMode === 'server' }">{{ modeText }}</span>
        </div>
      </div>

      <Orchestration
        ref="orch"
        :pasts="pasts"
        :config="config"
        :client="client"
        :project="project"
        :base-on-past="baseOnPast"
        @edit="onEdit"
      />
    </section>

    <!-- 編集ビュー -->
    <section v-if="view === 'edit'">
      <div class="ebar">
        <button class="back" @click="view = 'build'">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          構築に戻る
        </button>
        <div class="exp">
          <span class="exp-lb">書き出し</span>
          <button @click="exportXlsx"><span class="xi xi-x">X</span>Excel</button>
          <button @click="exportCsv"><span class="xi xi-c">,</span>CSV</button>
          <button @click="exportJson"><span class="xi xi-j">{ }</span>JSON</button>
        </div>
      </div>
      <p class="lead">
        AIのたたき台を、人がドラッグ・追加・状態変更で手直しして確定します。<b>AIは案、確定は人</b>。完了予定が締切を超えると、その場で警告します。
      </p>
      <GanttEditor v-model="result" :config="config" :editable="true" />
    </section>
  </main>

  <footer class="foot">
    <span>サーバーなし・データは端末内のみ</span>
    <span class="dv">·</span>
    <span>AIとつながるのは <code>LLMClient</code> の1か所だけ（デモ／本物を差し替え）</span>
    <span class="dv">·</span>
    <span>APIキーはサーバー側のみ・ブラウザには出しません</span>
  </footer>
</template>

<style scoped>
/* ===== ヘッダー ===== */
.app {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: saturate(1.4) blur(10px);
  border-bottom: 1px solid var(--line);
}
.hbar {
  max-width: 1160px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 22px;
  flex-wrap: wrap;
}
.logo { display: flex; align-items: center; gap: 11px; }
.logo .mk {
  width: 34px; height: 34px; border-radius: 10px; flex: none;
  background: var(--brand-grad); display: grid; place-items: center;
  box-shadow: 0 4px 12px var(--brand-ring);
}
.logo-t { display: flex; flex-direction: column; line-height: 1.25; }
.logo-t .nm { font-weight: 800; font-size: 16px; letter-spacing: 0.01em; color: var(--ink); }
.logo-t .sub { font-size: 11.5px; color: var(--ink-3); font-weight: 600; }
.hmeta { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.mode-pill {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 11.5px; font-weight: 800; padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--line);
}
.mode-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
.mode-pill.live { color: var(--ok); background: var(--ok-bg); border-color: #bfe6d3; }
.mode-pill.live .dot { background: var(--ok); box-shadow: 0 0 0 0 rgba(23,130,90,0.5); animation: pulse 1.8s infinite; }
.mode-pill.demo { color: var(--warn); background: var(--warn-bg); border-color: #f0dcb2; }
.mode-pill.demo .dot { background: var(--warn); }
.mode-pill.idle { color: var(--ink-3); background: var(--panel-2); }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(23,130,90,0.45); } 70% { box-shadow: 0 0 0 6px rgba(23,130,90,0); } 100% { box-shadow: 0 0 0 0 rgba(23,130,90,0); } }
.tag-demo { font-size: 10.5px; font-weight: 700; color: var(--ink-3); border: 1px dashed var(--line); border-radius: 6px; padding: 3px 8px; }

main { max-width: 1160px; margin: 0 auto; padding: 22px 22px 48px; }

/* ===== 設定カード ===== */
.setup {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 18px 20px;
  margin-bottom: 18px;
  box-shadow: var(--shadow);
}
.frow { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 4px; }
.fld { display: flex; flex-direction: column; gap: 5px; }
.fld > span { font-size: 11px; color: var(--ink-3); font-weight: 800; letter-spacing: 0.02em; }
.fld input {
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 9px 12px; font-size: 13.5px; font-family: inherit; color: var(--ink);
  background: var(--panel); transition: border-color 0.15s, box-shadow 0.15s;
}
.fld input:hover { border-color: #cfd7e6; }
.fld input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
.fld.grow { flex: 1; min-width: 260px; }
.span-box { justify-content: flex-end; }
.span-val {
  font-size: 12.5px; font-weight: 800; border-radius: var(--r-sm);
  padding: 9px 12px; white-space: nowrap;
}
.span-box.ok .span-val { color: var(--brand-strong); background: var(--brand-bg); }
.span-box.warn .span-val { color: var(--deny); background: var(--deny-bg); }

.actions { display: flex; align-items: center; gap: 16px; margin-top: 16px; flex-wrap: wrap; }
.build {
  display: inline-flex; align-items: center; gap: 9px;
  border: none; background: var(--brand-grad); color: #fff;
  font-weight: 800; font-size: 15px; padding: 12px 26px; border-radius: var(--r);
  cursor: pointer; box-shadow: 0 8px 20px var(--brand-ring);
  transition: transform 0.15s var(--ease), box-shadow 0.15s, filter 0.15s;
}
.build:hover { transform: translateY(-1px); box-shadow: 0 12px 26px var(--brand-ring); filter: brightness(1.04); }
.build:active { transform: translateY(0); }
.opt { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-2); font-weight: 600; cursor: pointer; }
.opt input { width: 16px; height: 16px; accent-color: var(--brand); }
.mode { font-size: 12px; color: var(--ink-3); font-weight: 600; margin-left: auto; }
.mode.live { color: var(--ok); font-weight: 800; }

/* ===== 編集ビュー バー ===== */
.ebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.back {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  font-weight: 700; font-size: 13px; padding: 9px 16px; border-radius: var(--r-sm); cursor: pointer;
  box-shadow: var(--shadow-sm); transition: border-color 0.15s, color 0.15s;
}
.back:hover { border-color: var(--brand); color: var(--brand); }
.exp { display: flex; gap: 8px; align-items: center; }
.exp-lb { font-size: 11px; font-weight: 800; color: var(--ink-3); margin-right: 2px; }
.exp button {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  font-weight: 700; font-size: 12.5px; padding: 8px 14px; border-radius: var(--r-sm); cursor: pointer;
  box-shadow: var(--shadow-sm); transition: border-color 0.15s, color 0.15s, transform 0.12s;
}
.exp button:hover { border-color: var(--brand); color: var(--brand); transform: translateY(-1px); }
.xi { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; font-size: 9.5px; font-weight: 900; color: #fff; }
.xi-x { background: #1d7044; }
.xi-c { background: #6d7cff; }
.xi-j { background: #7a57a2; font-size: 8.5px; }
.lead { color: var(--ink-2); font-size: 13px; margin: 0 0 16px; }
.lead b { color: var(--ink); }

/* ===== フッター ===== */
.foot {
  max-width: 1160px; margin: 0 auto; padding: 20px 22px 42px;
  color: var(--ink-3); font-size: 11.5px; border-top: 1px solid var(--line-2);
  display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
}
.foot code { font-family: var(--mono); background: var(--bg-2); padding: 1px 6px; border-radius: 5px; color: var(--ink-2); }
.foot .dv { color: var(--line); }

@media (max-width: 720px) {
  .mode { margin-left: 0; }
}
</style>
