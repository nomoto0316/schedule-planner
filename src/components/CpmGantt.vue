<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from "vue";
import Gantt from "frappe-gantt";
import "../../node_modules/frappe-gantt/dist/frappe-gantt.css";
import type { PlanTask, PlanConfig } from "../types";
import { STATUS, PROGRESS } from "../types";
import { computeCpm } from "../cpm";

const tasks = defineModel<PlanTask[]>({ required: true });
const props = defineProps<{ config: PlanConfig }>();

const statusKeys = Object.keys(STATUS) as (keyof typeof STATUS)[];
const baseDate = computed(() => new Date(props.config.startDate));

function isoAfter(days: number): string {
  const d = new Date(baseDate.value);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function jp(days: number): string {
  const d = new Date(baseDate.value);
  d.setDate(d.getDate() + days);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// CPM計算（tasks が変わるたび再計算）
const result = computed(() =>
  computeCpm(tasks.value.map((t) => ({ id: t.id, name: t.name, effort: t.effort, deps: t.deps })))
);
const nameOf = (id: string) => tasks.value.find((t) => t.id === id)?.name || id;
const criticalNames = computed(() => result.value.criticalPath.map(nameOf).join(" → "));
const overDeadline = computed(() => result.value.projectEnd > props.config.deadline);
const slack = computed(() => props.config.deadline - result.value.projectEnd);

// frappe-gantt 用タスク
function ganttTasks() {
  return tasks.value.map((t) => {
    const c = result.value.calc.get(t.id)!;
    return {
      id: t.id,
      name: t.name,
      start: isoAfter(c.es),
      end: isoAfter(Math.max(c.ef - 1, c.es)),
      progress: Math.round(PROGRESS[t.status] * 100),
      dependencies: t.deps.join(","),
      custom_class: c.critical ? "bar-crit" : "",
    };
  });
}

const ganttEl = ref<HTMLDivElement | null>(null);
function render() {
  if (!ganttEl.value) return;
  if (result.value.cycle || !tasks.value.length) {
    ganttEl.value.innerHTML = "";
    return;
  }
  try {
    ganttEl.value.innerHTML = "";
    new Gantt(ganttEl.value, ganttTasks(), { view_mode: "Day", readonly: true, infinite_padding: false });
  } catch {
    ganttEl.value.innerHTML = "";
  }
}
onMounted(render);
watch(tasks, () => nextTick(render), { deep: true });

// 編集
let seq = 0;
function addTask() {
  tasks.value.push({ id: "n" + Date.now() + seq++, name: "新しいタスク", effort: 3, deps: [], status: "todo" });
}
function delTask(id: string) {
  tasks.value = tasks.value.filter((t) => t.id !== id).map((t) => ({ ...t, deps: t.deps.filter((d) => d !== id) }));
}
function toggleDep(t: PlanTask, depId: string) {
  t.deps = t.deps.includes(depId) ? t.deps.filter((d) => d !== depId) : [...t.deps, depId];
}
</script>

<template>
  <div class="cpm">
    <div class="summary" :class="{ over: overDeadline, tight: !overDeadline && slack < 3 }">
      <div v-if="result.cycle" class="err">⚠ 依存関係が循環しています。先行タスクの指定を見直してください。</div>
      <template v-else>
        <b>完了予定：{{ jp(result.projectEnd) }}</b>
        <span v-if="overDeadline" class="tag">締切 {{ jp(config.deadline) }} を {{ result.projectEnd - config.deadline }}日 超過</span>
        <span v-else class="tag">締切 {{ jp(config.deadline) }} に対し予備 {{ slack }}日</span>
        <span class="crit">クリティカルパス：{{ criticalNames }}</span>
      </template>
    </div>

    <!-- ガント（frappe-gantt） -->
    <div class="gwrap"><div ref="ganttEl" class="gantt-target"></div></div>

    <!-- 編集テーブル -->
    <div class="tbl">
      <div class="thead">
        <span class="c-name">タスク</span>
        <span class="c-eff">工数</span>
        <span class="c-dep">先行タスク（依存）</span>
        <span class="c-stat">状態</span>
        <span class="c-info">開始〜終了 / 余裕</span>
        <span class="c-del"></span>
      </div>
      <div v-for="t in tasks" :key="t.id" class="trow" :class="{ crit: result.calc.get(t.id)?.critical }">
        <input class="c-name" v-model="t.name" />
        <input class="c-eff" type="number" min="1" v-model.number="t.effort" />
        <div class="c-dep">
          <button
            v-for="o in tasks.filter((x) => x.id !== t.id)"
            :key="o.id"
            class="depchip"
            :class="{ on: t.deps.includes(o.id) }"
            @click="toggleDep(t, o.id)"
          >
            {{ o.name }}
          </button>
        </div>
        <select class="c-stat" :class="t.status" v-model="t.status">
          <option v-for="k in statusKeys" :key="k" :value="k">{{ STATUS[k].label }}</option>
        </select>
        <span class="c-info">
          <template v-if="!result.cycle">
            {{ jp(result.calc.get(t.id)!.es) }}〜{{ jp(Math.max(result.calc.get(t.id)!.ef - 1, result.calc.get(t.id)!.es)) }}
            <b v-if="result.calc.get(t.id)!.critical" class="cflag">クリティカル</b>
            <span v-else class="fl">余裕{{ result.calc.get(t.id)!.float }}日</span>
          </template>
        </span>
        <button class="c-del" @click="delTask(t.id)">×</button>
      </div>
      <button class="addbtn" @click="addTask">＋ タスクを追加</button>
    </div>
  </div>
</template>

<style scoped>
.summary {
  border-radius: 9px;
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 13px;
  background: var(--ok-bg);
  color: var(--ok);
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: center;
}
.summary.tight { background: var(--warn-bg); color: #7a5a10; }
.summary.over { background: var(--deny-bg); color: var(--deny); }
.summary .tag { font-weight: 700; }
.summary .crit { color: var(--ink-2); font-size: 12.5px; }
.summary .err { color: var(--deny); font-weight: 700; }
.gwrap { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 6px; overflow-x: auto; margin-bottom: 16px; }
.gantt-target { min-height: 240px; }

.tbl { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.thead, .trow { display: grid; grid-template-columns: 1.6fr 60px 2.4fr 90px 1.5fr 32px; gap: 8px; align-items: center; padding: 8px 12px; }
.thead { background: var(--line-2); font-size: 11px; color: var(--ink-3); font-weight: 700; }
.trow { border-top: 1px solid var(--line-2); }
.trow.crit { background: #fdf0ee; }
.trow input, .trow select { border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; font-size: 12.5px; font-family: inherit; }
.trow input.c-name { font-weight: 600; }
.c-eff { text-align: center; }
.c-dep { display: flex; flex-wrap: wrap; gap: 4px; }
.depchip { border: 1px solid var(--line); background: var(--bg); color: var(--ink-3); border-radius: 12px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
.depchip.on { background: var(--brand-bg); border-color: var(--brand); color: var(--brand); font-weight: 700; }
.c-stat.todo { color: var(--todo); } .c-stat.doing { color: var(--doing); } .c-stat.review { color: var(--review); } .c-stat.done { color: var(--done); }
.c-info { font-size: 11.5px; color: var(--ink-2); }
.cflag { color: var(--deny); font-weight: 800; }
.fl { color: var(--ink-3); }
.c-del { border: none; background: none; color: var(--ink-3); cursor: pointer; font-size: 15px; }
.c-del:hover { color: var(--deny); }
.addbtn { border: none; border-top: 1px solid var(--line-2); background: var(--bg); color: var(--ink-2); width: 100%; padding: 9px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.addbtn:hover { color: var(--brand); }
</style>

<style>
/* frappe-gantt のクリティカルバー（scoped外＝グローバル） */
.gantt .bar-crit .bar { fill: #f0b4aa; }
.gantt .bar-crit .bar-progress { fill: #d5432f; }
</style>
