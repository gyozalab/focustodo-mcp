/**
 * 自測：純函式斷言 + 對真實 server 的端到端寫入循環。
 * 跑法：npm run selftest
 *
 * ⚠️ 驗證一律透過獨立的 `verifier` 實例讀取。用被測實例自己的 getter 會讀到
 * 它剛寫進去的本地快取，server 就算拒收也會通過——那種測試只是自我安慰。
 *
 * 端到端測試會在收件匣建 [MCP自測] 卡，跑完自動刪除。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { FocusToDoAPI, parseDeadline, todayBounds, INBOX_PROJECT_ID } from "./api.js";

let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${label}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${label}\n     ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  // ---- 純函式 ----
  await check("parseDeadline: 純日期 → 當地時區當天 23:59:59.999", () => {
    const d = new Date(parseDeadline("2026-08-05"));
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7);
    assert.equal(d.getDate(), 5);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
  });

  await check("parseDeadline: 帶時間的 ISO 照原值", () => {
    assert.equal(new Date(parseDeadline("2026-08-05T09:30")).getHours(), 9);
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

  console.log("\n--- 端到端（真實 server，獨立實例驗證）---");
  const api = new FocusToDoAPI(account, password);
  const verifier = new FocusToDoAPI(account, password);

  /** 從 server 重新讀取，不碰被測實例的快取 */
  const fromServer = async (taskId: string) => {
    await verifier.refresh();
    return verifier.getTaskById(taskId);
  };

  const createdIds: string[] = [];

  await check("讀取清單", async () => {
    assert.ok((await api.getProjects()).length > 0, "清單數應大於 0");
  });

  await check("清單名稱打錯要報錯，不能靜默回空清單", async () => {
    await assert.rejects(api.getTasks({ projectName: "絕對不存在的清單xyz" }), /找不到清單/);
  });

  await check("收件匣任務顯示得出歸屬（收件匣不是真 project）", async () => {
    const inboxTasks = await api.getTasks({ projectName: "收件匣" });
    assert.ok(inboxTasks.length > 0, "應找得到收件匣任務");
    assert.equal(inboxTasks[0].projectName, "收件匣");
  });

  await check("批次建立 3 個任務（server 已確認），order 排在最前", async () => {
    const before = await api.getTasks({});
    const minOrder = Math.min(...before.map((t) => t.order));
    const created = await api.createTasks([
      { name: "[MCP自測] 甲", estimatePomoNum: 1, deadline: parseDeadline("2026-12-31") },
      { name: "[MCP自測] 乙" },
      { name: "[MCP自測] 丙" },
    ]);
    createdIds.push(...created.map((t) => t.id));
    assert.equal(created.length, 3);
    for (const t of created) {
      assert.equal(t.projectId, INBOX_PROJECT_ID, "應落收件匣而非空字串");
      assert.ok(t.order < minOrder, `order ${t.order} 應小於既有最小值 ${minOrder}`);
    }
    assert.equal(new Set(created.map((t) => t.order)).size, 3, "同批 order 不可重複");
    // 從 server 確認
    const onServer = await fromServer(created[0].id);
    assert.equal(onServer?.name, "[MCP自測] 甲");
  });

  await check("建到不存在的清單要報錯，整批不送出", async () => {
    const before = (await api.getTasks({})).length;
    await assert.rejects(
      api.createTasks([
        { name: "[MCP自測] 不該存在A" },
        { name: "[MCP自測] 不該存在B", projectName: "絕對不存在的清單xyz" },
      ]),
      /找不到清單/
    );
    assert.equal((await api.getTasks({})).length, before, "同批的第一筆也不該被建立");
  });

  await check("補記番茄鐘：server 存得到，任務計數也累加", async () => {
    const id = createdIds[0];
    const before = await fromServer(id);
    const pomo = await api.logPomodoro({ taskId: id, minutes: 25 });
    assert.equal(pomo.interval, 1500);
    const after = await fromServer(id);
    assert.equal(after!.actualPomoNum, before!.actualPomoNum + 1, "任務番茄計數應 +1");
    const logged = await verifier.getPomodoros({ taskId: id });
    assert.ok(logged.some((p) => p.id === pomo.id), "server 上應查得到這筆番茄鐘");
  });

  await check("更新任務：改名 + 搬清單，server 確認", async () => {
    const id = createdIds[0];
    await api.updateTask(id, { name: "[MCP自測] 已改名", priority: 3 });
    const onServer = await fromServer(id);
    assert.equal(onServer!.name, "[MCP自測] 已改名");
    assert.equal(onServer!.priority, 3);
  });

  await check("子任務：建立 → 完成，server 確認", async () => {
    const id = createdIds[0];
    const sub = await api.createSubtask({ taskId: id, name: "[MCP自測] 子項" });
    await api.updateSubtask(sub.id, { isFinished: true });
    await verifier.refresh();
    const subs = await verifier.getSubtasks(id);
    const found = subs.find((s) => s.id === sub.id);
    assert.ok(found, "server 上應查得到子任務");
    assert.equal(found!.isFinished, true, "server 上應為已完成");
    assert.equal((await fromServer(id))!.hasSubtask, true, "父任務應標記 hasSubtask");
  });

  await check("批次完成 3 個 → 再批次取消完成，server 確認", async () => {
    const done = await api.completeTasks(createdIds);
    assert.equal(done.failed.length, 0, `不該有失敗：${JSON.stringify(done.failed)}`);
    assert.equal(done.updated.length, 3);
    await verifier.refresh();
    for (const id of createdIds) {
      assert.equal((await verifier.getTaskById(id))!.isFinished, true, `${id} 應為已完成`);
    }
    const undone = await api.uncompleteTasks(createdIds);
    assert.equal(undone.updated.length, 3);
    await verifier.refresh();
    assert.equal((await verifier.getTaskById(createdIds[0]))!.isFinished, false);
  });

  await check("批次操作混入不存在的 ID：好的照做，壞的個別回報", async () => {
    const r = await api.updateTasks([createdIds[1], "不存在的-id-12345"], { priority: 2 });
    assert.equal(r.updated.length, 1, "有效的那筆應成功");
    assert.equal(r.failed.length, 1, "無效的那筆應回報失敗");
    assert.match(r.failed[0].reason, /找不到/);
    assert.equal((await fromServer(createdIds[1]))!.priority, 2);
  });

  await check("批次刪除 3 個，server 確認且不再出現在清單", async () => {
    const r = await api.deleteTasks(createdIds);
    assert.equal(r.failed.length, 0, `不該有失敗：${JSON.stringify(r.failed)}`);
    await verifier.refresh();
    const visible = await verifier.getTasks({});
    for (const id of createdIds) {
      assert.ok(!visible.some((t) => t.id === id), `${id} 不該還在清單裡`);
    }
    createdIds.length = 0;
  });

  console.log(failed ? `\n❌ ${failed} 項失敗` : "\n✅ 全部通過");
  if (createdIds.length) {
    console.log(`⚠️  自測卡殘留 ${createdIds.length} 張，請在 App 收件匣搜尋「[MCP自測]」刪除`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("自測崩潰:", e);
  process.exit(1);
});
