// クリティカルパス法（CPM）エンジン。
// タスクの工数と依存関係から、各タスクの最早/最遅・余裕(float)・クリティカルパス・
// プロジェクト完了日を決定論的に計算する。AIは使わず、入力が変われば結果が必ず変わる。

export interface CpmInput {
  id: string;
  name: string;
  /** 工数（日数） */
  effort: number;
  /** 依存する先行タスクのid（finish-to-start：先行の完了後に開始） */
  deps: string[];
}

export interface CpmCalc {
  es: number; // Earliest Start（開始日インデックス）
  ef: number; // Earliest Finish
  ls: number; // Latest Start
  lf: number; // Latest Finish
  float: number; // 余裕日数（LS - ES）
  critical: boolean; // クリティカルパス上か（float === 0）
}

export interface CpmResult {
  calc: Map<string, CpmCalc>;
  projectEnd: number; // プロジェクト完了日（インデックス）
  order: string[]; // トポロジカル順
  cycle: boolean; // 依存に循環があるか（true なら計算不正）
  criticalPath: string[]; // クリティカルパス上のタスクid（順序つき）
}

export function computeCpm(tasks: CpmInput[]): CpmResult {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  tasks.forEach((t) => {
    indeg.set(t.id, 0);
    succ.set(t.id, []);
  });
  tasks.forEach((t) => {
    for (const d of t.deps) {
      if (map.has(d)) {
        indeg.set(t.id, (indeg.get(t.id) || 0) + 1);
        succ.get(d)!.push(t.id);
      }
    }
  });

  // トポロジカルソート（Kahn法）
  const queue = tasks.filter((t) => (indeg.get(t.id) || 0) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const sc of succ.get(id)!) {
      indeg.set(sc, (indeg.get(sc) || 0) - 1);
      if ((indeg.get(sc) || 0) === 0) queue.push(sc);
    }
  }
  const cycle = order.length !== tasks.length;

  // 前進計算：ES / EF
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const t = map.get(id)!;
    const depEfs = t.deps.filter((d) => map.has(d)).map((d) => ef.get(d) ?? 0);
    const start = depEfs.length ? Math.max(...depEfs) : 0;
    es.set(id, start);
    ef.set(id, start + t.effort);
  }
  const projectEnd = tasks.length ? Math.max(0, ...tasks.map((t) => ef.get(t.id) ?? 0)) : 0;

  // 後退計算：LF / LS
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const t = map.get(id)!;
    const scs = succ.get(id)!;
    const latest = scs.length ? Math.min(...scs.map((s) => ls.get(s) ?? projectEnd)) : projectEnd;
    lf.set(id, latest);
    ls.set(id, latest - t.effort);
  }

  const calc = new Map<string, CpmCalc>();
  for (const t of tasks) {
    const e = es.get(t.id) ?? 0;
    const l = ls.get(t.id) ?? 0;
    const fl = l - e;
    calc.set(t.id, {
      es: e,
      ef: ef.get(t.id) ?? 0,
      ls: l,
      lf: lf.get(t.id) ?? 0,
      float: fl,
      critical: fl === 0,
    });
  }

  // クリティカルパス（float=0 を開始から順にたどる）
  const criticalPath: string[] = [];
  if (!cycle) {
    for (const id of order) {
      if (calc.get(id)?.critical) criticalPath.push(id);
    }
  }

  return { calc, projectEnd, order, cycle, criticalPath };
}
