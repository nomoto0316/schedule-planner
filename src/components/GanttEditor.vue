<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Task, PlanConfig, Status } from "../types";
import { STATUS, PROGRESS } from "../types";
import { newTask } from "../data/demo";

const tasks = defineModel<Task[]>({ required: true });
const props = defineProps<{ config: PlanConfig; editable?: boolean }>();
const canEdit = computed(() => props.editable !== false);

const DW = 24; // 1日の幅(px)
const LW = 500; // タスク名カラムの幅(px)

// 進捗率は手動設定を正とする。未設定のタスクは status から初期値を一度だけ補完し、
// 以後は status を変えても進捗は動かない（＝手動管理）。待ち(ghost)は対象外。
watch(
  tasks,
  (list) => {
    for (const t of list) {
      if (!t.ghost && typeof t.progress !== "number") t.progress = Math.round(PROGRESS[t.status] * 100);
    }
  },
  { immediate: true, deep: true }
);

/** タスクの実効進捗（0-1）。手動値があればそれ、無ければ status 由来。待ちは0 */
function effProg(t: Task): number {
  if (t.ghost) return 0;
  return typeof t.progress === "number" ? Math.min(1, Math.max(0, t.progress / 100)) : PROGRESS[t.status];
}
const statusKeys = Object.keys(STATUS) as (keyof typeof STATUS)[];

const start = computed(() => new Date(props.config.startDate));
const timelineW = computed(() => props.config.deadline * DW);

function dlabel(i: number): string {
  const d = new Date(start.value);
  d.setDate(d.getDate() + i);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const weekTicks = computed(() => {
  const arr: number[] = [];
  for (let i = 0; i <= props.config.deadline; i += 7) arr.push(i);
  return arr;
});

/** 終了日（最終作業日 = 開始 + 期間 - 1）のインデックス */
function endDay(t: Task): number {
  return t.start + t.dur - 1;
}

// ==== 日付ピッカー（1つのカレンダーで From→To を範囲選択）====
/** 開始日からのインデックス → Date */
function idxToDate(i: number): Date {
  const d = new Date(props.config.startDate + "T00:00:00");
  d.setDate(d.getDate() + i);
  return d;
}
/** Date → 開始日からのインデックス */
function dateToIdx(d: Date): number {
  const a = new Date(props.config.startDate + "T00:00:00").getTime();
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - a) / 86400000);
}

const pickerId = ref<string | null>(null);
const pickerPos = ref<{ top: number; left: number }>({ top: 0, left: 0 });
const editingTask = computed(() => tasks.value.find((t) => t.id === pickerId.value) || null);

// 範囲選択の状態（idx = 開始日からの日数）
const pendingStart = ref(0);
const pendingEnd = ref<number | null>(null); // null = 終了未確定（クリック待ち）
const hoverIdx = ref<number | null>(null);
const viewMonth = ref<Date>(new Date());

