/**
 * 自測：純函式斷言 + 對真實 server 的端到端寫入循環。
 * 跑法：npm run selftest
 *
 * 端到端測試會在收件匣建一張 [MCP自測] 卡，跑完自動刪除。
 * 任何一步失敗都會印出來，不會靜默通過。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { FocusToDoAPI, parseDeadline, todayBounds, INBOX_PROJECT_ID } from "./api.js";

let failed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✅ ${label}`))
    .catch((e) => {
      failed++;
      console.log(`❌ ${label}\n     ${e instanceof Error ? e.message : e}`);
    });
}

async function main() {
  // ---- 純函式 ----
  await check("parseDeadline: 純日期 → 當地時區當天 23:59:59.999", () => {
    const ts = parseDeadline("2026-08-05");
    const d = new Date(ts);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7);
    assert.equal(d.getDate(), 5);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
  });

  await check("parseDeadline: 帶時間的 ISO 照原值", () => {
    const ts = parseDeadline("2026-08-05T09:30");
    assert.equal(new Date(ts).getHours(), 9);
  });

  await check("parseDeadline: 壞輸入要 throw", () => {
    assert.throws(() => parseDeadline("not-a-date"));
  });

  await check("todayBounds: 剛好一天且涵蓋現在", () => {
    const { start, end } = todayBounds();
    assert.equal(end - start, 86400000);
    const now = Date.now();
    assert.ok(now >= start && now < end);
  });

  // ---- 端到端 ----
  const account = process.env.FOCUSTODO_ACCOUNT;
  const password = process.env.FOCUSTODO_PASSWORD;
  if (!account || !password) {
    console.log("\n⚠️  缺少 FOCUSTODO_ACCOUNT / FOCUSTODO_PASSWORD，跳過端到端測試");
    process.exit(failed ? 1 : 0);
  }

  console.log("\n--- 端到端（真實 server）---");
  const api = new FocusToDoAPI(account, password);
  let taskId = "";

  await check("讀取清單", async () => {
    const projects = await api.getProjects();
    assert.ok(projects.length > 0, "清單數應大於 0");
  });

  await check("建立任務（無 projectName → 落收件匣，不是孤兒）", async () => {
    const [t] = await api.createTasks([
      { name: "[MCP自測] 請忽略", estimatePomoNum: 1, deadline: parseDeadline("2026-12-31") },
    ]);
    taskId = t.id;
    assert.equal(t.projectId, INBOX_PROJECT_ID, "應落在收件匣而非空字串");
  });

  await check("建到不存在的清單要報錯，不能靜默丟失", async () => {
    await assert.rejects(
      api.createTasks([{ name: "[MCP自測] 不該存在", projectName: "絕對不存在的清單xyz" }]),
      /找不到清單/
    );
  });

  await check("補記番茄鐘並累加任務計數", async () => {
    const before = await api.getTaskById(taskId);
    const pomo = await api.logPomodoro({ taskId, minutes: 25 });
    assert.equal(pomo.interval, 1500);
    const after = await api.getTaskById(taskId);
    assert.equal(after!.actualPomoNum, before!.actualPomoNum + 1);
    const logged = await api.getPomodoros({ taskId });
    assert.ok(logged.some((p) => p.id === pomo.id), "番茄鐘應查得到");
  });

  await check("更新任務名稱（含 server 端驗證）", async () => {
    const t = await api.updateTask(taskId, { name: "[MCP自測] 已改名" });
    assert.equal(t!.name, "[MCP自測] 已改名");
  });

  await check("子任務：建立 → 完成", async () => {
    const sub = await api.createSubtask({ taskId, name: "[MCP自測] 子項" });
    const done = await api.updateSubtask(sub.id, { isFinished: true });
    assert.equal(done!.isFinished, true);
    const parent = await api.getTaskById(taskId);
    assert.equal(parent!.hasSubtask, true, "父任務應標記 hasSubtask");
  });

  await check("標記完成 → 取消完成", async () => {
    const done = await api.completeTask(taskId);
    assert.equal(done!.isFinished, true);
    const undone = await api.uncompleteTask(taskId);
    assert.equal(undone!.isFinished, false);
  });

  await check("刪除任務（含 server 端驗證）", async () => {
    const t = await api.deleteTask(taskId);
    assert.equal(t!.isDeleted, true);
    await api.refresh();
    const visible = await api.getTasks({});
    assert.ok(!visible.some((x) => x.id === taskId), "已刪任務不該出現在清單");
  });

  console.log(failed ? `\n❌ ${failed} 項失敗` : "\n✅ 全部通過");
  if (failed && taskId) console.log(`⚠️  自測卡可能殘留，請在 App 收件匣搜尋「[MCP自測]」刪除`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("自測崩潰:", e);
  process.exit(1);
});
