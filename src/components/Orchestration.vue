<script setup lang="ts">
import { computed, ref } from "vue";
import type { PastSchedule, Task, PlanConfig } from "../types";
import type { AgentKey } from "../data/demo";
import type { LLMClient } from "../llm/types";
import GanttEditor from "./GanttEditor.vue";

const props = defineProps<{ pasts: PastSchedule[]; config: PlanConfig; client: LLMClient; project: string; baseOnPast?: boolean }>();
const emit = defineEmits<{ (e: "edit", tasks: Task[]): void }>();

const AGENTS: Record<AgentKey, { icon: string; name: string; role: string }> = {
  scout: { icon: "📚", name: "実績参考役", role: "過去実績を要約" },
  analyst: { icon: "📋", name: "分解・見積り役", role: "タスク化・日数推定" },
  arch: { icon: "🗓", name: "日程配置役", role: "依存を考え配置" },
  ref: { icon: "🔍", name: "反証役", role: "穴を突く" },
  intg: { icon: "🧩", name: "統合役", role: "最終案にまとめる" },
};
const nodeOrder: AgentKey[] = ["scout", "analyst", "arch", "ref", "intg"];

interface Msg { agent: AgentKey; text: string; revise?: boolean }
const messages = ref<Msg[]>([]);
const activeNode = ref<AgentKey | null>(null);
const showLoop = ref(false);
const running = ref(false);
const finished = ref(false);
const errored = ref(false);
const meta = ref("");
const preview = ref<Task[]>([]);
const result = ref<Task[]>([]);
const improvements = ref<{ ok: boolean; text: string }[]>([]);
const logEl = ref<HTMLElement | null>(null);

let t0 = 0;

// パイプラインの進捗：これまで登場した（＝完了した）エージェント集合
const seen = computed(() => {
  const s = new Set<AgentKey>(messages.value.map((m) => m.agent));
  return s;
});
function nodeState(k: AgentKey): "done" | "active" | "todo" {
  if (activeNode.value === k && running.value) return "active";
  if (seen.value.has(k) || finished.value) return "done";
  return "todo";
}
const progressPct = computed(() => {
  if (finished.value) return 100;
  const doneN = nodeOrder.filter((k) => seen.value.has(k)).length;
  const activeBonus = activeNode.value && running.value ? 0.5 : 0;
  return Math.min(100, ((doneN + activeBonus) / nodeOrder.length) * 100);
});
const okCount = computed(() => improvements.value.filter((i) => i.ok).length);
const openCount = computed(() => improvements.value.filter((i) => !i.ok).length);

