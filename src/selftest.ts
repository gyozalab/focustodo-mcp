/**
 * 自測：純函式斷言 + 對真實 server 的端到端寫入循環。
 * 跑法：npm run selftest
 *
 * ⚠️ 驗證一律透過獨立的 `verifier` 實例讀取。用被測實例自己的 getter 會讀到
 * 它剛寫進去的本地快取，server 就算拒收也會通過——那種測試只是自我安慰。
 *
 * 端到端測試會在收件匣建 [MCP自測] 卡，跑完自動刪除。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

  // App 內建的智慧清單（PRJ_DEADLINE_OVERDUE、PRJ_PRIORITY_HIGH 等，type 4xxx/5xxx）
  // 是動態篩選視圖不是容器。漏掉這層過濾，任務會被建進 id-priority-high 之類的
  // 假清單，變成 App 看不到的孤兒。
  await check("智慧清單不該被當成可寫入的清單", async () => {
    const projects = await api.getProjects();
    for (const p of projects) {
      assert.ok(
        p.type === 1000 || p.type === 3000,
        `「${p.name}」type=${p.type} 是智慧清單，不該出現在清單列表`
      );
    }
    await assert.rejects(
      api.getTasks({ projectName: "PRJ_PRIORITY_HIGH" }),
      /找不到清單/,
      "智慧清單的名稱不該解析得到"
    );
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

  // 這一項是 2026-04-29 事故的迴歸測試。當時 server 的寫入可見延遲暫時拉長，
  // verify 等 1500ms 沒看到就報「server reject」，據此推論出並不存在的
  // 「anti-tampering 鎖」。校準用：確認 verify 的等待預算對實際延遲仍有裕度。
  await check("寫入可見延遲仍遠低於 verify 的等待預算", async () => {
    const id = createdIds[1];
    const marker = `[MCP自測] 延遲校準 ${Date.now() % 100000}`;
    const t0 = Date.now();
    await api.updateTask(id, { name: marker });
    const roundTrip = Date.now() - t0;

    await verifier.refresh();
    assert.equal((await verifier.getTaskById(id))!.name, marker, "server 應存到新名稱");
    // updateTask 內含一次 sync + 首輪 600ms 等待 + 一次 delta。沒有重試的話
    // 應該落在 3 秒內；超過就代表 server 變慢，等待預算該重新檢討。
    assert.ok(roundTrip < 3000, `單筆寫入含驗證耗時 ${roundTrip}ms，超過 3 秒代表 server 變慢`);
    console.log(`     （單筆寫入含驗證 ${roundTrip}ms）`);
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

  // Codex review 抓到的回歸：驗證讀取拿到 status!=0 時，原本 `data[kind] || []`
  // 會把它讀成「空的 delta」，於是已生效的寫入被報成失敗——2026-04-29 的同型錯誤。
  //
  // 直接注入 postSync 的回應，不靠 server 配合：壞 cookie 模擬不出來，
  // FocusTodo 認的是 body 裡的 acct/pid/uid，不是 JSESSIONID。
  await check("驗證讀取拿到 status!=0 要 throw，不能偽裝成空的 delta", async () => {
    const probe = new FocusToDoAPI(account, password) as unknown as {
      postSync: (...a: unknown[]) => Promise<unknown>;
      fetchDelta: (since: number, retry?: boolean) => Promise<{ tasks: unknown[] }>;
    };
    const emptyish = { timestamp: 0, projects: [], tasks: [], subtasks: [], pomodoros: [] };

    probe.postSync = async () => ({ status: -1, ...emptyish });
    await assert.rejects(
      probe.fetchDelta(Date.now(), false),
      /驗證讀取失敗/,
      "session 失效時應 throw，而不是回傳一份沒有 tasks 的空回應"
    );

    probe.postSync = async () => ({ status: -9, ...emptyish });
    await assert.rejects(probe.fetchDelta(Date.now(), false), /驗證讀取失敗/, "其他錯誤碼同樣要 throw");

    // status=0 要照常回傳，別把正常路徑也擋掉
    probe.postSync = async () => ({ status: 0, ...emptyish, tasks: [{ id: "x" }] });
    assert.equal((await probe.fetchDelta(Date.now(), false)).tasks.length, 1);
  });

  await checkHttpMode();

  console.log(failed ? `\n❌ ${failed} 項失敗` : "\n✅ 全部通過");
  if (createdIds.length) {
    console.log(`⚠️  自測卡殘留 ${createdIds.length} 張，請在 App 收件匣搜尋「[MCP自測]」刪除`);
  }
  process.exit(failed ? 1 : 0);
}

/**
 * HTTP 模式的迴歸測試。
 *
 * 這裡守的是一個靜態讀 code 看不出來、但會整站掛掉的 bug：舊版每個 /mcp 請求
 * 都對同一個 McpServer 實例 connect 一個新 transport，SDK 丟
 * 「Already connected to a transport」，在 async handler 裡變成 unhandled
 * rejection 直接殺掉 process——第二個請求開始全滅，連 /health 都沒了。
 *
 * ⚠️ 關鍵是「送兩次以上」。只測一次請求（或只 curl /health）永遠是綠的，
 * 當初就是這樣漏掉的。
 */
async function checkHttpMode(): Promise<void> {
  console.log("\n--- HTTP 模式 ---");
  if (!existsSync("dist/index.js")) {
    console.log("⚠️  找不到 dist/index.js，請先 npm run build。跳過 HTTP 模式測試");
    return;
  }

  const PORT = 8799;
  const TOKEN = "selftest-token";
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: TOKEN },
    stdio: "ignore",
  });

  const post = async (body: unknown, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  try {
    // 等 server 起來
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        /* 還沒起來 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    await check("/mcp 需要 Bearer token，錯的要 401", async () => {
      assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong")).status, 401);
    });

    await check("連續 3 次請求都要活著（第 2 次曾讓整個 process 死掉）", async () => {
      for (let i = 1; i <= 3; i++) {
        const init = await post({
          jsonrpc: "2.0",
          id: i,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "1" } },
        });
        assert.equal(init.status, 200, `第 ${i} 次 initialize 應為 200`);

        const list = await post({ jsonrpc: "2.0", id: i, method: "tools/list", params: {} });
        assert.equal(list.status, 200, `第 ${i} 次 tools/list 應為 200`);
        assert.ok(
          list.text.includes("focustodo_list_tasks"),
          `第 ${i} 次 tools/list 應列得出工具，實際：${list.text.slice(0, 120)}`
        );
      }
    });

    await check("跑完之後 /health 仍然活著", async () => {
      assert.ok((await fetch(`http://127.0.0.1:${PORT}/health`)).ok);
    });
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error("自測崩潰:", e);
  process.exit(1);
});