function openPicker(t: Task, ev: MouseEvent) {
  if (!canEdit.value) return;
  if (pickerId.value === t.id) {
    pickerId.value = null;
    return;
  }
  const el = ev.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  const W = 288;
  const POP_H = 430; // ポップオーバー概算高さ
  let left = r.left;
  if (left + W > window.innerWidth - 12) left = window.innerWidth - W - 12;
  // 下に十分な余白が無ければ上に出す（画面外にはみ出さないように）
  let top = r.bottom + 6;
  if (top + POP_H > window.innerHeight - 12) top = Math.max(12, r.top - POP_H - 6);
  pickerPos.value = { top, left: Math.max(12, left) };
  pickerId.value = t.id;
  // 現在のタスク期間を初期選択として表示
  pendingStart.value = t.start;
  pendingEnd.value = endDay(t);
  hoverIdx.value = null;
  const d = idxToDate(t.start);
  viewMonth.value = new Date(d.getFullYear(), d.getMonth(), 1);
  // スクロール／リサイズで位置がずれるため閉じる（重複登録を避けて張り直す）
  window.removeEventListener("scroll", closePicker, true);
  window.removeEventListener("resize", closePicker);
  window.addEventListener("scroll", closePicker, true);
  window.addEventListener("resize", closePicker);
}
function closePicker() {
  pickerId.value = null;
  window.removeEventListener("scroll", closePicker, true);
  window.removeEventListener("resize", closePicker);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const monthLabel = computed(() => `${viewMonth.value.getFullYear()}年 ${viewMonth.value.getMonth() + 1}月`);

interface Cell { date: Date; idx: number; day: number; otherMonth: boolean; disabled: boolean; wd: number }
const calCells = computed<Cell[]>(() => {
  const first = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth(), 1);
  const startWd = first.getDay();
  const cells: Cell[] = [];
  for (let k = 0; k < 42; k++) {
    const date = new Date(first.getFullYear(), first.getMonth(), 1 - startWd + k);
    const idx = dateToIdx(date);
    cells.push({
      date,
      idx,
      day: date.getDate(),
      otherMonth: date.getMonth() !== viewMonth.value.getMonth(),
      disabled: idx < 0, // 計画開始日より前は選べない
      wd: date.getDay(),
    });
  }
  return cells;
});

/** セルが選択範囲のどこに当たるか（開始・終了・途中）。終了未確定時は hover をプレビュー端点に使う */
function cellRange(idx: number): { s: boolean; e: boolean; mid: boolean } {
  let s = pendingStart.value;
  let e = pendingEnd.value;
  if (e === null) {
    const h = hoverIdx.value !== null ? hoverIdx.value : pendingStart.value;
    s = Math.min(pendingStart.value, h);
    e = Math.max(pendingStart.value, h);
  }
  return { s: idx === s, e: idx === e, mid: idx > s && idx < e };
}

function clickDay(c: Cell) {
  if (c.disabled) return;
  if (pendingEnd.value === null) {
    // 2クリック目：終了を確定（開始より前なら開始をやり直し）
    if (c.idx >= pendingStart.value) {
      pendingEnd.value = c.idx;
      commitRange();
    } else {
      pendingStart.value = c.idx;
    }
  } else {
    // 新しい範囲を開始（1クリック目）
    pendingStart.value = c.idx;
    pendingEnd.value = null;
    hoverIdx.value = c.idx;
  }
}
function commitRange() {
  const t = editingTask.value;
  if (!t || pendingEnd.value === null) return;
  t.start = Math.max(0, pendingStart.value);
  t.dur = Math.max(1, pendingEnd.value - pendingStart.value + 1);
}
function shiftMonth(n: number) {
  viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + n, 1);
}

// ポップオーバー内の表示用
const selFromLabel = computed(() => dlabel(pendingStart.value));
const selToLabel = computed(() => (pendingEnd.value === null ? "終了日を選択…" : dlabel(pendingEnd.value)));
const selDur = computed(() => {
  const e = pendingEnd.value === null ? pendingStart.value : pendingEnd.value;
  return Math.max(1, e - pendingStart.value + 1);
});
const selecting = computed(() => pendingEnd.value === null);

function progOf(t: Task): number {
  return effProg(t);
}
/** タスク単体の進捗率(%)。待ち(ghost)は作業でないため対象外 */
function taskPct(t: Task): number {
  return Math.round(effProg(t) * 100);
}

