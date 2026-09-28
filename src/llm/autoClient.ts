// 自動切替クライアント：まずサーバー（本物のAI）で実行し、
// サーバー未接続・キー未設定（nokey/404 など、ステップ開始前の失敗）のときだけ
// デモ再生へ自動フォールバックする。ストリーム開始後の失敗はそのまま伝える。
import type { LLMClient, GenInput, GenResult, StepEvent } from "./types";
import { ServerClient } from "./serverClient";
import { DemoClient } from "./demoClient";

export type RunMode = "server" | "demo";

// フォールバック対象＝「サーバーに繋がらない/鍵が無い」系（実行前に判る失敗）
const FALLBACK = new Set(["nokey", "status_404", "status_405", "status_501", "status_502", "status_503"]);

export class AutoClient implements LLMClient {
  /** 直近の実行がサーバー(本物)かデモ再生か */
  lastMode: RunMode = "server";
  /** モード確定時に呼ばれる（UIの表示切替用） */
  onMode?: (m: RunMode, reason?: string) => void;

  constructor(onMode?: (m: RunMode, reason?: string) => void) {
    this.onMode = onMode;
  }

  async generate(input: GenInput, onStep: (s: StepEvent) => void): Promise<GenResult> {
    let started = false;
    const wrap = (s: StepEvent) => {
      started = true;
      onStep(s);
    };
    try {
      const r = await new ServerClient().generate(input, wrap);
      this.lastMode = "server";
      this.onMode?.("server");
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const canFallback = !started && (FALLBACK.has(msg) || /Failed to fetch|NetworkError|load failed/i.test(msg));
      if (!canFallback) throw e;
      // サーバー未接続 → デモ再生
      this.lastMode = "demo";
      this.onMode?.("demo", msg);
      return new DemoClient().generate(input, onStep);
    }
  }
}
