<script setup lang="ts">
import { computed, ref } from "vue";
import readXlsxFile from "read-excel-file/browser";
import type { PastSchedule, PastTask } from "../types";
import { SAMPLE_CSV } from "../data/demo";

const pasts = defineModel<PastSchedule[]>({ required: true });

const totalDays = (p: PastSchedule) => p.tasks.reduce((a, t) => a + (t.days || 0), 0);

// 参照サマリ：全実績から代表的なリードタイムを拾う
function maxMatch(re: RegExp): number {
  let m = 0;
  for (const p of pasts.value) for (const t of p.tasks) if (re.test(t.name)) m = Math.max(m, t.days || 0);
  return m;
}
const summary = computed(() => ({
  count: pasts.value.length,
  line: maxMatch(/回線|開通/),
  deliv: maxMatch(/納品/),
}));

// 詳細の開閉
const openIndex = ref<number | null>(null);
function toggle(i: number) {
  openIndex.value = openIndex.value === i ? null : i;
}
function delPast(i: number) {
  pasts.value.splice(i, 1);
  if (openIndex.value === i) openIndex.value = null;
  else if (openIndex.value !== null && openIndex.value > i) openIndex.value--;
}
function clearAll() {
  pasts.value = [];
  openIndex.value = null;
}

// 取込パネル
const showPanel = ref(false);
const csv = ref("");
const impName = ref("");
const msg = ref("");
const msgErr = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/** 「タスク名, 日数」のテキストを行に変換 */
function parseRows(text: string): PastTask[] {
  const rows: PastTask[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const cols = l.split(/[,\t]/);
    if (cols.length < 2) continue;
    const name = cols[0].trim();
    const days = parseInt(cols[1], 10);
    if (name && !isNaN(days)) rows.push({ name, days });
  }
  return rows;
}

// ==== Excel（実際のガント表）からタスクと日数を取り出す ====
type Cell = string | number | boolean | Date | null;

/** read-excel-file の戻り（1枚 or 複数シート）を2次元配列にそろえる */
function normalizeGrid(raw: unknown): Cell[][] {
  if (
    Array.isArray(raw) &&
    raw.length &&
    raw[0] &&
    !Array.isArray(raw[0]) &&
    typeof raw[0] === "object" &&
    "data" in (raw[0] as object)
  ) {
    const sheets = raw as { sheet: string; data: Cell[][] }[];
    const sch = sheets.find((sh) => /スケジュール|schedule|工程|日程/i.test(sh.sheet)) || sheets[0];
    return sch.data;
  }
  return raw as Cell[][];
}

const cellStr = (v: Cell) => (v == null ? "" : String(v).trim());
const cellNum = (v: Cell) => (typeof v === "number" ? v : parseInt(String(v ?? ""), 10));
function toDate(v: Cell): Date | null {
  if (v instanceof Date) return v;
  // Excel のシリアル日付（1899-12-30 起点の数値。read-excel-file が数値で返す場合がある）
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400000));
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) {
      const d = new Date(s.replace(/\//g, "-"));
      return isNaN(d.getTime()) ? null : d;
    }
    // 文字列のシリアル値
    const n = Number(s);
    if (Number.isFinite(n) && n > 20000 && n < 80000) {
      return new Date(Math.round((n - 25569) * 86400000));
    }
  }
  return null;
}

// 見出し検出のキーワード（実務の工程表の揺れを吸収）
const NAME_KW = ["作業内容", "作業項目", "タスク", "工程", "作業", "項目", "内容", "名称"];
// 開始列：終了系（完了予定日など）を誤って拾わないよう END_KW を除外して判定する。
const START_KW = ["開始", "着手", "開始日", "開始予定", "予定日", "期間"];
const END_KW = ["終了", "完了予定日", "完了予定", "完了日", "完了", "終了予定", "期限"];
const DAYS_KW = ["日数", "工数", "所要"];
const isDateCell = (v: Cell) => toDate(v) != null;
/** 見出し行から kws に該当する列を探す。excludeKws に該当する列は対象外（見出しの衝突回避）。 */
const findCol = (row: Cell[], kws: string[], excludeKws: string[] = []) =>
  Array.isArray(row)
    ? row.findIndex(
        (c) =>
          typeof c === "string" &&
          kws.some((k) => c.includes(k)) &&
          !excludeKws.some((k) => c.includes(k))
      )
    : -1;