// 進捗バーをクリック／ドラッグして手動で進捗率を設定（5%刻み）
function setRateFromEvent(t: Task, trackEl: HTMLElement, clientX: number) {
  const r = trackEl.getBoundingClientRect();
  let pct = ((clientX - r.left) / r.width) * 100;
  pct = Math.round(pct / 5) * 5; // 5%刻みにスナップ
  const p = Math.min(100, Math.max(0, pct));
  t.progress = p;
  // 進捗に応じて状態を自動更新（0%=未対応 / 途中=処理中 / 100%=処理済み）
  t.status = p >= 100 ? "review" : p > 0 ? "doing" : "todo";
}
function onRateDown(e: PointerEvent, t: Task) {
  if (!canEdit.value || t.ghost) return;
  e.preventDefault();
  e.stopPropagation();
  const track = e.currentTarget as HTMLElement;
  setRateFromEvent(t, track, e.clientX);
  const mv = (ev: PointerEvent) => setRateFromEvent(t, track, ev.clientX);
  const up = () => {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
}
function barStyle(t: Task) {
  return {
    left: t.start * DW + "px",
    width: Math.max(t.dur * DW, 8) + "px",
    // バー色＝状態（凡例と一致）。待ちは縞（class）、クリティカルは赤枠（class）で示す。
    background: t.ghost ? undefined : STATUS[t.status].color,
  };
}

// 完了予定・予備日の判定
const verdict = computed(() => {
  if (!tasks.value.length) return null;
  const end = Math.max(...tasks.value.map((t) => t.start + t.dur));
  const slack = props.config.deadline - end;
  if (end > props.config.deadline)
    return { cls: "over", text: `⚠ 完了 ${dlabel(end)} が締切 ${dlabel(props.config.deadline)} を ${end - props.config.deadline}日 超過` };
  if (slack < 3)
    return { cls: "tight", text: `⚠ 完了 ${dlabel(end)} ・ 締切 ${dlabel(props.config.deadline)} に対し予備 ${slack}日（ほぼゼロ）` };
  return { cls: "ok", text: `✓ 完了 ${dlabel(end)} ・ 締切 ${dlabel(props.config.deadline)} に対し予備 ${slack}日` };
});
defineExpose({ verdict });

// 全体進捗（待ち=ghost は作業でないため除外し、所要日数で加重平均）
const overall = computed(() => {
  const list = tasks.value;
  const work = list.filter((t) => !t.ghost);
  const totalDur = work.reduce((a, t) => a + t.dur, 0);
  const pct = totalDur > 0 ? Math.round((work.reduce((a, t) => a + t.dur * effProg(t), 0) / totalDur) * 100) : 0;
  const counts: Record<Status, number> = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const t of list) counts[t.status]++;
  return { pct, counts, total: list.length };
});

