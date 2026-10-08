/* Rootless Voicing Gym — self-contained, no external deps. Web Audio API only. */
(function () {
  "use strict";

  /* ---------------- MUSIC ENGINE (do not improvise) ---------------- */

  // 12 flat-preferred pitch-class names
  var PC_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

  var ROOTS = PC_NAMES.map(function (n, i) { return { name: n, pc: i }; });

  // qualities: LH guide tones (3 & 7), RH color (5 & 9).
  // each tone => { semi, deg }
  var QUALITIES = {
    maj7: {
      symbol: "maj7",
      lh: [{ semi: 4, deg: "3" }, { semi: 11, deg: "7" }],
      rh: [{ semi: 7, deg: "5" }, { semi: 14, deg: "9" }]
    },
    min7: {
      symbol: "min7",
      lh: [{ semi: 3, deg: "b3" }, { semi: 10, deg: "b7" }],
      rh: [{ semi: 7, deg: "5" }, { semi: 14, deg: "9" }]
    },
    dom7: {
      symbol: "7",
      lh: [{ semi: 4, deg: "3" }, { semi: 10, deg: "b7" }],
      rh: [{ semi: 7, deg: "5" }, { semi: 14, deg: "9" }]
    },
    min7b5: {
      symbol: "min7b5",
      lh: [{ semi: 3, deg: "b3" }, { semi: 10, deg: "b7" }],
      rh: [{ semi: 6, deg: "b5" }, { semi: 14, deg: "9" }]
    },
    dom7alt: {
      symbol: "7alt",
      lh: [{ semi: 4, deg: "3" }, { semi: 10, deg: "b7" }],
      rh: [{ semi: 8, deg: "b13" }, { semi: 15, deg: "#9" }]
    }
  };

  var QUALITY_KEYS = ["maj7", "min7", "dom7", "min7b5", "dom7alt"];
  var QUALITY_DISPLAY = {
    maj7: "maj7", min7: "min7", dom7: "7", min7b5: "min7b5", dom7alt: "7alt"
  };

  function pcName(pc) { return PC_NAMES[((pc % 12) + 12) % 12]; }

  // Realize a voicing into MIDI notes.
  // LH placed in 52-63, RH in 64-75 (always strictly above LH). Root one octave below LH (40-51).
  function realize(rootPc, qualityKey) {
    var q = QUALITIES[qualityKey];
    var lhBase = 52; // C3-ish anchor
    function placeInRange(pc, lo, hi) {
      var n = lo + (((pc - (lo % 12)) % 12) + 12) % 12;
      while (n > hi) n -= 12;
      while (n < lo) n += 12;
      return n;
    }
    var lh = q.lh.map(function (t) {
      var pc = (rootPc + t.semi) % 12;
      return { midi: placeInRange(pc, 52, 63), name: pcName(pc), deg: t.deg, pc: pc };
    });
    var rh = q.rh.map(function (t) {
      var pc = (rootPc + t.semi) % 12;
      return { midi: placeInRange(pc, 64, 75), name: pcName(pc), deg: t.deg, pc: pc };
    });
    // root (not played), one octave below LH
    var rootMidi = placeInRange(rootPc, 40, 51);
    return {
      rootPc: rootPc,
      rootName: pcName(rootPc),
      qualityKey: qualityKey,
      symbol: pcName(rootPc) + q.symbol,
      lh: lh,
      rh: rh,
      rootMidi: rootMidi
    };
  }

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /* ---------------- STATE ---------------- */

  var DEFAULTS = {
    mode: "atomic",
    singleQuality: "maj7",
    progressionTemplate: "2-5-1",
    breakConveyor: false,
    enabledQualities: { maj7: true, min7: true, dom7: true, min7b5: true, dom7alt: true },
    autoAdvanceSec: 20,
    autoAdvanceOn: false,
    bpm: 80,
    metOn: false,
    typeAB: false,
    reentries: 0,
    tally: { green: 0, yellow: 0, red: 0 }
  };

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem("rvg_state");
      if (raw) {
        var parsed = JSON.parse(raw);
        return Object.assign({}, DEFAULTS, parsed, {
          enabledQualities: Object.assign({}, DEFAULTS.enabledQualities, parsed.enabledQualities || {}),
          tally: Object.assign({}, DEFAULTS.tally, parsed.tally || {})
        });
      }
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function saveState() {
    try { localStorage.setItem("rvg_state", JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  /* ---------------- CARD GENERATION ---------------- */

  var current = null;          // current voicing
  var lastRootPc = null;       // for conveyor-belt breaking
  var progressionQueue = [];   // for progression mode

  function enabledQualityList() {
    return QUALITY_KEYS.filter(function (k) { return state.enabledQualities[k]; });
  }

  function randInt(n) { return Math.floor(Math.random() * n); }

  function pickRootAvoiding(avoidPc, avoidFifth) {
    var choices = [];
    for (var pc = 0; pc < 12; pc++) {
      if (pc === avoidPc) continue;
      if (avoidFifth && avoidPc !== null) {
        var d = Math.abs(((pc - avoidPc) % 12 + 12) % 12);
        if (d === 5 || d === 7) continue; // perfect 4th / 5th
      }
      choices.push(pc);
    }
    if (choices.length === 0) choices = [0,1,2,3,4,5,6,7,8,9,10,11];
    return choices[randInt(choices.length)];
  }

  // Progression templates: list of {degreeOffset (semitones from key tonic), quality}
  var PROG_TEMPLATES = {
    "1-6-2-5": [
      { off: 0, q: "maj7" }, { off: 9, q: "min7" }, { off: 2, q: "min7" }, { off: 7, q: "dom7" }
    ],
    "2-5-1": [
      { off: 2, q: "min7" }, { off: 7, q: "dom7" }, { off: 0, q: "maj7" }
    ],
    "3-6-2-5-1": [
      { off: 4, q: "min7" }, { off: 9, q: "min7" }, { off: 2, q: "min7" }, { off: 7, q: "dom7" }, { off: 0, q: "maj7" }
    ],
    "minor-ii-V-i": [
      { off: 2, q: "min7b5" }, { off: 7, q: "dom7alt" }, { off: 0, q: "min7" }
    ]
  };

  var neighborLabels = null; // precomputed per card

  function buildProgression() {
    var tmpl = PROG_TEMPLATES[state.progressionTemplate];
    var keyPc = pickRootAvoiding(lastRootPc, state.breakConveyor);
    lastRootPc = keyPc;
    progressionQueue = tmpl.map(function (step) {
      return realize((keyPc + step.off) % 12, step.q);
    });
    progressionQueue._keyPc = keyPc;
    progressionQueue._idx = 0;
  }

  var FUNC_LABELS = ["= vi of F", "= iii of Bb", "= ii of C", "= V of G", "standalone", "= ii of Eb"];

  function nextCard() {
    var mode = state.mode;
    neighborLabels = null;

    if (mode === "progression") {
      if (!progressionQueue.length || progressionQueue._idx >= progressionQueue.length) {
        buildProgression();
      }
      current = progressionQueue[progressionQueue._idx];
      progressionQueue._idx++;
      renderCard();
      return;
    }

    var qualities = enabledQualityList();
    if (qualities.length === 0) qualities = QUALITY_KEYS.slice();

    var quality;
    if (mode === "single") {
      quality = state.singleQuality;
      if (!state.enabledQualities[quality]) quality = qualities[0];
    } else {
      quality = qualities[randInt(qualities.length)];
    }

    var rootPc = pickRootAvoiding(lastRootPc, false);
    lastRootPc = rootPc;
    current = realize(rootPc, quality);

    if (mode === "neighbors") {
      neighborLabels = FUNC_LABELS[randInt(FUNC_LABELS.length)];
    }
    renderCard();
  }

  /* ---------------- RENDER ---------------- */

  var el = {};
  function $(id) { return document.getElementById(id); }

  function renderCard() {
    el.chordSymbol.textContent = current.symbol;
    el.chordContext.textContent = (state.mode === "neighbors" && neighborLabels) ? neighborLabels : "";

    if (state.mode === "progression") {
      var names = progressionQueue.map(function (v) { return v.symbol; });
      el.progLine.textContent =
        "key " + pcName(progressionQueue._keyPc) + " · " +
        state.progressionTemplate + " · (" + progressionQueue._idx + "/" + progressionQueue.length + ") " +
        names.join("  →  ");
    } else {
      el.progLine.textContent = "";
    }

    // hide reveal until pressed
    el.reveal.hidden = true;
    resetProgressBar();
    if (state.autoAdvanceOn) startAutoAdvance();
  }

  function noteItem(n) {
    var d = document.createElement("div");
    d.className = "note-item";
    d.innerHTML = '<span class="name">' + n.name + '</span><span class="deg">' + n.deg + '</span>';
    return d;
  }

  function reveal() {
    if (!current) return;
    el.lhNotes.innerHTML = "";
    el.rhNotes.innerHTML = "";
    current.lh.forEach(function (n) { el.lhNotes.appendChild(noteItem(n)); });
    current.rh.forEach(function (n) { el.rhNotes.appendChild(noteItem(n)); });

    renderPiano();
    renderTypeAB();
    renderRooted();

    el.reveal.hidden = false;
  }

  // Piano from MIDI 40 (E2) to 76 (E5) covering root/LH/RH ranges.
  function renderPiano() {
    var lo = 40, hi = 76;
    var lhSet = {}, rhSet = {};
    current.lh.forEach(function (n) { lhSet[n.midi] = n; });
    current.rh.forEach(function (n) { rhSet[n.midi] = n; });

    el.piano.innerHTML = "";
    // build whites first with blacks overlaid between them
    var blackPc = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
    for (var m = lo; m <= hi; m++) {
      var pc = ((m % 12) + 12) % 12;
      var isBlack = !!blackPc[pc];
      var k = document.createElement("div");
      k.className = "key " + (isBlack ? "black" : "white");
      if (m === current.rootMidi) {
        k.className += " rootkey";
        k.innerHTML = '<span class="klabel">root (not played)</span>';
      } else if (lhSet[m]) {
        k.className += " lh";
        k.innerHTML = '<span class="klabel">' + lhSet[m].name + " " + lhSet[m].deg + '</span>';
      } else if (rhSet[m]) {
        k.className += " rh";
        k.innerHTML = '<span class="klabel">' + rhSet[m].name + " " + rhSet[m].deg + '</span>';
      }
      el.piano.appendChild(k);
    }
  }

  function renderTypeAB() {
    if (!state.typeAB) { el.typeAB.hidden = true; return; }
    var q = QUALITIES[current.qualityKey];
    // degrees in order 3,5,7,9 vs 7,9,3,5
    var byDeg = {};
    q.lh.concat(q.rh).forEach(function (t) { byDeg[t.deg] = pcName((current.rootPc + t.semi) % 12); });
    function label(ds) { return ds.map(function (d) { return byDeg[d] + "(" + d + ")"; }).join(" "); }
    // pick available degree labels per quality
    var third = q.lh[0].deg, seventh = q.lh[1].deg, fifth = q.rh[0].deg, ninth = q.rh[1].deg;
    el.typeAB.hidden = false;
    el.typeAB.innerHTML =
      '<strong>Type A</strong> (3rd lowest): ' + label([third, fifth, seventh, ninth]) +
      '<br><strong>Type B</strong> (7th lowest): ' + label([seventh, ninth, third, fifth]) +
      '<br><em>Primary answer is always the LH 3&amp;7 / RH 5&amp;9 split.</em>';
  }

  function renderRooted() {
    if (state.mode !== "bridge") { el.rootedForm.hidden = true; return; }
    var q = QUALITIES[current.qualityKey];
    var tones = q.lh.concat(q.rh).slice().sort(function (a, b) { return a.semi - b.semi; });
    var stacked = [{ semi: 0, deg: "R" }].concat(tones).map(function (t) {
      return pcName((current.rootPc + t.semi) % 12) + "(" + t.deg + ")";
    }).join(" ");
    el.rootedForm.hidden = false;
    el.rootedForm.innerHTML =
      '<div class="prompt">Play it ROOTED first, then DROP the root and re-voice rootless.</div>' +
      '<div>Rooted (root + 3-5-7-9 stacked): ' + stacked + '</div>';
  }

  /* ---------------- AUDIO (Web Audio API) ---------------- */

  var audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playTone(freq, start, dur, type, peak) {
    var ac = ctx();
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type || "triangle";
    osc.frequency.value = freq;
    // simple ADSR
    var a = 0.01, d = 0.08, s = (peak || 0.2) * 0.6, r = 0.15;
    var p = peak || 0.2;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(p, start + a);
    gain.gain.linearRampToValueAtTime(s, start + a + d);
    gain.gain.setValueAtTime(s, start + dur);
    gain.gain.linearRampToValueAtTime(0, start + dur + r);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur + r + 0.02);
  }

  function hearVoicing() {
    if (!current) return;
    var ac = ctx();
    var t = ac.currentTime + 0.03;
    var midis = current.lh.concat(current.rh).map(function (n) { return n.midi; });
    midis.forEach(function (m) { playTone(midiToFreq(m), t, 1.0, "triangle", 0.16); });
  }

  function hearHome() {
    if (!current) return;
    var ac = ctx();
    var t = ac.currentTime + 0.03;
    playTone(midiToFreq(current.rootMidi), t, 1.4, "sine", 0.25);
  }

  /* ---------------- METRONOME ---------------- */

  var metTimer = null;
  var nextClickTime = 0;
  var beat = 0;

  function clickAt(time, accent) {
    var ac = ctx();
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(accent ? 0.3 : 0.18, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain).connect(ac.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  function metScheduler() {
    var ac = ctx();
    var spb = 60 / state.bpm;
    while (nextClickTime < ac.currentTime + 0.2) {
      clickAt(nextClickTime, beat % 4 === 0);
      nextClickTime += spb;
      beat++;
    }
  }

  function startMetronome() {
    if (metTimer) return;
    var ac = ctx();
    nextClickTime = ac.currentTime + 0.1;
    beat = 0;
    metTimer = setInterval(metScheduler, 25);
  }

  function stopMetronome() {
    if (metTimer) { clearInterval(metTimer); metTimer = null; }
  }

  /* ---------------- AUTO-ADVANCE ---------------- */

  var advTimer = null;
  var advStart = 0;
  var advRaf = null;

  function resetProgressBar() {
    el.progressBar.style.width = "0%";
    if (advTimer) { clearTimeout(advTimer); advTimer = null; }
    if (advRaf) { cancelAnimationFrame(advRaf); advRaf = null; }
  }

  function startAutoAdvance() {
    resetProgressBar();
    var dur = state.autoAdvanceSec * 1000;
    advStart = performance.now();
    function tick(now) {
      var pct = Math.min(100, ((now - advStart) / dur) * 100);
      el.progressBar.style.width = pct + "%";
      if (pct < 100) advRaf = requestAnimationFrame(tick);
    }
    advRaf = requestAnimationFrame(tick);
    advTimer = setTimeout(function () { nextCard(); }, dur);
  }

  /* ---------------- RATING / COUNTERS ---------------- */

  function rate(kind) {
    state.tally[kind]++;
    state.reentries++;
    saveState();
    renderCounters();
    nextCard();
  }

  function renderCounters() {
    el.reentryCount.textContent = state.reentries;
    el.tallyGreen.textContent = state.tally.green;
    el.tallyYellow.textContent = state.tally.yellow;
    el.tallyRed.textContent = state.tally.red;
  }

  function resetSession() {
    state.reentries = 0;
    state.tally = { green: 0, yellow: 0, red: 0 };
    saveState();
    renderCounters();
  }

  /* ---------------- MODE / SETTINGS UI ---------------- */

  var MODE_DESC = {
    atomic: "Random root + random enabled quality. The core decoupler.",
    single: "Lock to one quality, random roots.",
    bridge: "Shows the rooted form alongside — play rooted first, then drop the root.",
    neighbors: "Chord plus a random functional label to break the 'ii-of-X' association.",
    progression: "True-random key each cycle; one chord at a time; cold re-entry."
  };

  function setMode(mode) {
    state.mode = mode;
    Array.prototype.forEach.call(el.modeTabs.querySelectorAll(".mode-tab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    el.modeDesc.textContent = MODE_DESC[mode];
    el.singleQualityBlock.hidden = (mode !== "single");
    el.progressionBlock.hidden = (mode !== "progression");
    progressionQueue = [];
    saveState();
    nextCard();
  }

  function buildQualityChecks() {
    el.qualityChecks.innerHTML = "";
    QUALITY_KEYS.forEach(function (k) {
      var lbl = document.createElement("label");
      lbl.className = "chk";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.enabledQualities[k];
      cb.addEventListener("change", function () {
        state.enabledQualities[k] = cb.checked;
        saveState();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + QUALITY_DISPLAY[k]));
      el.qualityChecks.appendChild(lbl);
    });
  }

  function buildSingleQualitySelect() {
    el.singleQualitySelect.innerHTML = "";
    QUALITY_KEYS.forEach(function (k) {
      var o = document.createElement("option");
      o.value = k;
      o.textContent = QUALITY_DISPLAY[k];
      el.singleQualitySelect.appendChild(o);
    });
    el.singleQualitySelect.value = state.singleQuality;
  }

  /* ---------------- KEYBOARD SHORTCUTS ---------------- */

  function isTextTarget(t) {
    var tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "select" || tag === "textarea" || t.isContentEditable;
  }

  function onKey(e) {
    if (isTextTarget(e.target)) return;
    switch (e.key) {
      case " ": e.preventDefault(); nextCard(); break;
      case "r": case "R": reveal(); break;
      case "h": case "H": hearVoicing(); break;
      case "g": case "G": hearHome(); break;
      case "m": case "M": toggleMetronome(); break;
      case "1": rate("green"); break;
      case "2": rate("yellow"); break;
      case "3": rate("red"); break;
      default: break;
    }
  }

  function toggleMetronome() {
    state.metOn = !state.metOn;
    el.metOn.checked = state.metOn;
    if (state.metOn) startMetronome(); else stopMetronome();
    saveState();
  }

  /* ---------------- INIT ---------------- */

  function cacheEls() {
    el.modeTabs = $("modeTabs");
    el.modeDesc = $("modeDesc");
    el.singleQualityBlock = $("singleQualityBlock");
    el.singleQualitySelect = $("singleQualitySelect");
    el.progressionBlock = $("progressionBlock");
    el.progressionSelect = $("progressionSelect");
    el.breakConveyor = $("breakConveyor");
    el.qualityChecks = $("qualityChecks");
    el.autoAdvance = $("autoAdvance");
    el.autoAdvanceLabel = $("autoAdvanceLabel");
    el.autoAdvanceOn = $("autoAdvanceOn");
    el.metOn = $("metOn");
    el.bpm = $("bpm");
    el.bpmLabel = $("bpmLabel");
    el.typeABToggle = $("typeABToggle");
    el.progressBar = $("progressBar");
    el.reentryCount = $("reentryCount");
    el.chordSymbol = $("chordSymbol");
    el.chordContext = $("chordContext");
    el.progLine = $("progLine");
    el.reveal = $("reveal");
    el.lhNotes = $("lhNotes");
    el.rhNotes = $("rhNotes");
    el.piano = $("piano");
    el.typeAB = $("typeAB");
    el.rootedForm = $("rootedForm");
    el.nextBtn = $("nextBtn");
    el.revealBtn = $("revealBtn");
    el.hearBtn = $("hearBtn");
    el.homeBtn = $("homeBtn");
    el.rateGreen = $("rateGreen");
    el.rateYellow = $("rateYellow");
    el.rateRed = $("rateRed");
    el.resetBtn = $("resetBtn");
    el.tallyGreen = $("tallyGreen");
    el.tallyYellow = $("tallyYellow");
    el.tallyRed = $("tallyRed");
  }

  function wireEvents() {
    Array.prototype.forEach.call(el.modeTabs.querySelectorAll(".mode-tab"), function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
    });

    el.singleQualitySelect.addEventListener("change", function () {
      state.singleQuality = el.singleQualitySelect.value;
      saveState();
      if (state.mode === "single") nextCard();
    });

    el.progressionSelect.addEventListener("change", function () {
      state.progressionTemplate = el.progressionSelect.value;
      progressionQueue = [];
      saveState();
      if (state.mode === "progression") nextCard();
    });

    el.breakConveyor.addEventListener("change", function () {
      state.breakConveyor = el.breakConveyor.checked;
      saveState();
    });

    el.autoAdvance.addEventListener("input", function () {
      state.autoAdvanceSec = parseInt(el.autoAdvance.value, 10);
      el.autoAdvanceLabel.textContent = state.autoAdvanceSec + "s";
      saveState();
    });
    el.autoAdvanceOn.addEventListener("change", function () {
      state.autoAdvanceOn = el.autoAdvanceOn.checked;
      saveState();
      if (state.autoAdvanceOn) startAutoAdvance(); else resetProgressBar();
    });

    el.metOn.addEventListener("change", function () {
      state.metOn = el.metOn.checked;
      if (state.metOn) startMetronome(); else stopMetronome();
      saveState();
    });
    el.bpm.addEventListener("input", function () {
      state.bpm = parseInt(el.bpm.value, 10);
      el.bpmLabel.textContent = state.bpm + " BPM";
      saveState();
    });

    el.typeABToggle.addEventListener("change", function () {
      state.typeAB = el.typeABToggle.checked;
      saveState();
      if (!el.reveal.hidden) renderTypeAB();
    });

    el.nextBtn.addEventListener("click", function () { nextCard(); });
    el.revealBtn.addEventListener("click", reveal);
    el.hearBtn.addEventListener("click", hearVoicing);
    el.homeBtn.addEventListener("click", hearHome);
    el.rateGreen.addEventListener("click", function () { rate("green"); });
    el.rateYellow.addEventListener("click", function () { rate("yellow"); });
    el.rateRed.addEventListener("click", function () { rate("red"); });
    el.resetBtn.addEventListener("click", resetSession);

    document.addEventListener("keydown", onKey);
  }

  function syncControlsFromState() {
    el.singleQualitySelect.value = state.singleQuality;
    el.progressionSelect.value = state.progressionTemplate;
    el.breakConveyor.checked = state.breakConveyor;
    el.autoAdvance.value = state.autoAdvanceSec;
    el.autoAdvanceLabel.textContent = state.autoAdvanceSec + "s";
    el.autoAdvanceOn.checked = state.autoAdvanceOn;
    el.metOn.checked = state.metOn;
    el.bpm.value = state.bpm;
    el.bpmLabel.textContent = state.bpm + " BPM";
    el.typeABToggle.checked = state.typeAB;
  }

  function init() {
    cacheEls();
    buildQualityChecks();
    buildSingleQualitySelect();
    syncControlsFromState();
    wireEvents();
    renderCounters();
    setMode(state.mode);
    if (state.metOn) { el.metOn.checked = true; /* audio starts on first user gesture */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
