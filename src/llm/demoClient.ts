// デモ用クライアント：決まったシナリオを時間差で再生する（AIは呼ばない）
import type { LLMClient, GenInput, GenResult, StepEvent } from "./types";
import { ORCH_STEPS, demoBefore, demoTasks, IMPROVEMENTS, buildScoutText, esc } from "../data/demo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoClient implements LLMClient {
  async generate(input: GenInput, onStep: (s: StepEvent) => void): Promise<GenResult> {
    // 案件名は v-html に流し込まれるためエスケープする（XSS対策）
    const proj = esc(input.project?.trim() || "この案件");
    for (const e of ORCH_STEPS) {
      let text = e.agent === "scout" && !e.text ? buildScoutText(input.pasts) : e.text;
      if (e.agent === "analyst") text = `「${proj}」の${e.text}`;
      if (e.agent === "intg") text = `「${proj}」の${e.text}`;
      onStep({
        agent: e.agent,
        text,
        revise: e.revise,
        loop: e.loop,
        preview: e.gantt === "before" ? demoBefore() : e.gantt === "after" ? demoTasks() : undefined,
      });
      await sleep(e.loop ? 1400 : e.revise ? 1500 : 1100);
    }
    return { tasks: demoTasks(), improvements: IMPROVEMENTS };
  }
}