// バーのドラッグ（移動・伸縮）
function onBarDown(e: PointerEvent, t: Task, mode: "move" | "resize") {
  if (!canEdit.value) return;
  e.preventDefault();
  const x0 = e.clientX;
  const s0 = t.start;
  const d0 = t.dur;
  const mv = (ev: PointerEvent) => {
    const dd = Math.round((ev.clientX - x0) / DW);
    if (mode === "move") t.start = Math.max(0, s0 + dd);
    else t.dur = Math.max(1, d0 + dd);
  };
  const up = () => {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
}

// ドラッグ&ドロップで並べ替え
const dragId = ref<string | null>(null);
const overId = ref<string | null>(null);
function onDrop(target: Task) {
  const src = dragId.value;
  overId.value = null;
  if (!src || src === target.id) return;
  const list = tasks.value;
  const i = list.findIndex((t) => t.id === src);
  const j = list.findIndex((t) => t.id === target.id);
  if (i < 0 || j < 0) return;
  const [moved] = list.splice(i, 1);
  list.splice(j, 0, moved);
  dragId.value = null;
}

function addTask() {
  tasks.value.push(newTask(props.config.today, props.config.deadline));
}
function delTask(t: Task) {
  const i = tasks.value.findIndex((x) => x.id === t.id);
  if (i >= 0) tasks.value.splice(i, 1);
}
</script>

<template>
  <div class="gantt-wrap">
    <div v-if="verdict" class="verdict" :class="verdict.cls" v-html="verdict.text"></div>

    <!-- 全体進捗バー -->
    <div v-if="tasks.length" class="pbar">
      <div class="pbar-top">
        <span class="pbar-lb">全体の進捗</span>
        <span class="pbar-pct">{{ overall.pct }}<small>%</small></span>
        <span class="pbar-sub">全 {{ overall.total }} タスク</span>
        <div class="pbar-counts">
          <span class="pc todo">未対応 {{ overall.counts.todo }}</span>
          <span class="pc doing">処理中 {{ overall.counts.doing }}</span>
          <span class="pc review">処理済み {{ overall.counts.review }}</span>
          <span class="pc done">完了 {{ overall.counts.done }}</span>
        </div>
      </div>
      <div class="pbar-track"><div class="pbar-fill" :style="{ width: overall.pct + '%' }"></div></div>
    </div>

    <div class="gvscroll">
      <div class="gchart">
        <!-- ヘッダ（日付軸） -->
        <div class="ghead">
          <div class="glabelhead" :style="{ width: LW + 'px' }">タスク（{{ canEdit ? "≡順番・" : "" }}開始／終了・状態・進捗・名前）</div>
          <div class="gtimehead" :style="{ width: timelineW + 'px' }">
            <span v-for="i in weekTicks" :key="i" class="wk" :style="{ left: i * DW + 'px' }">{{ dlabel(i) }}</span>
          </div>
        </div>

        <!-- 各タスク行 -->
        <div class="grows">
          <div
            v-for="t in tasks"
            :key="t.id"
            class="grow"
            :class="{ over: overId === t.id, drag: dragId === t.id }"
            @dragover.prevent="canEdit && (overId = t.id)"
            @dragleave="overId = null"
            @drop.prevent="canEdit && onDrop(t)"
          >
            <div class="glabel" :style="{ width: LW + 'px' }">
              <span
                v-if="canEdit"
                class="grip"
                draggable="true"
                title="ドラッグで順番変更"
                @dragstart="dragId = t.id"
                @dragend="dragId = null"
                >≡</span
              >
              <button v-if="canEdit" class="gdel" title="削除" @click="delTask(t)">×</button>
              <button
                v-if="canEdit"
                class="gdate-btn"
                :class="{ open: pickerId === t.id }"
                title="クリックでカレンダーから開始日・終了日を設定"
                @click.stop="openPicker(t, $event)"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></svg>
                <span class="gdate">{{ dlabel(t.start) }}</span>
                <span class="gdate-sep">〜</span>
                <span class="gdate">{{ dlabel(endDay(t)) }}</span>
              </button>
              <template v-else>
                <span class="gdate" title="開始日">{{ dlabel(t.start) }}</span>
                <span class="gdate-sep">〜</span>
                <span class="gdate" title="終了日">{{ dlabel(endDay(t)) }}</span>
              </template>
              <select class="gstat" :class="t.status" v-model="t.status" :disabled="!canEdit">
                <option v-for="k in statusKeys" :key="k" :value="k">{{ STATUS[k].label }}</option>
              </select>
              <span class="grate" :class="{ ghost: t.ghost, editable: canEdit && !t.ghost }" :title="t.ghost ? '待ち（納品・工事など）' : 'クリック／ドラッグで進捗率を設定'">
                <span class="grate-track" @pointerdown="onRateDown($event, t)">
                  <span class="grate-fill" :class="t.status" :style="{ width: taskPct(t) + '%' }"></span>
                  <span v-if="canEdit && !t.ghost" class="grate-knob" :style="{ left: taskPct(t) + '%' }"></span>
                </span>
                <span class="grate-pct">{{ t.ghost ? "待ち" : taskPct(t) + "%" }}</span>
              </span>
              <input v-model="t.name" :readonly="!canEdit" />
            </div>
            <div class="gtime" :style="{ width: timelineW + 'px' }">
              <div class="gbar" :class="{ crit: t.crit, ghost: t.ghost, ro: !canEdit }" :style="barStyle(t)" :title="t.ref || ''" @pointerdown="onBarDown($event, t, 'move')">
                <div v-if="progOf(t) > 0" class="gprog" :style="{ width: progOf(t) * 100 + '%' }"></div>
                <span class="gbarlabel">{{ t.dur }}日</span>
                <div v-if="canEdit" class="ghandle" @pointerdown.stop="onBarDown($event, t, 'resize')"></div>
              </div>
            </div>
          </div>

          <!-- 今日・締切ライン -->
          <div class="gline today" :style="{ left: LW + config.today * DW + 'px' }"><span class="tag">今日</span></div>
          <div class="gline dead" :style="{ left: LW + config.deadline * DW + 'px' }"><span class="tag">締切</span></div>
        </div>
      </div>
    </div>

    <div v-if="canEdit" class="gaddrow">
      <button class="add" @click="addTask">＋ タスクを追加</button>
    </div>

    <div class="legend">
      <span><i style="background: var(--todo)"></i>未対応</span>
      <span><i style="background: var(--doing)"></i>処理中</span>
      <span><i style="background: var(--review)"></i>処理済み</span>
      <span><i style="background: var(--done)"></i>完了</span>
      <span><i style="background: var(--bar-ghost)"></i>待ち</span>
      <span><i style="border: 2px solid var(--bar-crit); width: 12px; height: 8px"></i>クリティカル</span>
      <span class="hint">日付をクリックでカレンダー・≡をドラッグで順番・バーをドラッグで期間・状態を選択</span>
    </div>

    <!-- 日付ピッカー（From-To をカレンダーで指定） -->
    <teleport to="body">
      <div v-if="pickerId && editingTask" class="pk-backdrop" @click="closePicker"></div>
      <div v-if="pickerId && editingTask" class="pk-pop" :style="{ top: pickerPos.top + 'px', left: pickerPos.left + 'px' }" @click.stop>
        <div class="pk-head">
          <span class="pk-name">{{ editingTask.name || "タスク" }}</span>
          <button class="pk-x" title="閉じる" @click="closePicker">×</button>
        </div>

        <!-- 選択中の範囲サマリ -->
        <div class="pk-range">
          <span class="pk-chip from">{{ selFromLabel }}</span>
          <span class="pk-arrow">→</span>
          <span class="pk-chip to" :class="{ waiting: selecting }">{{ selToLabel }}</span>
          <span class="pk-dur">{{ selDur }}日</span>
        </div>
        <p class="pk-hint">{{ selecting ? "終了日をクリックしてください" : "開始日をクリックすると範囲を選び直せます" }}</p>

        <!-- 月ナビ -->
        <div class="pk-nav">
          <button class="pk-mv" title="前の月" @click="shiftMonth(-1)">‹</button>
          <span class="pk-month">{{ monthLabel }}</span>
          <button class="pk-mv" title="次の月" @click="shiftMonth(1)">›</button>
        </div>

        <!-- カレンダー -->
        <div class="pk-cal" @mouseleave="hoverIdx = null">
          <div class="pk-wd" v-for="(w, i) in WEEKDAYS" :key="'w' + i" :class="{ sun: i === 0, sat: i === 6 }">{{ w }}</div>
          <button
            v-for="(c, i) in calCells"
            :key="'d' + i"
            class="pk-day"
            :class="{
              other: c.otherMonth,
              disabled: c.disabled,
              sun: c.wd === 0,
              sat: c.wd === 6,
              s: cellRange(c.idx).s,
              e: cellRange(c.idx).e,
              mid: cellRange(c.idx).mid,
            }"
            :disabled="c.disabled"
            @click="clickDay(c)"
            @mouseenter="selecting && (hoverIdx = c.idx)"
          >{{ c.day }}</button>
        </div>

        <div class="pk-foot"><button class="pk-ok" @click="closePicker">完了</button></div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.gantt-wrap {
  font-size: 13px;
}
.verdict {
  border-radius: 9px;
  padding: 10px 13px;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 12px;
}
.verdict.ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.verdict.tight {
  background: var(--warn-bg);
  color: #7a5a10;
}
.verdict.over {
  background: var(--deny-bg);
  color: var(--deny);
}