/**
 * 実務の工程表を解析してタスク（名前＋日数）を抽出する。
 * 見出し行を検出し、大分類（作業内容の左・結合セルは繰り越し）・作業内容・区分（作業内容と開始日の間）を
 * 組み合わせて名前を作り、開始/終了日（または日数列）から所要日数を求める。
 */
function extractTasks(grid: Cell[][]): PastTask[] {
  let hi = -1,
    nameCol = -1,
    startCol = -1,
    endCol = -1,
    daysCol = -1;
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const row = grid[r] || [];
    const nc = findCol(row, NAME_KW);
    if (nc < 0) continue;
    const dc = findCol(row, DAYS_KW);
    const sc = findCol(row, START_KW, END_KW); // 開始列は終了系の見出しを除外して探す
    if (dc < 0 && sc < 0) continue; // 名前列だけの行は見出しとみなさない
    hi = r;
    nameCol = nc;
    daysCol = dc;
    if (sc >= 0) {
      startCol = sc;
      endCol = findCol(row, END_KW);
      if (endCol < 0 || endCol === sc) endCol = sc + 1; // 「期間」結合セルの隣を終了日とみなす
    }
    break;
  }

  const out: PastTask[] = [];
  if (hi < 0) {
    // 見出しが無ければ「1列目=名前, 2列目=日数」の単純表として読む
    for (const row of grid) {
      const name = cellStr(row?.[0]);
      const days = cellNum(row?.[1]);
      if (name && days > 0) out.push({ name, days });
    }
    return out;
  }

  const catCol = nameCol - 1 >= 0 ? nameCol - 1 : -1; // 大分類（繰り越し）
  const subCol = startCol >= 0 && startCol > nameCol + 1 ? nameCol + 1 : -1; // 区分
  let lastCat = "";
  for (let r = hi + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (catCol >= 0) {
      const c = cellStr(row[catCol]);
      if (c && !isDateCell(row[catCol])) lastCat = c;
    }
    let name = isDateCell(row[nameCol]) ? "" : cellStr(row[nameCol]);
    const sub = subCol >= 0 && !isDateCell(row[subCol]) ? cellStr(row[subCol]) : "";
    if (!name) {
      if (sub) name = lastCat ? `${lastCat}（${sub}）` : sub; // 区分だけの継続行
      else continue;
    } else if (sub) {
      name = `${name}（${sub}）`;
    }
    if (NAME_KW.includes(name)) continue; // 見出しの再出現を除外
    let days = daysCol >= 0 ? cellNum(row[daysCol]) : 0;
    if (!(days > 0) && startCol >= 0) {
      const sd = toDate(row[startCol]);
      const ed = endCol >= 0 ? toDate(row[endCol]) : null;
      if (sd && ed) days = Math.round((ed.getTime() - sd.getTime()) / 86400000) + 1;
      else if (sd) days = 1;
    }
    if (!(days > 0) || days > 2000) continue; // 日数不明・異常値は除外
    out.push({ name, days });
  }
  return out;
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  try {
    if (/\.xlsx$/i.test(f.name)) {
      // 全シートを取得（[{sheet,data}] 形式）。名前のみ返る版なら該当シートを名前指定で再読込。
      const raw = (await readXlsxFile(f, { getSheets: true } as never)) as unknown;
      let grid: Cell[][];
      if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object" && "data" in (raw[0] as object)) {
        grid = normalizeGrid(raw);
      } else if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object" && "name" in (raw[0] as object)) {
        const names = (raw as { name: string }[]).map((s) => s.name);
        const pick = names.find((n) => /スケジュール|schedule|工程|日程/i.test(n)) || names[0];
        grid = (await readXlsxFile(f, { sheet: pick } as never)) as unknown as Cell[][];
      } else {
        grid = raw as Cell[][];
      }
      const tasks = extractTasks(grid);
      if (!tasks.length) throw new Error("作業内容と日数（または開始日・終了日）の列が見つかりませんでした");
      csv.value = tasks.map((t) => `${t.name},${t.days}`).join("\n");
    } else {
      csv.value = await f.text();
    }
    if (!impName.value) impName.value = f.name.replace(/\.[^.]+$/, "");
    msg.value = "";
    msgErr.value = false;
  } catch (err) {
    msgErr.value = true;
    msg.value = "ファイルを読めませんでした：" + (err instanceof Error ? err.message : "");
  }
  input.value = "";
}

