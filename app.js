(() => {
  "use strict";

  // ---------------------------------------------------------------
  // Config — the few numbers you're likely to want to tune later.
  // ---------------------------------------------------------------
  const SKETCH_SECONDS = 30;     // fixed duration per sketch (v1: not user-configurable)
  // Two pens, like having a fine pen and a fat-head sharpie on the table —
  // switchable mid-session, independent of which sketch you're on.
  const PEN_WIDTH_RATIOS = { small: 0.011, big: 0.09 };
  const PDF_COLUMNS = 4;
  const TOOLBAR_THICKNESS = 112; // px — must match the toolbar column/strip size in styles.css
  const OUTER_GUTTER = 24;       // px — breathing room around the square canvas
  const MIN_CANVAS_SIZE = 160;   // px floor, in case a device is very small

  document.getElementById("menu-seconds").textContent = String(SKETCH_SECONDS);

  // ---------------------------------------------------------------
  // View switching
  // ---------------------------------------------------------------
  const views = {
    menu: document.getElementById("view-menu"),
    session: document.getElementById("view-session"),
    done: document.getElementById("view-done"),
  };

  function showView(name) {
    for (const key in views) {
      const isTarget = key === name;
      views[key].classList.toggle("hidden", !isTarget);
      views[key].setAttribute("aria-hidden", String(!isTarget));
    }
  }

  // ---------------------------------------------------------------
  // Canvas + drawing
  // ---------------------------------------------------------------
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d", { desynchronized: true });

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let penWidths = { small: 4, big: 12 }; // recomputed in setupCanvasOnce() once the canvas size is known
  let penSize = "small"; // "small" | "big" — persists across sketches within a session, like picking up a different pen
  let hasInk = false; // has anything been drawn on the CURRENT sketch
  let canvasSetUp = false; // the canvas is sized ONCE per session, never resized after

  // Pick a fixed square size, in CSS px, that will fit comfortably in
  // EITHER orientation (accounting for the toolbar strip(s)) so the
  // canvas never has to be resized again after a rotation. This is the
  // fix for both the "rotation wipes the sketch" and "Pencil calibration
  // drifts after rotating" bugs: the drawing buffer is set up exactly
  // once, right when a session starts, and nothing ever touches it again.
  function computeFixedCanvasSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shortEdge = Math.min(w, h);
    const longEdge = Math.max(w, h);
    // Landscape: one toolbar column eats into the long (horizontal) edge.
    const landscapeFit = Math.min(
      shortEdge - OUTER_GUTTER * 2,
      longEdge - TOOLBAR_THICKNESS - OUTER_GUTTER * 2
    );
    // Portrait: two toolbar strips (top+bottom) eat into the long (vertical) edge.
    const portraitFit = Math.min(
      shortEdge - OUTER_GUTTER * 2,
      longEdge - TOOLBAR_THICKNESS * 2 - OUTER_GUTTER * 2
    );
    return Math.max(MIN_CANVAS_SIZE, Math.min(landscapeFit, portraitFit));
  }

  function setupCanvasOnce() {
    if (canvasSetUp) return;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const size = computeFixedCanvasSize();
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111";
    penWidths = {
      small: Math.max(4, size * PEN_WIDTH_RATIOS.small),
      big: Math.max(30, size * PEN_WIDTH_RATIOS.big),
    };
    ctx.lineWidth = penWidths[penSize];
    clearCanvas();
    canvasSetUp = true;
  }

  function setPenSize(size) {
    if (size !== "small" && size !== "big") return;
    penSize = size;
    ctx.lineWidth = penWidths[penSize];
    document.getElementById("btn-pen-small").classList.toggle("is-active", size === "small");
    document.getElementById("btn-pen-big").classList.toggle("is-active", size === "big");
  }

  function clearCanvas() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    hasInk = false;
  }

  let drawing = false;
  let lastX = 0, lastY = 0;
  let activePointerId = null;

  function pos(evt) {
    const rect = canvas.getBoundingClientRect();
    return [evt.clientX - rect.left, evt.clientY - rect.top];
  }

  function pointerDown(evt) {
    if (sessionState !== "running") return;
    if (activePointerId !== null) return; // ignore extra touches (e.g. palm)
    activePointerId = evt.pointerId;
    drawing = true;
    hasInk = true;
    [lastX, lastY] = pos(evt);
    if (penSize === "chisel") {
      stampChisel(lastX, lastY);
    } else {
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(lastX + 0.01, lastY + 0.01); // ensure a dot renders on a simple tap
      ctx.stroke();
    }
    canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  }

  function pointerMove(evt) {
    if (!drawing || evt.pointerId !== activePointerId) return;
    const [x, y] = pos(evt);
    if (penSize === "chisel") {
      drawChiselSegment(lastX, lastY, x, y);
    } else {
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    lastX = x; lastY = y;
    evt.preventDefault();
  }

  function pointerUp(evt) {
    if (evt.pointerId !== activePointerId) return;
    drawing = false;
    activePointerId = null;
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("pointerleave", pointerUp);
  // Belt-and-suspenders: block iOS gesture scrolling/zoom inside the canvas.
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // Deliberately no resize/orientationchange listener that touches the
  // canvas: the whole point of the fixed-size canvas is that rotating the
  // iPad is a pure CSS reflow (handled by the grid media queries in
  // styles.css) and never rebuilds or clears the drawing buffer.

  // ---------------------------------------------------------------
  // Session state machine
  // ---------------------------------------------------------------
  let sessionState = "idle"; // idle | running | paused | ending
  let sketches = [];         // { dataUrl, index }
  let sketchIndex = 0;
  let timerStart = 0;
  let timerRemainingAtPause = null;
  let rafId = null;

  const progressFill = document.getElementById("progress-fill");
  const counterEl = document.getElementById("sketch-counter");
  const pauseOverlay = document.getElementById("pause-overlay");

  function startSession() {
    sketches = [];
    sketchIndex = 1;
    sessionState = "running";
    canvasSetUp = false; // re-measure fresh for this session, then lock it for its duration
    showView("session");
    // Size the canvas AFTER the view is visible (so innerWidth/innerHeight
    // reflect the current orientation) but only ever once per session.
    requestAnimationFrame(() => {
      setupCanvasOnce();
      counterEl.textContent = String(sketchIndex);
      beginTimer();
    });
  }

  function beginTimer() {
    timerStart = performance.now();
    timerRemainingAtPause = null;
    tick();
  }

  function tick() {
    if (sessionState !== "running") return;
    const elapsed = (performance.now() - timerStart) / 1000;
    const remaining = Math.max(0, SKETCH_SECONDS - elapsed);
    const frac = remaining / SKETCH_SECONDS;
    progressFill.style.transform = `scaleX(${frac})`;
    if (remaining <= 0) {
      advanceSketch();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function captureCurrentSketch() {
    if (!hasInk) return;
    const dataUrl = canvas.toDataURL("image/png");
    sketches.push({ dataUrl, index: sketchIndex });
  }

  function advanceSketch() {
    captureCurrentSketch();
    sketchIndex += 1;
    counterEl.textContent = String(sketchIndex);
    clearCanvas();
    if (sessionState === "running") beginTimer();
  }

  function pauseSession() {
    if (sessionState !== "running") return;
    sessionState = "paused";
    if (rafId) cancelAnimationFrame(rafId);
    timerRemainingAtPause = SKETCH_SECONDS - (performance.now() - timerStart) / 1000;
    pauseOverlay.classList.remove("hidden");
  }

  function resumeSession() {
    if (sessionState !== "paused") return;
    sessionState = "running";
    pauseOverlay.classList.add("hidden");
    const remaining = timerRemainingAtPause == null ? SKETCH_SECONDS : timerRemainingAtPause;
    timerStart = performance.now() - (SKETCH_SECONDS - remaining) * 1000;
    tick();
  }

  // Leaving the app (switching apps, locking the screen, backgrounding the
  // tab) auto-pauses the session instead of letting the timer keep running
  // against the wall clock unseen. Resuming is the same as tapping Resume
  // after a manual Pause — no silent auto-advance, no guessing how much
  // time passed while you were away.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && sessionState === "running") {
      pauseSession();
    }
  });

  function endSession() {
    if (sessionState === "idle") return;
    const wasPaused = sessionState === "paused";
    sessionState = "ending";
    if (rafId) cancelAnimationFrame(rafId);
    pauseOverlay.classList.add("hidden");
    captureCurrentSketch();
    finishAndExport();
  }

  // ---------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------
  document.getElementById("btn-pen-small").addEventListener("click", () => setPenSize("small"));
  document.getElementById("btn-pen-big").addEventListener("click", () => setPenSize("big"));
  document.getElementById("btn-pen-chisel").addEventListener("click", () => setPenSize("chisel"));
  document.getElementById("btn-start").addEventListener("click", startSession);
  document.getElementById("btn-pause").addEventListener("click", pauseSession);
  document.getElementById("btn-resume").addEventListener("click", resumeSession);
  document.getElementById("btn-next").addEventListener("click", () => {
    if (sessionState === "paused") resumeSession();
    if (sessionState === "running") advanceSketch();
  });
  document.getElementById("btn-end").addEventListener("click", endSession);
  document.getElementById("btn-new-session").addEventListener("click", () => {
    sessionState = "idle";
    document.getElementById("btn-export-again").classList.add("hidden");
    showView("menu");
  });

  // ---------------------------------------------------------------
  // PDF export
  // ---------------------------------------------------------------
  const doneCountEl = document.getElementById("done-count");
  const doneStatusEl = document.getElementById("done-status");
  const exportAgainBtn = document.getElementById("btn-export-again");
  let lastSketches = [];

  function finishAndExport() {
    lastSketches = sketches.slice();
    doneCountEl.textContent = String(lastSketches.length);
    showView("done");
    sessionState = "idle";

    if (lastSketches.length === 0) {
      doneStatusEl.textContent = "Nothing was drawn, so there's nothing to export.";
      exportAgainBtn.classList.add("hidden");
      return;
    }

    doneStatusEl.textContent = "Preparing PDF…";
    setTimeout(() => {
      try {
        buildPdf(lastSketches);
        doneStatusEl.textContent = "PDF saved.";
        exportAgainBtn.classList.remove("hidden");
      } catch (err) {
        console.error(err);
        doneStatusEl.textContent = "Could not export automatically — tap below to try again.";
        exportAgainBtn.classList.remove("hidden");
      }
    }, 50);
  }

  exportAgainBtn.addEventListener("click", () => {
    if (lastSketches.length === 0) return;
    try {
      buildPdf(lastSketches);
      doneStatusEl.textContent = "PDF saved.";
    } catch (err) {
      console.error(err);
      doneStatusEl.textContent = "Export failed. Check the console for details.";
    }
  });

  function buildPdf(items) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 36;
    const gap = 14;
    const labelH = 14;
    const cols = PDF_COLUMNS;

    const cellW = (pageW - margin * 2 - gap * (cols - 1)) / cols;
    // Match the on-screen canvas aspect ratio so images aren't distorted.
    const aspect = canvas.height / canvas.width;
    const cellImgH = cellW * aspect;
    const cellH = cellImgH + labelH;
    const rowsPerPage = Math.max(1, Math.floor((pageH - margin * 2) / (cellH + gap)));

    const headerH = 24;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(140, 140, 140);
    const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    doc.text(`Scribble session — ${dateStr} — ${items.length} sketches`, margin, margin - 12);

    items.forEach((item, i) => {
      const posInPage = i % (cols * rowsPerPage);
      const col = posInPage % cols;
      const row = Math.floor(posInPage / cols);

      if (i > 0 && posInPage === 0) {
        doc.addPage();
      }

      const x = margin + col * (cellW + gap);
      const y = margin + headerH * 0 + row * (cellH + gap);

      doc.setDrawColor(225, 220, 205);
      doc.setLineWidth(0.5);
      doc.rect(x, y, cellW, cellImgH);
      doc.addImage(item.dataUrl, "PNG", x, y, cellW, cellImgH, undefined, "FAST");

      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(String(item.index), x, y + cellImgH + 10);
    });

    const stamp = new Date();
    const fname = `scribble-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}.pdf`;
    doc.save(fname);
  }

  // ---------------------------------------------------------------
  // Service worker (best-effort; app still works without it)
  // ---------------------------------------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