/* ===== 全体進捗バー ===== */
.pbar {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 11px 14px;
  margin-bottom: 12px;
  box-shadow: var(--shadow-sm);
}
.pbar-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.pbar-lb {
  font-size: 12px;
  font-weight: 800;
  color: var(--ink-2);
}
.pbar-pct {
  font-size: 19px;
  font-weight: 800;
  color: var(--doing);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.pbar-pct small {
  font-size: 12px;
  font-weight: 800;
  margin-left: 1px;
}
.pbar-sub {
  font-size: 11.5px;
  color: var(--ink-3);
  font-weight: 700;
}
.pbar-counts {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pc {
  font-size: 10.5px;
  font-weight: 800;
  border-radius: 999px;
  padding: 2px 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pc::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.pc.todo { color: var(--todo); background: color-mix(in srgb, var(--todo) 12%, #fff); }
.pc.todo::before { background: var(--todo); }
.pc.doing { color: var(--doing); background: color-mix(in srgb, var(--doing) 12%, #fff); }
.pc.doing::before { background: var(--doing); }
.pc.review { color: var(--review); background: color-mix(in srgb, var(--review) 12%, #fff); }
.pc.review::before { background: var(--review); }
.pc.done { color: var(--done); background: color-mix(in srgb, var(--done) 12%, #fff); }
.pc.done::before { background: var(--done); }
.pbar-track {
  height: 10px;
  background: var(--line-2);
  border-radius: 999px;
  overflow: hidden;
}
.pbar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #38b26f, var(--doing));
  transition: width 0.45s var(--ease);
  min-width: 0;
}
.gvscroll {
  overflow-x: auto;
}
.gchart {
  border: 1px solid var(--line);
  border-radius: 8px;
  display: inline-block;
  min-width: 100%;
  background: var(--panel);
}
.ghead {
  display: flex;
  border-bottom: 1px solid #cdd3f2;
  background: linear-gradient(180deg, var(--brand-bg), #e4e7ff);
}
.glabelhead {
  flex: none;
  padding: 8px 12px;
  font-weight: 800;
  color: var(--brand-strong);
  font-size: 11px;
}
.gtimehead {
  position: relative;
  flex: none;
  height: 30px;
}
.wk {
  position: absolute;
  top: 8px;
  font-size: 10px;
  color: var(--brand-strong);
  font-weight: 700;
  transform: translateX(-50%);
  white-space: nowrap;
}
.grows {
  position: relative;
}
.grow {
  display: flex;
  border-bottom: 1px solid var(--line-2);
  height: 42px;
  align-items: center;
  background: var(--panel);
}
.grow:last-child {
  border-bottom: none;
}
.grow:nth-of-type(even) {
  background: #f7f9fc;
}
.grow:hover {
  background: var(--brand-bg);
}
.grow.drag {
  opacity: 0.4;
}
.grow.over {
  box-shadow: inset 0 2px 0 var(--brand);
}
.glabel {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
}
.grip {
  cursor: grab;
  color: var(--ink-3);
  font-size: 14px;
  flex: none;
  user-select: none;
}
.grip:active {
  cursor: grabbing;
}
.gdel {
  border: none;
  background: none;
  color: var(--ink-3);
  cursor: pointer;
  font-size: 15px;
  flex: none;
  padding: 0 2px;
}
.gdel:hover {
  color: var(--deny);
}
.gdate {
  flex: none;
  text-align: center;
  font-size: 10.5px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.gdate-sep {
  flex: none;
  color: var(--ink-3);
  font-size: 10px;
}
/* クリックでカレンダーを開く日付ボタン（編集ビュー） */
.gdate-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  border: 1px solid transparent;
  background: none;
  border-radius: 6px;
  padding: 3px 6px;
  cursor: pointer;
  color: var(--ink-2);
  font-family: inherit;
  transition: background 0.12s, border-color 0.12s;
}
.gdate-btn svg { color: var(--ink-3); flex: none; }
.gdate-btn:hover { background: var(--brand-bg); border-color: #cdd3f2; }
.gdate-btn:hover svg { color: var(--brand); }
.gdate-btn.open { background: var(--brand-bg); border-color: var(--brand); }
.gdate-btn.open svg { color: var(--brand); }
.gstat {
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 11px;
  padding: 3px 4px;
  flex: none;
  font-family: inherit;
  font-weight: 700;
}
.gstat.todo {
  color: var(--todo);
}
.gstat.doing {
  color: var(--doing);
}
.gstat.review {
  color: var(--review);
}
.gstat.done {
  color: var(--done);
}
/* タスク単体の進捗バー */
.grate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.grate-track {
  position: relative;
  width: 60px;
  height: 8px;
  background: var(--line-2);
  border-radius: 999px;
}
.grate.editable .grate-track {
  cursor: pointer;
}
.grate.editable .grate-track:hover {
  box-shadow: 0 0 0 2px var(--brand-ring);
}
.grate-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.15s var(--ease);
  pointer-events: none;
}
.grate-fill.todo { background: var(--todo); }
.grate-fill.doing { background: var(--doing); }
.grate-fill.review { background: var(--review); }
.grate-fill.done { background: var(--done); }
.grate-knob {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--brand);
  transform: translate(-50%, -50%);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
  transition: left 0.15s var(--ease);
}
.grate-pct {
  font-size: 10.5px;
  font-weight: 800;
  color: var(--ink-2);
  width: 30px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.grate.ghost .grate-track { opacity: 0.5; }
.grate.ghost .grate-pct { color: var(--ink-3); font-weight: 700; }
.glabel input {
  border: 1px solid transparent;
  background: none;
  font-size: 12.5px;
  flex: 1;
  min-width: 0;
  border-radius: 5px;
  padding: 4px 6px;
  font-family: inherit;
  color: var(--ink);
}
.glabel input:hover {
  border-color: var(--line);
  background: #fff;
}
.glabel input:focus {
  border-color: var(--brand);
  outline: none;
  background: #fff;
}
.gtime {
  position: relative;
  flex: none;
  height: 42px;
}
.gbar {
  position: absolute;
  top: 11px;
  height: 20px;
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
  box-shadow: 0 1px 2px rgba(20, 30, 50, 0.12);
  cursor: grab;
}
.gbar:active {
  cursor: grabbing;
}
.gbar.ro {
  cursor: default;
}
.gbar.crit {
  outline: 2px solid var(--bar-crit);
  outline-offset: 1px;
}
.gbar.ghost {
  background: repeating-linear-gradient(45deg, #c9d3df, #c9d3df 5px, #e6ebf1 5px, #e6ebf1 10px);
}
.gbar.ghost .gbarlabel {
  color: #35414f;
  text-shadow: none;
}
.gprog {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.45);
  border-right: 2px solid rgba(0, 0, 0, 0.18);
}
.gbarlabel {
  position: absolute;
  left: 7px;
  top: 2px;
  font-size: 10.5px;
  color: #fff;
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
  font-weight: 600;
}
.ghandle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 9px;
  cursor: ew-resize;
  background: rgba(0, 0, 0, 0.14);
}
.gline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1.5px dashed;
  z-index: 2;
  pointer-events: none;
}
.gline.today {
  border-color: var(--ok);
}
.gline.dead {
  border-color: var(--deny);
}
.gline .tag {
  position: absolute;
  top: -1px;
  left: 3px;
  font-size: 9.5px;
  font-weight: 700;
  white-space: nowrap;
}
.gline.today .tag {
  color: var(--ok);
}
.gline.dead .tag {
  color: var(--deny);
}
.gaddrow {
  margin-top: 12px;
}
.add {
  border: 1px dashed var(--line);
  background: var(--bg);
  color: var(--ink-2);
  border-radius: 8px;
  padding: 7px 15px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.add:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.legend {
  display: flex;
  gap: 16px;
  font-size: 11.5px;
  color: var(--ink-2);
  padding: 12px 2px 2px;
  flex-wrap: wrap;
  align-items: center;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend i {
  width: 14px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.legend .hint {
  color: var(--ink-3);
}

/* ===== 日付ピッカー ポップオーバー ===== */
.pk-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: transparent;
}
.pk-pop {
  position: fixed;
  z-index: 41;
  width: 288px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow-lg);
  padding: 12px 13px;
  animation: pkin 0.14s ease;
}
@keyframes pkin {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.pk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.pk-name {
  font-size: 12px;
  font-weight: 800;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pk-x {
  flex: none;
  border: none;
  background: none;
  color: var(--ink-3);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.pk-x:hover { color: var(--deny); }

/* 選択範囲サマリ */
.pk-range {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
}
.pk-chip {
  font-size: 12px;
  font-weight: 800;
  border-radius: 7px;
  padding: 4px 9px;
  font-variant-numeric: tabular-nums;
}
.pk-chip.from { color: var(--brand-strong); background: var(--brand-bg); }
.pk-chip.to { color: var(--ok); background: var(--ok-bg); }
.pk-chip.to.waiting { color: var(--ink-3); background: var(--bg-2); font-weight: 700; font-size: 10.5px; }
.pk-arrow { color: var(--ink-3); font-weight: 700; }
.pk-dur {
  margin-left: auto;
  font-size: 11px;
  font-weight: 800;
  color: var(--ink-2);
  background: var(--line-2);
  border-radius: 999px;
  padding: 3px 9px;
}
.pk-hint { margin: 0 0 10px; font-size: 10.5px; color: var(--ink-3); }

/* 月ナビ */
.pk-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.pk-month { font-size: 12.5px; font-weight: 800; color: var(--ink); }
.pk-mv {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: var(--r-sm);
  font-size: 16px;
  line-height: 1;
  color: var(--ink-2);
  cursor: pointer;
}
.pk-mv:hover { border-color: var(--brand); color: var(--brand); }

/* カレンダー本体 */
.pk-cal {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.pk-wd {
  text-align: center;
  font-size: 10px;
  font-weight: 800;
  color: var(--ink-3);
  padding: 2px 0 4px;
}
.pk-wd.sun { color: #c0392b; }
.pk-wd.sat { color: #2f6df0; }
.pk-day {
  border: none;
  background: none;
  aspect-ratio: 1 / 1;
  border-radius: 7px;
  font-size: 12px;
  font-family: inherit;
  color: var(--ink);
  cursor: pointer;
  padding: 0;
  transition: background 0.1s;
}
.pk-day:hover:not(.disabled) { background: var(--brand-bg); }
.pk-day.other { color: var(--ink-3); opacity: 0.5; }
.pk-day.sun:not(.other) { color: #c0392b; }
.pk-day.sat:not(.other) { color: #2f6df0; }
.pk-day.disabled { color: var(--line); cursor: not-allowed; opacity: 0.6; }
.pk-day.mid { background: var(--brand-bg); border-radius: 0; color: var(--brand-strong); }
.pk-day.s { background: var(--brand); color: #fff; border-radius: 7px 0 0 7px; }
.pk-day.e { background: var(--brand); color: #fff; border-radius: 0 7px 7px 0; }
.pk-day.s.e { border-radius: 7px; }
.pk-day.s:hover, .pk-day.e:hover { background: var(--brand-strong); }

.pk-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.pk-ok {
  border: none;
  background: var(--brand-grad);
  color: #fff;
  font-weight: 800;
  font-size: 12px;
  padding: 7px 18px;
  border-radius: var(--r-sm);
  cursor: pointer;
}
.pk-ok:hover { filter: brightness(1.05); }
</style>