function sample() {
  csv.value = SAMPLE_CSV;
  if (!impName.value) impName.value = "B支社構築（2023）";
}

const MAX_PASTS = 20; // 参考実績の最大件数
const MAX_ROWS = 200; // 1実績あたりの最大タスク数

function addPast() {
  if (pasts.value.length >= MAX_PASTS) {
    msgErr.value = true;
    msg.value = `参考実績は最大${MAX_PASTS}件までです。不要なものを削除してから追加してください。`;
    return;
  }
  let rows = parseRows(csv.value);
  if (!rows.length) {
    msgErr.value = true;
    msg.value = "読み取れる行がありません。「タスク名, 日数」の形式か確認してください。";
    return;
  }
  let truncated = false;
  if (rows.length > MAX_ROWS) {
    rows = rows.slice(0, MAX_ROWS);
    truncated = true;
  }
  const name = (impName.value.trim() || "参考実績" + (pasts.value.length + 1)).slice(0, 200);
  pasts.value.push({ name, tasks: rows });
  msgErr.value = false;
  msg.value =
    `「${name}」を参考に加えました（${rows.length}タスク・合計${rows.reduce((a, t) => a + t.days, 0)}日）。次の構築でこの実績も参考にします。` +
    (truncated ? `（先頭${MAX_ROWS}タスクに制限しました）` : "");
  csv.value = "";
  impName.value = "";
}
</script>

<template>
  <div class="past">
    <p class="h">
      過去スケジュールを参考にします（架空サンプル）— タスクと工数の根拠に使います。CSV／Excel を取り込めます。チップを押すと中身が見えます。
    </p>

    <div class="chips">
      <span v-for="(p, i) in pasts" :key="i" class="pchip" :class="{ open: openIndex === i }">
        <button class="pchip-body" @click="toggle(i)"><span class="ck">✓</span>{{ p.name }}・実績{{ totalDays(p) }}日</button>
        <button class="pchip-x" title="この実績を削除" @click.stop="delPast(i)">×</button>
      </span>
      <span v-if="pasts.length" class="cnt">計 {{ summary.count }}件を参考にしています</span>
      <button v-if="pasts.length" class="clearall" @click="clearAll">すべてクリア</button>
      <span v-else class="cnt">参考にする実績がありません（下のボタンから追加できます）</span>
    </div>

    <div v-if="openIndex !== null && pasts[openIndex]" class="pdetail">
      <div class="pd-head">
        <b>{{ pasts[openIndex].name }}</b><span class="pd-total">合計 {{ totalDays(pasts[openIndex]) }}日</span>
        <button class="pd-close" @click="openIndex = null">閉じる ✕</button>
      </div>
      <table>
        <tr v-for="(t, k) in pasts[openIndex].tasks" :key="k">
          <td>{{ t.name }}</td>
          <td>{{ t.days }}日</td>
        </tr>
      </table>
    </div>

    <p class="ref-summary">
      参考にする代表値：<b>回線工事 最大{{ summary.line || "—" }}日</b> ／ <b>機器納品 最大{{ summary.deliv || "—" }}日</b>
    </p>

    <button class="addbtn" @click="showPanel = !showPanel">＋ 参考にする実績を追加</button>

    <div v-if="showPanel" class="imp">
      <textarea v-model="csv" placeholder="タスク名,日数 の形式で1行ずつ貼り付け&#10;例：&#10;回線開通申込→工事,35&#10;機器納品待ち,22&#10;ネットワーク構築,9"></textarea>
      <div class="improw">
        <button class="mini" @click="sample">サンプルCSVを入れる</button>
        <button class="mini" @click="fileInput?.click()">ファイルを選択（CSV / Excel）</button>
        <input ref="fileInput" type="file" accept=".csv,.txt,.xlsx" hidden @change="onFile" />
        <div class="grow"></div>
        <input v-model="impName" class="nm" placeholder="実績の名前（例：B支社構築 2023）" />
        <button class="btn2" @click="addPast">参考に加える</button>
      </div>
      <p v-if="msg" class="impmsg" :class="{ err: msgErr }">{{ msg }}</p>
    </div>
  </div>
