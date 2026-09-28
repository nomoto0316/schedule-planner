// スケジュールの型定義（画面・AI出力・検証で共通に使う）

/** タスクの状態（未対応・処理中・処理済み・完了の4状態） */
export type Status = "todo" | "doing" | "review" | "done";

/** ガント1行ぶんのタスク */
export interface Task {
  id: string;
  name: string;
  /** 開始日（計画開始日からの日数インデックス。0 = 開始日当日） */
  start: number;
  /** 所要日数 */
  dur: number;
  status: Status;
  /** 発注〜納品や回線工事などの「待ち」期間か */
  ghost?: boolean;
  /** クリティカルパス上のタスクか */
  crit?: boolean;
  /** 見積りの根拠（参考にした過去実績など） */
  ref?: string;
  /** 手動設定の進捗率(0-100)。未設定なら status から算出する */
  progress?: number;
}

/** CPM計算に使う計画タスク（工数＋依存を持つ。開始日はCPMが算出する） */
export interface PlanTask {
  id: string;
  name: string;
  /** 工数（日数） */
  effort: number;
  /** 依存する先行タスクのid */
  deps: string[];
  status: Status;
  /** 見積りの根拠（参考にした過去実績など） */
  ref?: string;
}

/** 過去実績の1タスク（参考にする工数） */
export interface PastTask {
  name: string;
  days: number;
}

/** 参考にする過去のスケジュール */
export interface PastSchedule {
  name: string;
  tasks: PastTask[];
}

/** 計画全体の設定 */
export interface PlanConfig {
  /** 計画開始日（YYYY-MM-DD） */
  startDate: string;
  /** 完了希望日までの日数（開始日からのインデックス） */
  deadline: number;
  /** 今日（開始日からのインデックス。進捗ラインに使う） */
  today: number;
}

/** 状態の表示名と色（CSS 変数名） */
export const STATUS: Record<Status, { label: string; color: string }> = {
  todo: { label: "未対応", color: "var(--todo)" },
  doing: { label: "処理中", color: "var(--doing)" },
  review: { label: "処理済み", color: "var(--review)" },
  done: { label: "完了", color: "var(--done)" },
};

/** 状態ごとの進捗率（バーの塗りに使う） */
export const PROGRESS: Record<Status, number> = {
  todo: 0,
  doing: 0.34,
  review: 0.67,
  done: 1,
};