async function run() {
  messages.value = [];
  preview.value = [];
  improvements.value = [];
  finished.value = false;
  errored.value = false;
  showLoop.value = false;
  running.value = true;
  t0 = Date.now();

  try {
    const res = await props.client.generate(
      { project: props.project, config: props.config, pasts: props.pasts, baseOnPast: props.baseOnPast },
      (s) => {
        activeNode.value = s.agent;
        if (s.loop) showLoop.value = true;
        messages.value.push({ agent: s.agent, text: s.text, revise: s.revise });
        if (s.preview) preview.value = s.preview;
        meta.value = `実行中… ${messages.value.length}ステップ ・ ${((Date.now() - t0) / 1000).toFixed(1)}秒`;
        scrollLog();
      }
    );
    result.value = res.tasks;
    improvements.value = res.improvements;
    activeNode.value = null;
    running.value = false;
    finished.value = true;
    meta.value = `完了 ・ ${messages.value.length}ステップ ・ ${((Date.now() - t0) / 1000).toFixed(1)}秒`;
  } catch (err) {
    running.value = false;
    errored.value = true;
    activeNode.value = null;
    const m = err instanceof Error ? err.message : String(err);
    meta.value = "エラーが発生しました";
    messages.value.push({ agent: "ref", text: `⚠ AIの呼び出しでエラー：${escapeText(m)}<br>APIキーやネットワークをご確認ください。デモモードなら鍵は不要です。` });
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollLog() {
  requestAnimationFrame(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function goEdit() {
  emit("edit", result.value);
}

defineExpose({ run });
</script>

<template>
  <div class="orch">
    <!-- ステータスバー：連携パイプライン＋進捗 -->
    <div class="board">
      <div class="board-top">
        <span class="board-title">エージェント連携</span>
        <span class="status" :class="{ run: running, done: finished, err: errored }">
          <span v-if="running" class="spin" aria-hidden="true"></span>
          <span v-else-if="finished" class="tick" aria-hidden="true">✓</span>
          {{ meta || "「スケジュールを構築」で開始します" }}
        </span>
      </div>

      <div class="pipe">
        <div class="pipe-track"><div class="pipe-fill" :style="{ width: progressPct + '%' }"></div></div>
        <div class="dag">
          <div v-for="(k, idx) in nodeOrder" :key="k" class="dagwrap">
            <div class="node" :class="[k, nodeState(k)]">
              <span class="nic">{{ AGENTS[k].icon }}</span>
              <span class="ntx"><b>{{ AGENTS[k].name }}</b><em>{{ AGENTS[k].role }}</em></span>
            </div>
            <span v-if="idx < nodeOrder.length - 1" class="arrow" :class="{ lit: seen.has(nodeOrder[idx + 1]) || finished }">→</span>
          </div>
        </div>
        <transition name="fade">
          <div v-if="showLoop" class="loop"><span class="loop-ic">↩</span>反証 → 日程を組み直し</div>
        </transition>
      </div>
    </div>

    <div class="cols">
      <!-- 会話 -->
      <div class="pane">
        <div class="ph"><span class="ph-t">エージェントのやり取り</span><span v-if="messages.length" class="ph-c">{{ messages.length }}件</span></div>
        <div ref="logEl" class="log">
          <div v-if="!messages.length" class="empty">
            <div class="empty-ic">💬</div>
            <p>「スケジュールを構築」を押すと、各AIが過去実績を基に計画を組み、<b>反証役</b>が穴を突きます。</p>
          </div>
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.agent">
            <div class="av">{{ AGENTS[m.agent].icon }}</div>
            <div class="bubble">
              <div class="who">{{ AGENTS[m.agent].name }}<span v-if="m.revise" class="rev">組み直し</span></div>
              <div class="txt" v-html="m.text"></div>
            </div>
          </div>
          <div v-if="running" class="msg typing" :class="activeNode || 'analyst'">
            <div class="av">{{ activeNode ? AGENTS[activeNode].icon : "…" }}</div>
            <div class="bubble"><div class="txt dots"><span></span><span></span><span></span></div></div>
          </div>
        </div>
      </div>

      <!-- プレビュー -->
      <div class="pane">
        <div class="ph">
          <span class="ph-t">スケジュール（プレビュー）</span>
          <button v-if="finished" class="edit-btn" @click="goEdit">
            ガント編集画面を開く
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
        <div class="prev">
          <div v-if="!preview.length" class="empty">
            <div class="empty-ic">📊</div>
            <p>たたき台 → 反証で組み直しの様子が、ここにガントで表示されます。</p>
          </div>
          <GanttEditor v-else v-model="preview" :config="config" :editable="false" />
        </div>
      </div>
    </div>

    <!-- 反証で良くなった点／残課題（完了後の“成果”パネル） -->
    <transition name="rise">
      <div v-if="finished && improvements.length" class="outcome">
        <div class="oc-head">
          <div class="oc-title">
            <span class="oc-ic">✨</span>
            <div>
              <b>反証レビューの成果</b>
              <span class="oc-sub">分解役のたたき台を、反証役が突いて改善しました</span>
            </div>
          </div>
          <div class="oc-stat">
            <span class="badge ok">改善 {{ okCount }}</span>
            <span v-if="openCount" class="badge open">残課題 {{ openCount }}</span>
          </div>
        </div>
        <ul class="oc-list">
          <li v-for="(im, i) in improvements" :key="i" :class="{ open: !im.ok }">
            <span class="oc-mk">{{ im.ok ? "✓" : "!" }}</span>
            <span class="oc-tx">{{ im.text }}</span>
          </li>
        </ul>
        <div class="oc-cta">
          <span class="oc-note">AIは案、確定は人。ガント上で手直しして確定してください。</span>
          <button class="edit-btn big" @click="goEdit">
            ガント編集画面で確定する
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* ===== ステータスボード ===== */
.board {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 14px 16px 16px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}
.board-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.board-title { font-size: 12px; font-weight: 800; letter-spacing: 0.04em; color: var(--ink-2); text-transform: uppercase; }
.status {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); font-weight: 600;
}
.status.run { color: var(--brand-strong); }
.status.done { color: var(--ok); }
.status.err { color: var(--deny); }
.spin { width: 12px; height: 12px; border: 2px solid var(--brand-ring); border-top-color: var(--brand); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tick { color: var(--ok); font-weight: 900; }

.pipe { position: relative; }
.pipe-track { height: 3px; background: var(--line-2); border-radius: 3px; overflow: hidden; margin-bottom: 12px; }
.pipe-fill { height: 100%; background: var(--brand-grad); border-radius: 3px; transition: width 0.5s var(--ease); }
.dag { display: flex; align-items: stretch; gap: 4px; flex-wrap: wrap; }
.dagwrap { display: inline-flex; align-items: center; gap: 4px; }
.node {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1.5px solid var(--line); border-radius: var(--r); padding: 7px 12px;
  background: var(--panel-2); transition: box-shadow 0.25s, transform 0.25s, border-color 0.25s, opacity 0.25s;
}
.node .nic { font-size: 16px; line-height: 1; }
.node .ntx { display: flex; flex-direction: column; line-height: 1.25; }
.node .ntx b { font-size: 12px; font-weight: 800; color: var(--ink-2); }
.node .ntx em { font-style: normal; font-size: 10px; color: var(--ink-3); }
.node.todo { opacity: 0.62; }
/* 完了色（各役割の配色を薄く点灯） */
.node.done.scout { background: var(--ag-scout-bg); border-color: #9ed3d3; }
.node.done.scout b, .node.done.scout em { color: var(--ag-scout); }
.node.done.analyst { background: var(--ag-analyst-bg); border-color: #c3c8ff; }
.node.done.analyst b, .node.done.analyst em { color: var(--ag-analyst); }
.node.done.arch { background: var(--ag-arch-bg); border-color: #d3c2e6; }
.node.done.arch b, .node.done.arch em { color: var(--ag-arch); }
.node.done.ref { background: var(--ag-ref-bg); border-color: #f2bdb4; }
.node.done.ref b, .node.done.ref em { color: var(--ag-ref); }
.node.done.intg { background: var(--ag-intg-bg); border-color: #a9dcc4; }
.node.done.intg b, .node.done.intg em { color: var(--ag-intg); }
/* 実行中のノード */
.node.active { transform: translateY(-2px); border-color: var(--brand); background: #fff; box-shadow: 0 0 0 3px var(--brand-ring), var(--shadow); }
.node.active b, .node.active em { color: var(--brand-strong); }
.arrow { color: var(--line); font-weight: 800; transition: color 0.3s; }
.arrow.lit { color: var(--brand-2); }
.loop {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 10px; font-size: 11.5px; color: var(--deny); font-weight: 800;
  background: var(--deny-bg); border: 1px solid #f2bdb4; border-radius: 999px; padding: 3px 12px;
}
.loop-ic { font-size: 13px; }

/* ===== 2カラム ===== */
.cols { display: grid; grid-template-columns: 430px 1fr; gap: 16px; align-items: start; }
.pane { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow); }
.ph {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 11px 16px; border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel), var(--panel-2)); min-height: 44px;
}
.ph-t { font-size: 12px; letter-spacing: 0.03em; color: var(--ink-2); font-weight: 800; }
.ph-c { font-size: 10.5px; font-weight: 800; color: var(--ink-3); background: var(--bg-2); border-radius: 999px; padding: 2px 9px; }
.edit-btn {
  display: inline-flex; align-items: center; gap: 5px;
  border: none; background: var(--brand-grad); color: #fff; font-size: 11.5px; font-weight: 800;
  padding: 6px 12px; border-radius: var(--r-sm); cursor: pointer; box-shadow: 0 4px 12px var(--brand-ring);
  transition: transform 0.15s var(--ease), filter 0.15s;
}
.edit-btn:hover { transform: translateY(-1px); filter: brightness(1.05); }
.edit-btn.big { font-size: 13.5px; padding: 10px 20px; }

.log { padding: 14px 16px; min-height: 384px; max-height: 540px; overflow-y: auto; scroll-behavior: smooth; }
.prev { padding: 12px; min-height: 384px; }
.empty {
  height: 100%; min-height: 340px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; color: var(--ink-3); gap: 10px; padding: 20px;
}
.empty-ic { font-size: 30px; opacity: 0.7; }
.empty p { margin: 0; font-size: 13px; max-width: 320px; line-height: 1.7; }
.empty b { color: var(--ink-2); }

.msg { display: flex; gap: 10px; margin-bottom: 14px; animation: fade 0.4s var(--ease); }
@keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.av { width: 32px; height: 32px; border-radius: 9px; flex: none; display: grid; place-items: center; font-size: 15px; background: var(--bg-2); }
.msg.scout .av { background: var(--ag-scout-bg); }
.msg.analyst .av { background: var(--ag-analyst-bg); }
.msg.arch .av { background: var(--ag-arch-bg); }
.msg.ref .av { background: var(--ag-ref-bg); }
.msg.intg .av { background: var(--ag-intg-bg); }
.bubble { flex: 1; min-width: 0; }
.who { font-size: 11.5px; font-weight: 800; margin-bottom: 3px; }
.msg.scout .who { color: var(--ag-scout); }
.msg.analyst .who { color: var(--ag-analyst); }
.msg.arch .who { color: var(--ag-arch); }
.msg.ref .who { color: var(--ag-ref); }
.msg.intg .who { color: var(--ag-intg); }
.rev { font-size: 10px; font-weight: 800; color: var(--warn); background: var(--warn-bg); border-radius: 5px; padding: 1px 7px; margin-left: 7px; }
.txt {
  font-size: 13px; border-radius: 10px; padding: 10px 13px; background: var(--bg);
  color: var(--ink); border: 1px solid transparent; word-break: break-word;
}
.msg.ref .txt { background: var(--ag-ref-bg); border-color: #f4cdc5; }
.msg.intg .txt { background: var(--ag-intg-bg); border-color: #bfe3d1; }
.txt :deep(b) { color: inherit; }
.txt :deep(ul) { margin: 6px 0 0; padding-left: 18px; }
.txt :deep(li) { margin: 3px 0; }
/* タイピングインジケータ */
.typing .txt.dots { display: inline-flex; gap: 4px; padding: 12px 14px; }
.dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); animation: bounce 1s infinite; }
.dots span:nth-child(2) { animation-delay: 0.15s; }
.dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }

/* ===== 成果パネル ===== */
.outcome {
  margin-top: 16px; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--r-lg); padding: 18px 20px; box-shadow: var(--shadow-lg);
  border-top: 3px solid var(--brand);
}
.oc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.oc-title { display: flex; align-items: center; gap: 12px; }
.oc-ic { font-size: 22px; }
.oc-title b { display: block; font-size: 15px; }
.oc-sub { font-size: 12px; color: var(--ink-3); }
.oc-stat { display: flex; gap: 8px; }
.badge { font-size: 11.5px; font-weight: 800; padding: 4px 11px; border-radius: 999px; }
.badge.ok { color: var(--ok); background: var(--ok-bg); border: 1px solid #bfe6d3; }
.badge.open { color: var(--warn); background: var(--warn-bg); border: 1px solid #f0dcb2; }
.oc-list { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 2px; }
.oc-list li { display: flex; gap: 11px; align-items: flex-start; font-size: 13px; padding: 9px 4px; border-bottom: 1px solid var(--line-2); color: var(--ink); }
.oc-list li:last-child { border-bottom: none; }
.oc-mk { flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-weight: 900; font-size: 12px; color: #fff; background: var(--ok); margin-top: 1px; }
.oc-list li.open .oc-mk { background: var(--warn); }
.oc-tx { flex: 1; }
.oc-cta { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 4px; }
.oc-note { font-size: 12px; color: var(--ink-3); }

/* トランジション */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.rise-enter-active { transition: opacity 0.45s var(--ease), transform 0.45s var(--ease); }
.rise-enter-from { opacity: 0; transform: translateY(14px); }

@media (max-width: 940px) {
  .cols { grid-template-columns: 1fr; }
  .log { max-height: 420px; }
}
</style>