</template>

<style scoped>
.past {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
}
.h {
  font-size: 12px;
  color: var(--ink-3);
  font-weight: 700;
  margin: 0 0 10px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.pchip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  background: #e2f4f4;
  color: #0e8a8a;
  border: 1px solid #bfe3e3;
  border-radius: 16px;
  padding: 0 4px 0 11px;
  font-weight: 600;
}
.pchip.open {
  outline: 2px solid #0e8a8a;
  outline-offset: 1px;
}
.pchip-body {
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
}
.pchip .ck {
  font-weight: 800;
}
.pchip-x {
  border: none;
  background: none;
  color: #0e8a8a;
  opacity: 0.55;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 50%;
}
.pchip-x:hover {
  opacity: 1;
  background: rgba(213, 67, 47, 0.14);
  color: var(--deny);
}
.cnt {
  font-size: 11.5px;
  color: var(--ink-3);
}
.clearall {
  border: none;
  background: none;
  color: var(--ink-3);
  font-size: 11.5px;
  cursor: pointer;
  text-decoration: underline;
}
.clearall:hover {
  color: var(--deny);
}
.pd-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.pd-total {
  color: var(--ink-3);
  font-size: 11.5px;
}
.pd-close {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 11.5px;
  cursor: pointer;
  font-weight: 600;
}
.pd-close:hover {
  text-decoration: underline;
}
.pdetail {
  font-size: 12px;
  color: var(--ink-2);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 11px;
  margin-top: 10px;
}
.pdetail table {
  border-collapse: collapse;
  width: 100%;
  max-width: 360px;
  margin-top: 4px;
}
.pdetail td {
  padding: 2px 8px;
  border-bottom: 1px solid var(--line-2);
}
.pdetail td:last-child {
  text-align: right;
  color: var(--ink-3);
}
.ref-summary {
  font-size: 12.5px;
  color: var(--ink-2);
  margin: 12px 0 0;
}
.addbtn {
  margin-top: 12px;
  border: 1px dashed var(--line);
  background: var(--bg);
  color: var(--ink-2);
  border-radius: 8px;
  padding: 7px 15px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.addbtn:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.imp {
  margin-top: 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 13px;
}
.imp textarea {
  width: 100%;
  min-height: 96px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}
.improw {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
  flex-wrap: wrap;
}
.improw .grow {
  flex: 1;
}
.mini {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 6px 11px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
}
.mini:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.nm {
  min-width: 180px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
}
.btn2 {
  border: 1px solid var(--brand);
  background: var(--brand);
  color: #fff;
  border-radius: 7px;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.impmsg {
  font-size: 12px;
  color: var(--ok);
  margin: 9px 0 0;
}
.impmsg.err {
  color: var(--deny);
}
</style>
