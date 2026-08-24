// ==UserScript==
// @name         NJU 补选助手（收藏课程）
// @namespace    local.codex.nju
// @version      0.3.1
// @description  在南京大学本科选课平台中轮询本人勾选的收藏课程，成功后自动停止该课程。
// @match        https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/*default/grablessons.do*
// @downloadURL  https://raw.githubusercontent.com/Eurus07e/NJU-Course-Grabber/main/nju-course-grabber.user.js
// @updateURL    https://raw.githubusercontent.com/Eurus07e/NJU-Course-Grabber/main/nju-course-grabber.user.js
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const PANEL_ID = "nju-course-grabber-root";
  const MIN_INTERVAL_MS = 1500;
  const DEFAULT_INTERVAL_MS = 2000;
  const MAX_LOG_LINES = 120;
  const PROCESS_POLL_MS = 1000;
  const PROCESS_POLL_LIMIT = 12;
  const READ_REQUEST_TIMEOUT_MS = 12000;
  const WRITE_REQUEST_TIMEOUT_MS = 12000;
  const RESULT_REQUEST_TIMEOUT_MS = 8000;

  if (document.getElementById(PANEL_ID)) return;

  const state = {
    courses: [],
    selected: new Set(),
    completed: new Set(),
    disabled: new Set(),
    attempts: new Map(),
    running: false,
    busy: false,
    timer: null,
    runId: 0,
    lastSubmitAt: 0,
    cursor: 0,
    failureStreak: 0,
    collapsed: false,
    lastHeartbeatAt: 0,
    nextRunAt: 0,
    monitorTimer: null,
    requiresRefresh: false,
  };

  let ui = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRunActive(runId) {
    return state.running && state.runId === runId;
  }

  async function sleepWhileActive(ms, runId) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isRunActive(runId)) return false;
      await sleep(Math.min(200, deadline - Date.now()));
    }
    return isRunActive(runId);
  }

  async function waitForIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (state.busy && Date.now() < deadline) await sleep(50);
    if (state.busy) throw new Error("上一轮请求尚未结束，请稍后重试");
  }

  function asPromise(value) {
    if (value && typeof value.then === "function") {
      return Promise.resolve(value);
    }
    return Promise.resolve(value);
  }

  function callWithTimeout(factory, label, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      let request = null;
      let timer = null;
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };

      try {
        request = factory();
      } catch (error) {
        finish(reject, error);
        return;
      }

      asPromise(request).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (options.abort && request && typeof request.abort === "function") {
          try {
            request.abort();
          } catch (_) {
            // Ignore abort failures; the late response is still ignored below.
          }
        }
        const error = new Error(`${label}超时`);
        error.code = "REQUEST_TIMEOUT";
        error.outcomeUnknown = Boolean(options.outcomeUnknown);
        reject(error);
      }, timeoutMs);
    });
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function now() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  function clock(timestamp) {
    return timestamp
      ? new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false })
      : "--:--:--";
  }

  function updateRunMonitor() {
    if (!ui || !ui.host.isConnected) return;

    let type = "stopped";
    let message = "已停止";
    if (state.running && state.busy) {
      const checkingTooLong = Date.now() - state.lastHeartbeatAt > 20000;
      type = checkingTooLong ? "stale" : "checking";
      message = checkingTooLong
        ? `检查超时，可能卡住 · 开始于 ${clock(state.lastHeartbeatAt)}`
        : `正在检查 · 开始于 ${clock(state.lastHeartbeatAt)}`;
    } else if (state.running) {
      const remaining = state.nextRunAt
        ? Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 1000))
        : 0;
      const overdue = state.nextRunAt && Date.now() - state.nextRunAt > 5000;
      if (overdue) {
        type = "stale";
        message = `可能卡住 · 上次检查 ${clock(state.lastHeartbeatAt)}`;
      } else {
        type = "running";
        message = `运行中 · 上次 ${clock(state.lastHeartbeatAt)} · 下次 ${remaining} 秒`;
      }
    }

    ui.monitor.dataset.type = type;
    ui.monitorText.textContent = message;
    updateGrabbedCount();
  }

  function updateGrabbedCount() {
    if (!ui || !ui.grabbedCount) return;
    const count = state.completed.size;
    ui.grabbedCount.hidden = count === 0;
    ui.grabbedCount.textContent = count ? `本次已抢到 ${count} 门课` : "";
  }

  function log(message, level = "info") {
    if (!ui) return;
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = `[${now()}] ${message}`;
    ui.log.prepend(line);
    while (ui.log.childElementCount > MAX_LOG_LINES) {
      ui.log.lastElementChild.remove();
    }
    ui.log.scrollTop = 0;
  }

  function readStudentInfo() {
    const raw = page.sessionStorage && page.sessionStorage.getItem("studentInfo");
    const token = page.sessionStorage && page.sessionStorage.getItem("token");
    if (!raw || !token) {
      throw new Error("未检测到登录态，请先登录并进入课程列表页面");
    }

    let info;
    try {
      info = JSON.parse(raw);
    } catch (_) {
      throw new Error("无法解析当前登录信息，请重新登录选课平台");
    }

    if (!info || !info.code) {
      throw new Error("登录信息中缺少学号，请重新登录选课平台");
    }
    return info;
  }

  function currentBatch(info) {
    if (info.electiveBatch && info.electiveBatch.code) return info.electiveBatch;
    if (Array.isArray(info.electiveBatchList) && info.electiveBatchList.length) {
      return info.electiveBatchList.find((item) => item && item.code) || null;
    }
    return null;
  }

  function currentCampusCode() {
    try {
      const raw = page.sessionStorage.getItem("currentCampus");
      return raw ? text(JSON.parse(raw).code) : "";
    } catch (_) {
      return "";
    }
  }

  function resolveCourseKind(course, info, teachingClassType) {
    if (course.courseKind != null && text(course.courseKind)) {
      return text(course.courseKind);
    }

    const batch = currentBatch(info);
    const menus = batch && Array.isArray(batch.limitMenuList) ? batch.limitMenuList : [];
    const menu = menus.find((item) => text(item.menuCode) === teachingClassType);
    return menu && menu.courseKind != null ? text(menu.courseKind) : "";
  }

  function courseAvailability(course) {
    const keys = ["isFull", "full", "isfull"];
    const key = keys.find((name) => Object.prototype.hasOwnProperty.call(course, name));
    if (!key) return "unknown";

    const value = text(course[key]).toLowerCase();
    if (["1", "true", "yes"].includes(value)) return "full";
    if (["", "0", "false", "no"].includes(value)) return "available";
    return "unknown";
  }

  function normalizeCourse(course, info, batch) {
    const id = text(
      course.teachingClassID ||
      course.teachingClassId ||
      course.teachingClassid ||
      course.JXBID
    );
    if (!id) return null;

    const teachingClassType = text(
      course.teachingClassType || course.menuCode || course.typeCode || "SC"
    );
    const name = text(
      course.courseName || course.KCMC || course.name || course.courseNumber || id
    );

    const chosen = ["1", "true", "yes"].includes(text(course.isChoose).toLowerCase());
    return {
      id,
      name,
      number: text(course.courseNumber || course.KCH || course.number),
      teacher: text(course.teacherName || course.JSMC || course.teacher),
      place: text(course.teachingPlace || course.SJDD || course.place),
      batchCode: text(course.electiveBatchCode || (batch && batch.code)),
      teachingClassType,
      courseKind: resolveCourseKind(course, info, teachingClassType),
      chosen,
      availability: chosen ? "chosen" : courseAvailability(course),
      raw: course,
    };
  }

  function requirePageApi() {
    const missing = ["queryfavoriteResults", "addVolunteer", "queryOperateProcessData"]
      .filter((name) => typeof page[name] !== "function");
    if (missing.length) {
      throw new Error(`选课页面尚未加载完成，缺少：${missing.join(", ")}`);
    }
  }

  async function waitForPageApi(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        requirePageApi();
        return;
      } catch (_) {
        await sleep(250);
      }
    }
    requirePageApi();
  }

  function makeFavoriteQuery(info, batch) {
    const data = {
      studentCode: text(info.code),
      electiveBatchCode: text(batch.code),
      teachingClassType: "SC",
      queryContent: "",
    };
    const campus = currentCampusCode();
    if (campus) data.campus = campus;

    return {
      querySetting: JSON.stringify({
        data,
        pageSize: "200",
        pageNumber: "0",
        order: "isChoose -",
      }),
    };
  }

  function isExpiredResponse(response) {
    return text(response && response.code) === "302" ||
      /登录|token|会话.*失效|身份.*失效/i.test(text(response && response.msg));
  }

  function sessionExpiredError(message) {
    const error = new Error(message || "登录态已经失效，请重新登录选课平台");
    error.code = "SESSION_EXPIRED";
    return error;
  }

  async function fetchFavoriteSnapshot() {
    await waitForPageApi();
    const info = readStudentInfo();
    const batch = currentBatch(info);
    if (!batch || !batch.code) {
      throw new Error("没有找到当前选课轮次，请先在页面中选择轮次");
    }

    const response = await callWithTimeout(
      () => page.queryfavoriteResults(makeFavoriteQuery(info, batch)),
      "读取收藏课程",
      READ_REQUEST_TIMEOUT_MS,
      { abort: true }
    );
    if (isExpiredResponse(response)) throw sessionExpiredError();
    if (text(response && response.code) !== "1") {
      throw new Error(text(response && response.msg) || "收藏列表读取失败");
    }

    const list = Array.isArray(response.dataList) ? response.dataList : [];
    return {
      info,
      batch,
      courses: list.map((item) => normalizeCourse(item, info, batch)).filter(Boolean),
    };
  }

  async function loadFavorites() {
    stop("重新加载收藏列表");
    setStatus("正在读取收藏课程…", "working");
    ui.load.disabled = true;

    try {
      await waitForIdle();
      const snapshot = await fetchFavoriteSnapshot();
      state.courses = snapshot.courses;
      state.selected.clear();
      state.completed.clear();
      state.disabled.clear();
      state.attempts.clear();
      state.cursor = 0;
      state.failureStreak = 0;
      for (const course of state.courses) {
        state.selected.add(course.id);
      }
      renderCourses();
      setStatus(`已载入 ${state.courses.length} 门收藏课程`, "ready");
      log(`已载入 ${state.courses.length} 门收藏课程，当前轮次：${text(snapshot.batch.name || snapshot.batch.code)}`);
    } catch (error) {
      setStatus(error.message, "error");
      log(error.message, "error");
    } finally {
      ui.load.disabled = false;
    }
  }

  function buildAddParam(course, info) {
    if (!course.batchCode || !course.teachingClassType) {
      throw new Error(`${course.name} 缺少轮次或课程类型信息`);
    }
    const payload = {
      addParam: JSON.stringify({
        data: {
          operationType: "1",
          studentCode: text(info.code),
          electiveBatchCode: course.batchCode,
          teachingClassId: course.id,
          courseKind: course.courseKind,
          teachingClassType: course.teachingClassType,
        },
      }),
    };
    if (JSON.parse(payload.addParam).data.operationType !== "1") {
      throw new Error("安全检查失败：只允许执行选课操作");
    }
    return payload;
  }

  async function refreshAvailability(runId) {
    const snapshot = await fetchFavoriteSnapshot();
    if (!isRunActive(runId)) return false;

    const latest = new Map(snapshot.courses.map((course) => [course.id, course]));
    state.courses = state.courses.map((course) => {
      const fresh = latest.get(course.id);
      if (!fresh) {
        if (course.availability !== "unknown") {
          log(`${course.name} 暂时未在收藏列表中查到，本轮不会操作`, "warn");
        }
        return { ...course, availability: "unknown" };
      }

      if (fresh.chosen && !course.chosen && state.selected.has(course.id)) {
        state.completed.add(course.id);
        log(`${course.name} 已在系统中选中，停止尝试这门课`, "course-success");
      } else if (fresh.availability !== course.availability && state.selected.has(course.id)) {
        if (fresh.availability === "available") log(`${course.name} 检测到空位`, "success");
        if (fresh.availability === "full") log(`${course.name} 当前已满，继续等待`);
        if (fresh.availability === "unknown") log(`${course.name} 余量状态不明确，本轮不会操作`, "warn");
      }
      return { ...course, ...fresh };
    });
    renderCourses();
    return true;
  }

  async function pollResult(course, runId) {
    for (let count = 0; count < PROCESS_POLL_LIMIT; count += 1) {
      if (!await sleepWhileActive(PROCESS_POLL_MS, runId)) {
        return { code: "cancelled", msg: "任务已停止" };
      }
      const result = await callWithTimeout(
        () => page.queryOperateProcessData("1", course.id),
        "查询选课结果",
        RESULT_REQUEST_TIMEOUT_MS,
        { abort: true, outcomeUnknown: true }
      );
      if (!isRunActive(runId)) return { code: "cancelled", msg: "任务已停止" };
      const code = text(result && result.code);
      if (code === "1" || code === "-1" || code === "302") return result;
    }
    return { code: "0", msg: "处理结果查询超时" };
  }

  function classifyResult(result) {
    const code = text(result && result.code);
    const message = text(result && result.msg) || text(result && result.extmsg) || "未知响应";

    if (code === "1") {
      return { kind: "success", message };
    }
    if (code === "cancelled") {
      return { kind: "cancelled", message };
    }
    if (isExpiredResponse(result) || /非法请求/.test(message)) {
      return { kind: "expired", message };
    }
    if (/冲突|超过.*上限|无.*资格|重复修读/.test(message)) {
      return { kind: "fatal", message };
    }
    return { kind: "retry", message };
  }

  async function waitForSubmitSlot(runId) {
    const requiredGap = intervalMs() + Math.floor(Math.random() * 500);
    const remaining = Math.max(0, state.lastSubmitAt + requiredGap - Date.now());
    if (remaining && !await sleepWhileActive(remaining, runId)) return false;
    return isRunActive(runId);
  }

  async function attemptCourse(course, runId) {
    if (!await waitForSubmitSlot(runId)) {
      return { kind: "cancelled", message: "任务已停止" };
    }

    if (!state.selected.has(course.id) || course.availability !== "available") {
      return { kind: "skipped", message: "没有确认空位" };
    }

    const attempts = (state.attempts.get(course.id) || 0) + 1;
    state.attempts.set(course.id, attempts);
    renderCourses();
    log(`第 ${attempts} 次尝试：${course.name}${course.teacher ? ` / ${course.teacher}` : ""}`);

    const info = readStudentInfo();
    state.lastSubmitAt = Date.now();
    const immediate = await callWithTimeout(
      () => page.addVolunteer(buildAddParam(course, info)),
      "提交选课请求",
      WRITE_REQUEST_TIMEOUT_MS,
      { outcomeUnknown: true }
    );
    if (!isRunActive(runId)) return { kind: "cancelled", message: "任务已停止" };
    if (isExpiredResponse(immediate)) return classifyResult(immediate);
    if (text(immediate && immediate.code) !== "1") return classifyResult(immediate);

    return classifyResult(await pollResult(course, runId));
  }

  function activeCourses() {
    return state.courses.filter((course) =>
      state.selected.has(course.id) &&
      !state.completed.has(course.id) &&
      !state.disabled.has(course.id) &&
      !course.chosen
    );
  }

  function intervalMs() {
    const raw = ui.interval.value.trim();
    if (!raw) return DEFAULT_INTERVAL_MS;
    const parsed = Number(raw);
    const value = Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_INTERVAL_MS;
    return Math.max(MIN_INTERVAL_MS, value);
  }

  function normalizeIntervalInput() {
    if (!ui.interval.value.trim()) return;
    ui.interval.value = String(intervalMs());
  }

  function scheduleNext(runId) {
    if (!isRunActive(runId)) return;
    const baseDelay = intervalMs() + Math.floor(Math.random() * 500);
    const delay = Math.min(30000, baseDelay * Math.max(1, 2 ** state.failureStreak));
    clearTimeout(state.timer);
    state.nextRunAt = Date.now() + delay;
    state.timer = setTimeout(() => runRound(runId), delay);
    updateRunMonitor();
  }

  function nextAvailableCourse(pending) {
    if (!pending.length) return null;
    const start = state.cursor % pending.length;
    for (let offset = 0; offset < pending.length; offset += 1) {
      const index = (start + offset) % pending.length;
      if (pending[index].availability === "available") {
        state.cursor = (index + 1) % pending.length;
        return pending[index];
      }
    }
    return null;
  }

  async function runRound(runId) {
    if (!isRunActive(runId) || state.busy) return;
    state.busy = true;
    state.nextRunAt = 0;
    state.lastHeartbeatAt = Date.now();
    updateRunMonitor();

    try {
      await refreshAvailability(runId);
      if (!isRunActive(runId)) return;
      state.lastHeartbeatAt = Date.now();
      state.failureStreak = 0;

      const pending = activeCourses();
      if (!pending.length) {
        stop("所选课程均已成功或停止重试");
        return;
      }

      const course = nextAvailableCourse(pending);
      if (!course) {
        const fullCount = pending.filter((item) => item.availability === "full").length;
        const unknownCount = pending.filter((item) => item.availability === "unknown").length;
        setStatus(`等待空位：已满 ${fullCount} 门，状态未知 ${unknownCount} 门`, "working");
        renderCourses();
        return;
      }

      const outcome = await attemptCourse(course, runId);
      if (outcome.kind === "success") {
        state.completed.add(course.id);
        log(`${course.name}：${outcome.message}`, "course-success");
      } else if (outcome.kind === "fatal") {
        state.disabled.add(course.id);
        log(`${course.name} 已停止重试：${outcome.message}`, "error");
      } else if (outcome.kind === "expired") {
        log(`登录态失效：${outcome.message}`, "error");
        stop("登录态失效，请重新登录");
      } else if (outcome.kind === "retry") {
        log(`${course.name}：${outcome.message}`, "warn");
      }
      renderCourses();
    } catch (error) {
      if (error && error.code === "SESSION_EXPIRED") {
        log(error.message, "error");
        stop(error.message);
      } else if (error && error.code === "REQUEST_TIMEOUT" && error.outcomeUnknown) {
        state.requiresRefresh = true;
        const message = `${error.message}，结果暂时无法确认；为避免重复提交，已停止，请刷新页面确认选课结果`;
        log(message, "error");
        stop("请求超时，已安全停止；请刷新页面确认选课结果");
      } else if (isRunActive(runId)) {
        state.failureStreak = Math.min(state.failureStreak + 1, 4);
        log(`网络或页面异常：${error.message}，稍后重试`, "error");
        setStatus("连接异常，正在等待重试", "error");
      }
    } finally {
      state.busy = false;
      state.lastHeartbeatAt = Date.now();
      if (isRunActive(runId)) {
        scheduleNext(runId);
      } else if (ui && ui.host.isConnected) {
        ui.start.disabled = state.requiresRefresh;
        ui.load.disabled = false;
        renderCourses();
      }
      updateRunMonitor();
    }
  }

  function start() {
    if (state.running) return;
    if (state.requiresRefresh) {
      setStatus("上次提交结果无法确认，请先刷新页面", "error");
      return;
    }
    if (state.busy) {
      setStatus("上一轮请求正在结束，请稍候", "working");
      return;
    }
    const targets = activeCourses();
    if (!targets.length) {
      setStatus("请先勾选至少一门未选中的收藏课程", "error");
      return;
    }

    intervalMs();
    state.runId += 1;
    state.lastSubmitAt = 0;
    state.cursor = 0;
    state.failureStreak = 0;
    state.lastHeartbeatAt = Date.now();
    state.nextRunAt = Date.now();
    state.running = true;
    ui.start.disabled = true;
    ui.stop.disabled = false;
    ui.load.disabled = true;
    setStatus(`运行中：${targets.length} 门目标课程`, "working");
    log(`开始运行；间隔不少于 ${intervalMs()} ms，逐门顺序提交`);
    updateRunMonitor();
    runRound(state.runId);
  }

  function stop(reason = "已手动停止") {
    const wasRunning = state.running;
    state.running = false;
    state.runId += 1;
    clearTimeout(state.timer);
    state.timer = null;
    state.nextRunAt = 0;

    if (ui) {
      ui.start.disabled = state.busy || state.requiresRefresh;
      ui.stop.disabled = true;
      ui.load.disabled = state.busy;
      if (wasRunning || reason) setStatus(reason, "ready");
    }
    if (wasRunning) log(reason, "warn");
    updateRunMonitor();
  }

  function setStatus(message, type) {
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.dataset.type = type || "ready";
  }

  function renderCourses() {
    if (!ui) return;
    ui.list.replaceChildren();
    updateGrabbedCount();

    if (!state.courses.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "点击“读取收藏”后，在这里选择目标课程。";
      ui.list.appendChild(empty);
      return;
    }

    for (const course of state.courses) {
      const row = document.createElement("label");
      row.className = "course";
      if (state.completed.has(course.id) || course.chosen) row.dataset.state = "success";
      if (state.disabled.has(course.id)) row.dataset.state = "error";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(course.id);
      checkbox.disabled = state.running || state.busy || course.chosen || state.completed.has(course.id) || state.disabled.has(course.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(course.id);
        else state.selected.delete(course.id);
      });

      const body = document.createElement("span");
      body.className = "course-body";
      const title = document.createElement("strong");
      title.textContent = course.name;
      const detail = document.createElement("small");
      detail.textContent = [course.number, course.teacher, course.place].filter(Boolean).join(" · ") || course.id;
      body.append(title, detail);

      const badge = document.createElement("span");
      badge.className = "badge";
      if (course.chosen) badge.textContent = "已选";
      else if (state.completed.has(course.id)) badge.textContent = "成功";
      else if (state.disabled.has(course.id)) badge.textContent = "已停止";
      else if (course.availability === "full") badge.textContent = "已满";
      else if (course.availability === "available") badge.textContent = "有空位";
      else if (course.availability === "unknown") badge.textContent = "状态未知";
      else badge.textContent = `${state.attempts.get(course.id) || 0} 次`;

      row.append(checkbox, body, badge);
      ui.list.appendChild(row);
    }
  }

  function setupPanelMotion() {
    const margin = 8;
    let drag = null;

    function clampPanel(left, top) {
      if (!ui || !ui.host.isConnected) return;
      const rect = ui.panel.getBoundingClientRect();
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      ui.host.style.right = "auto";
      ui.host.style.bottom = "auto";
      ui.host.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
      ui.host.style.top = `${Math.min(maxTop, Math.max(margin, top))}px`;
    }

    function keepVisible() {
      const rect = ui.panel.getBoundingClientRect();
      clampPanel(rect.left, rect.top);
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      clampPanel(
        drag.left + event.clientX - drag.x,
        drag.top + event.clientY - drag.y
      );
    }

    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
    }

    ui.dragHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const rect = ui.panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
      };
      ui.dragHandle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ui.dragHandle.addEventListener("pointermove", onPointerMove);
    ui.dragHandle.addEventListener("pointerup", finishDrag);
    ui.dragHandle.addEventListener("pointercancel", finishDrag);
    ui.dragHandle.addEventListener("lostpointercapture", () => { drag = null; });

    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(keepVisible));
    resizeObserver.observe(ui.panel);
    window.addEventListener("resize", keepVisible);

    ui.collapse.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      ui.panel.classList.toggle("collapsed", state.collapsed);
      ui.collapse.textContent = state.collapsed ? "▾" : "▴";
      ui.collapse.setAttribute("aria-expanded", String(!state.collapsed));
      ui.collapse.title = state.collapsed ? "展开" : "折叠";
      requestAnimationFrame(keepVisible);
    });

    ui.cleanupMotion = () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", keepVisible);
    };
  }

  function createPanel() {
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel { width: min(390px, calc(100vw - 16px)); max-height: min(720px, calc(100vh - 16px)); display: flex; flex-direction: column;
        overflow: hidden; color: #172033; background: #fff; border: 1px solid #d8deea; border-radius: 14px;
        box-shadow: 0 16px 48px rgba(20, 31, 55, .22); font: 13px/1.45 -apple-system, BlinkMacSystemFont,
        "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      .panel.collapsed { width: min(310px, calc(100vw - 16px)); }
      header { display: flex; align-items: center; padding: 0 8px 0 14px;
        color: #fff; background: linear-gradient(135deg, #6f1734, #9b244f); }
      .drag-handle { flex: 1; min-width: 0; padding: 12px 8px 12px 0; cursor: grab; touch-action: none; user-select: none; }
      .drag-handle:active { cursor: grabbing; }
      h2 { margin: 0; font-size: 15px; }
      .header-actions { display: flex; gap: 2px; }
      .header-btn { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 7px; color: #fff;
        background: transparent; cursor: pointer; font-size: 18px; }
      .header-btn:hover, .header-btn:focus-visible { background: rgba(255,255,255,.16); outline: none; }
      .monitor { display: flex; align-items: center; gap: 7px; padding: 7px 14px; color: #596478;
        border-bottom: 1px solid #e6e9ef; background: #fbfcfe; font-size: 11px; }
      .grabbed-count { margin-left: auto; color: #b12626; font-weight: 700; white-space: nowrap; }
      .grabbed-count[hidden] { display: none; }
      .monitor-dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: #8c96a8; }
      .monitor[data-type="running"] .monitor-dot { background: #16a05d; }
      .monitor[data-type="checking"] .monitor-dot { background: #2788d8; animation: pulse 1s infinite; }
      .monitor[data-type="stale"] { color: #b12626; background: #fff0f0; }
      .monitor[data-type="stale"] .monitor-dot { background: #d43636; animation: pulse .8s infinite; }
      @keyframes pulse { 50% { opacity: .28; transform: scale(.72); } }
      .status { padding: 9px 14px; border-bottom: 1px solid #e6e9ef; background: #f7f8fb; }
      .status[data-type="working"] { color: #8a4b00; background: #fff7e6; }
      .status[data-type="error"] { color: #a32020; background: #fff0f0; }
      .controls { display: grid; grid-template-columns: 1fr 105px; gap: 8px; padding: 10px 12px; }
      .controls button, .controls input { min-height: 34px; border: 1px solid #cfd5e0; border-radius: 8px; }
      button { font: inherit; cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .5; }
      .load { color: #6f1734; background: #fff; font-weight: 650; }
      .interval-wrap { display: flex; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid #cfd5e0; border-radius: 8px; }
      .interval-wrap input { width: 60px; min-height: 30px; padding: 0; border: 0; outline: 0; }
      .list { max-height: 250px; overflow: auto; border-top: 1px solid #eef0f4; border-bottom: 1px solid #eef0f4; }
      .empty { padding: 24px 16px; color: #7b8496; text-align: center; }
      .course { display: grid; grid-template-columns: 20px 1fr auto; gap: 8px; align-items: center; padding: 9px 12px;
        border-bottom: 1px solid #eef0f4; cursor: pointer; }
      .course:hover { background: #faf6f8; }
      .course[data-state="success"] { background: #effaf3; }
      .course[data-state="error"] { background: #fff3f3; }
      .course-body { min-width: 0; }
      .course-body strong, .course-body small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .course-body strong { font-size: 13px; }
      .course-body small { margin-top: 2px; color: #727c8f; }
      .badge { color: #687286; font-size: 11px; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px 12px; }
      .start { border: 0; color: #fff; background: #147a45; border-radius: 8px; min-height: 36px; font-weight: 700; }
      .stop { border: 0; color: #fff; background: #b32828; border-radius: 8px; min-height: 36px; font-weight: 700; }
      .log { height: 132px; overflow: auto; padding: 8px 12px; color: #4d576a; background: #f8f9fb;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .log-line.warn { color: #9a5d00; }
      .log-line.error { color: #b12626; }
      .log-line.success { color: #08783c; font-weight: 700; }
      .log-line.course-success { margin: 2px 0; padding: 4px 6px; color: #6f1734; background: #f8eaf0;
        border-left: 3px solid #9b244f; font-weight: 700; }
      .panel.collapsed .status, .panel.collapsed .controls, .panel.collapsed .list,
      .panel.collapsed .log, .panel.collapsed .start { display: none; }
      .panel.collapsed .actions { grid-template-columns: 1fr; padding: 8px 12px; }
    `;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.innerHTML = `
      <header>
        <div class="drag-handle" title="按住拖动"><h2>NJU 补选助手</h2></div>
        <div class="header-actions">
          <button type="button" class="header-btn collapse" title="折叠" aria-label="折叠" aria-expanded="true">▴</button>
          <button type="button" class="header-btn close" title="关闭" aria-label="关闭">×</button>
        </div>
      </header>
      <div class="monitor" data-type="stopped"><span class="monitor-dot"></span><span class="monitor-text">已停止</span><span class="grabbed-count" hidden></span></div>
      <div class="status" role="status" aria-live="polite" data-type="ready">等待读取收藏课程</div>
      <div class="controls">
        <button type="button" class="load">读取收藏</button>
        <label class="interval-wrap"><input class="interval" type="number" min="${MIN_INTERVAL_MS}" step="100" value="${DEFAULT_INTERVAL_MS}">ms</label>
      </div>
      <div class="list"></div>
      <div class="actions"><button type="button" class="start">开始</button><button type="button" class="stop" disabled>停止</button></div>
      <div class="log"></div>
    `;
    shadow.append(style, panel);

    ui = {
      host,
      panel,
      dragHandle: panel.querySelector(".drag-handle"),
      collapse: panel.querySelector(".collapse"),
      close: panel.querySelector(".close"),
      monitor: panel.querySelector(".monitor"),
      monitorText: panel.querySelector(".monitor-text"),
      grabbedCount: panel.querySelector(".grabbed-count"),
      status: panel.querySelector(".status"),
      load: panel.querySelector(".load"),
      interval: panel.querySelector(".interval"),
      list: panel.querySelector(".list"),
      start: panel.querySelector(".start"),
      stop: panel.querySelector(".stop"),
      log: panel.querySelector(".log"),
    };

    ui.close.addEventListener("click", () => {
      stop("面板已关闭");
      clearInterval(state.monitorTimer);
      if (ui.cleanupMotion) ui.cleanupMotion();
      host.remove();
    });
    ui.load.addEventListener("click", loadFavorites);
    ui.interval.addEventListener("blur", normalizeIntervalInput);
    ui.interval.addEventListener("change", normalizeIntervalInput);
    ui.start.addEventListener("click", start);
    ui.stop.addEventListener("click", () => stop());
    setupPanelMotion();
    state.monitorTimer = setInterval(updateRunMonitor, 1000);
    updateRunMonitor();
    renderCourses();
  }

  createPanel();
  waitForPageApi()
    .then(() => log("已连接当前选课页面，可读取收藏课程", "success"))
    .catch((error) => {
      setStatus(error.message, "error");
      log(`${error.message}；请确认位于本科选课平台的课程列表页面`, "error");
    });
})();
