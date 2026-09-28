// サーバー経由クライアント：/api/generate（サーバーレス関数）にPOSTし、
// SSE で流れてくるオーケストレーションのステップを onStep に渡す。
// 鍵はサーバー側(env)にあり、ブラウザには出ない。
import type { LLMClient, GenInput, GenResult, StepEvent } from "./types";

export class ServerClient implements LLMClient {
  async generate(input: GenInput, onStep: (s: StepEvent) => void): Promise<GenResult> {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!resp.ok || !resp.body) {
      let code = `status_${resp.status}`;
      try {
        const j = await resp.json();
        if (j && j.error) code = j.error;
      } catch {
        /* body が JSON でない場合は status コードのまま */
      }
      // nokey / 404（未デプロイ）などはフォールバック対象として投げる
      throw new Error(code);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: GenResult | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt: { error?: string; done?: boolean; result?: GenResult } & Partial<StepEvent>;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue; // 壊れた行はスキップ（ストリーム全体を落とさない）
          }
          if (evt.error) throw new Error(evt.error);
          if (evt.done) result = evt.result as GenResult;
          else onStep(evt as StepEvent);
        }
      }
    } finally {
      // ストリームを確実に解放（途中離脱・エラー時も含む）
      try {
        await reader.cancel();
      } catch {
        /* すでに閉じている場合は無視 */
      }
    }

    if (!result) throw new Error("incomplete_stream");
    return result;
  }
}
