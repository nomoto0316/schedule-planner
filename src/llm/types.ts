// AI呼び出しの共通インターフェース（デモ／本物を差し替えられる）
import type { Task, PlanConfig, PastSchedule } from "../types";
import type { AgentKey } from "../data/demo";

export interface GenInput {
  project: string;
  config: PlanConfig;
  pasts: PastSchedule[];
  /** 取り込んだ工程表を「土台」にして再スケジュールする（元タスクを引き継ぎ・粒度維持） */
  baseOnPast?: boolean;
}

/** 生成の途中経過（1発言＝1ステップ） */
export interface StepEvent {
  agent: AgentKey;
  text: string;
  revise?: boolean;
  loop?: boolean;
  preview?: Task[];
}

export interface GenResult {
  tasks: Task[];
  improvements: { ok: boolean; text: string }[];
}

/** スケジュール生成を担うAIクライアント */
export interface LLMClient {
  generate(input: GenInput, onStep: (s: StepEvent) => void): Promise<GenResult>;
}
